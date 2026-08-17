-- Self-verifying assertions for base migrations 001-006. Every check raises an
-- exception on unexpected behavior, so `psql -v ON_ERROR_STOP=1` exits non-zero on
-- any regression. All checks run as the authenticated (or service_role) role so RLS
-- is enforced exactly as in Supabase.

set role authenticated;

-- [1] 005/006: no RLS recursion; a member can read their org + memberships.
do $$
declare tid uuid; orgs int; mships int;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001', true);
  select current_therapist_id() into tid;
  if tid <> 'aaaaaaaa-0000-0000-0000-00000000aaaa' then
    raise exception 'FAIL[identity]: current_therapist_id=% (expected A)', tid;
  end if;
  select count(*) into orgs from organizations;                 -- would recurse pre-006
  select count(*) into mships from organization_memberships;    -- would recurse pre-006
  if orgs < 1 or mships < 1 then
    raise exception 'FAIL[member-read]: owner sees % orgs / % memberships', orgs, mships;
  end if;
  raise notice 'PASS[1]: no recursion; member reads org (%) + memberships (%)', orgs, mships;
end $$;

-- [2] Tenant isolation: an outsider (no membership) sees nothing.
do $$
declare o int; c int; m int;
begin
  perform set_config('request.jwt.claim.sub','99999999-9999-9999-9999-999999999999', true);
  select count(*) into o from organizations;
  select count(*) into c from clients;
  select count(*) into m from organization_memberships;
  if o <> 0 or c <> 0 or m <> 0 then
    raise exception 'FAIL[isolation]: outsider sees % orgs / % clients / % memberships', o, c, m;
  end if;
  raise notice 'PASS[2]: outsider sees nothing';
end $$;

-- [3] Cross-org isolation: therapist B (Org B) cannot see Org A clients.
do $$
declare c int;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002', true);
  select count(*) into c from clients where organization_id='20000000-0000-0000-0000-000000000001';
  if c <> 0 then raise exception 'FAIL[cross-org]: B sees % Org A clients', c; end if;
  raise notice 'PASS[3]: cross-org client isolation holds';
end $$;

-- [4] 002: can_edit_client — primary therapist can update own client; unrelated cannot.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003', true); -- C, primary of clientC
  update clients set first_name='Renamed' where id='30000000-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL[edit-own]: primary therapist updated % rows (expected 1)', n; end if;

  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005', true); -- E, unrelated
  update clients set first_name='Nope' where id='30000000-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL[edit-unrelated]: unrelated therapist updated % rows (expected 0)', n; end if;
  raise notice 'PASS[4]: 002 can_edit_client scoping';
end $$;

-- [5] 002: can_manage_client_access — owner can grant; a plain therapist cannot.
do $$
declare denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001', true); -- owner A
  begin
    insert into client_access (organization_id, client_id, therapist_id, permission)
      values ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-00000000eeee','viewer');
  exception when others then raise exception 'FAIL[grant-owner]: owner could not grant access: %', sqlerrm;
  end;

  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003', true); -- therapist C (not owner/admin/primary of clientA)
  begin
    insert into client_access (organization_id, client_id, therapist_id, permission)
      values ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-00000000cccc','editor');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL[grant-therapist]: non-manager granted access'; end if;
  raise notice 'PASS[5]: 002 can_manage_client_access scoping';
end $$;

-- [6] 003: email queue enqueue authz (requested_by must be self + org member).
do $$
declare denied boolean;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003', true); -- C
  begin
    insert into email_delivery_jobs (id, organization_id, note_id, requested_by_therapist_id, destination_email)
      values ('0f000000-0000-0000-0000-000000000f01','20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-00000000cccc','p@x');
  exception when others then raise exception 'FAIL[enqueue]: member could not enqueue own job: %', sqlerrm;
  end;

  denied := false;
  begin
    insert into email_delivery_jobs (organization_id, note_id, requested_by_therapist_id, destination_email)
      values ('20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000aaaa','p@x'); -- spoof requester
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL[enqueue-spoof]: enqueued as another therapist'; end if;

  perform set_config('request.jwt.claim.sub','99999999-9999-9999-9999-999999999999', true); -- outsider
  denied := false;
  begin
    insert into email_delivery_jobs (organization_id, note_id, requested_by_therapist_id, destination_email)
      values ('20000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-00000000cccc','p@x');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL[enqueue-outsider]: outsider enqueued a job'; end if;
  raise notice 'PASS[6]: 003 enqueue authorization';
end $$;

-- [7] 004: email job update authz (can_manage_email_delivery_job) + immutability trigger.
do $$
declare n int; blocked boolean := false;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003', true); -- requester C
  update email_delivery_jobs set status='processing' where id='0f000000-0000-0000-0000-000000000f01';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL[job-update-owner]: requester updated % rows (expected 1)', n; end if;

  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005', true); -- E (not requester/admin)
  update email_delivery_jobs set status='queued' where id='0f000000-0000-0000-0000-000000000f01';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL[job-update-unrelated]: unrelated updated % rows (expected 0)', n; end if;

  -- immutability trigger blocks changing identity columns (as requester C)
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003', true);
  begin
    update email_delivery_jobs set destination_email='changed@x' where id='0f000000-0000-0000-0000-000000000f01';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'FAIL[job-immutable]: destination_email change was allowed'; end if;
  raise notice 'PASS[7]: 004 job update authz + immutability';
end $$;

-- [8] 001: retention delete guard blocks deletion inside the retention window.
do $$
declare denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001', true); -- owner A
  begin delete from soap_notes where id='40000000-0000-0000-0000-000000000001';
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL[retention]: early note deletion was allowed'; end if;
  raise notice 'PASS[8]: retention delete guard';
end $$;

-- [9] 001: 10-year retention default + generated full-text tsvector.
do $$
declare ret boolean; ft boolean;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001', true);
  select (retention_until between now() + interval '9 years' and now() + interval '10 years 1 day'),
         (search_document @@ to_tsquery('english','tightness & drives'))
    into ret, ft from soap_notes where id='40000000-0000-0000-0000-000000000001';
  if not ret then raise exception 'FAIL[retention-default]: retention_until not ~10 years'; end if;
  if not ft then raise exception 'FAIL[fulltext]: tsvector did not match'; end if;
  raise notice 'PASS[9]: 10-year retention default + full-text search';
end $$;

-- [11] 007: a non-admin therapist can create a client via INSERT ... RETURNING and see it.
do $$
declare v_id uuid; n int;
begin
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003', true); -- therapist C
  begin
    insert into clients (organization_id, primary_therapist_id, created_by_therapist_id, first_name, last_name, email)
      values ('20000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-00000000cccc','cccccccc-0000-0000-0000-00000000cccc','New','ByC','nbyc@x')
      returning id into v_id;
  exception when others then
    raise exception 'FAIL[create-client]: therapist could not create client via insert..returning: %', sqlerrm;
  end;
  select count(*) into n from clients where id = v_id;
  if n <> 1 then raise exception 'FAIL[create-client-visible]: creator cannot see the new client'; end if;
  raise notice 'PASS[11]: 007 therapist creates + sees own client (insert..returning)';
end $$;

reset role;

-- [10] 005: RLS helper functions are SECURITY DEFINER (prevents recursion).
do $$
declare missing text;
begin
  select string_agg(proname, ', ') into missing
  from pg_proc
  where proname in ('current_therapist_id','has_org_role','can_access_client','is_org_member',
                    'can_manage_client_access','can_edit_client','can_manage_email_delivery_job')
    and not prosecdef;
  if missing is not null then
    raise exception 'FAIL[secdef]: these helpers are not SECURITY DEFINER: %', missing;
  end if;
  raise notice 'PASS[10]: all RLS helper functions are SECURITY DEFINER';
end $$;
