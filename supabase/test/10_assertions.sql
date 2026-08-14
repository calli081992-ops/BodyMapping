-- Self-verifying assertions for migrations 001-003. Every check raises an exception
-- on unexpected behavior, so `psql -v ON_ERROR_STOP=1` exits non-zero on any failure.
-- All checks run as the `authenticated` role so RLS is enforced exactly as in Supabase.

set role authenticated;

-- [1] No RLS recursion; helper + owner client visibility work.
do $$
declare tid uuid; n int;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  select current_therapist_id() into tid;            -- recursion would raise "stack depth limit exceeded"
  if tid <> 'aaaaaaaa-0000-0000-0000-00000000aaaa' then
    raise exception 'FAIL[identity]: current_therapist_id=% (expected A)', tid;
  end if;
  select count(*) into n from clients;               -- owner A sees Org A clients
  if n < 1 then raise exception 'FAIL[select]: owner A sees % clients (expected >=1)', n; end if;
  raise notice 'PASS[1]: no RLS recursion; helpers + clients select work';
end $$;

-- [2] Tenant isolation: therapist B (Org B) sees none of Org A's data.
do $$
declare c int; s int;
begin
  perform set_config('request.jwt.claim.sub','22222222-2222-2222-2222-222222222222', true);
  select count(*) into c from clients;
  select count(*) into s from soap_notes;
  if c <> 0 or s <> 0 then raise exception 'FAIL[isolation]: B sees % clients / % notes (expected 0/0)', c, s; end if;
  raise notice 'PASS[2]: tenant isolation (cross-org therapist sees nothing)';
end $$;

-- [3] 002: self-grant loophole closed (therapist C cannot grant itself access to A's client).
do $$
declare denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  begin
    insert into client_access (organization_id, client_id, therapist_id, permission)
      values ('0a000000-0000-0000-0000-0000000000aa','0c000000-0000-0000-0000-0000000000c1','cccccccc-0000-0000-0000-00000000cccc','editor');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL[loophole]: C self-granted access to A''s client'; end if;
  raise notice 'PASS[3]: 002 self-grant loophole closed';
end $$;

-- [4] Therapist C cannot see A's client before any grant.
do $$
declare n int;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  select count(*) into n from clients where id='0c000000-0000-0000-0000-0000000000c1';
  if n <> 0 then raise exception 'FAIL[view]: C sees A''s client without a grant'; end if;
  raise notice 'PASS[4]: C cannot see A''s client without access';
end $$;

-- [5] 002: creator may self-grant on a client they own.
do $$
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  begin
    insert into client_access (organization_id, client_id, therapist_id, permission)
      values ('0a000000-0000-0000-0000-0000000000aa','0c000000-0000-0000-0000-0000000000c2','cccccccc-0000-0000-0000-00000000cccc','editor');
  exception when others then raise exception 'FAIL[creator-grant]: creator could not self-grant: %', sqlerrm;
  end;
  raise notice 'PASS[5]: 002 creator may self-grant on own client';
end $$;

-- [6] 003: non-admin therapist can create a client via INSERT ... RETURNING, then grant access.
do $$
declare v_id uuid;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  begin
    insert into clients (organization_id, primary_therapist_id, created_by_therapist_id, first_name, last_name, email)
      values ('0a000000-0000-0000-0000-0000000000aa','cccccccc-0000-0000-0000-00000000cccc','cccccccc-0000-0000-0000-00000000cccc','New','ClientD','ncd@x')
      returning id into v_id;
    insert into client_access (organization_id, client_id, therapist_id, permission)
      values ('0a000000-0000-0000-0000-0000000000aa', v_id, 'cccccccc-0000-0000-0000-00000000cccc','editor');
  exception when others then raise exception 'FAIL[003]: non-admin client creation failed: %', sqlerrm;
  end;
  raise notice 'PASS[6]: 003 non-admin therapist can create a client (insert..returning)';
end $$;

-- [7] Owner/admin may grant client_access to another therapist.
do $$
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  begin
    insert into client_access (organization_id, client_id, therapist_id, permission)
      values ('0a000000-0000-0000-0000-0000000000aa','0c000000-0000-0000-0000-0000000000c1','cccccccc-0000-0000-0000-00000000cccc','viewer');
  exception when others then raise exception 'FAIL[owner-grant]: owner could not grant access: %', sqlerrm;
  end;
  raise notice 'PASS[7]: owner/admin may grant client_access';
end $$;

-- [8] 002: tenant/ownership keys immutable; legitimate field update still allowed.
do $$
declare ok boolean;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);

  ok := false;
  begin update clients set organization_id='0b000000-0000-0000-0000-0000000000bb' where id='0c000000-0000-0000-0000-0000000000c1';
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL[immut-client]: moving client to another org was allowed'; end if;

  ok := false;
  begin update soap_notes set client_id='0c000000-0000-0000-0000-0000000000c2' where id='0d000000-0000-0000-0000-0000000000d1';
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL[immut-note]: re-parenting a note was allowed'; end if;

  begin update soap_notes set pdf_storage_status='stored' where id='0d000000-0000-0000-0000-0000000000d1';
  exception when others then raise exception 'FAIL[note-update]: legit note update blocked: %', sqlerrm; end;

  raise notice 'PASS[8]: tenant keys immutable; legit note update allowed';
end $$;

-- [9] 001: retention delete guard blocks deletion inside the retention window.
do $$
declare denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  begin delete from soap_notes where id='0d000000-0000-0000-0000-0000000000d1';
  exception when others then denied := true; end;
  if not denied then raise exception 'FAIL[retention]: early note deletion was allowed'; end if;
  raise notice 'PASS[9]: retention delete guard blocks early deletion';
end $$;

-- [10] 001: 10-year retention default + generated full-text tsvector.
do $$
declare ret boolean; ft boolean;
begin
  perform set_config('request.jwt.claim.sub','11111111-1111-1111-1111-111111111111', true);
  select (retention_until between now() + interval '9 years' and now() + interval '10 years 1 day'),
         (search_document @@ to_tsquery('english','tightness & drives'))
    into ret, ft
    from soap_notes where id='0d000000-0000-0000-0000-0000000000d1';
  if not ret then raise exception 'FAIL[retention-default]: retention_until is not ~10 years out'; end if;
  if not ft then raise exception 'FAIL[fulltext]: generated tsvector did not match query'; end if;
  raise notice 'PASS[10]: 10-year retention default + full-text search';
end $$;

-- [11] 004: a therapist may enqueue an email delivery job they own.
do $$
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  begin
    insert into email_delivery_jobs (organization_id, note_id, enqueued_by_therapist_id, destination_email)
      values ('0a000000-0000-0000-0000-0000000000aa','0d000000-0000-0000-0000-0000000000d1','cccccccc-0000-0000-0000-00000000cccc','patient@x');
  exception when others then raise exception 'FAIL[enqueue]: therapist could not enqueue own job: %', sqlerrm;
  end;
  raise notice 'PASS[11]: 004 therapist can enqueue an email delivery job';
end $$;

-- [12] 004: cannot enqueue a job attributed to a different therapist.
do $$
declare denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  begin
    insert into email_delivery_jobs (organization_id, note_id, enqueued_by_therapist_id, destination_email)
      values ('0a000000-0000-0000-0000-0000000000aa','0d000000-0000-0000-0000-0000000000d1','aaaaaaaa-0000-0000-0000-00000000aaaa','patient@x');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL[enqueue-spoof]: enqueued a job as another therapist'; end if;
  raise notice 'PASS[12]: 004 cannot enqueue a job as another therapist';
end $$;

-- [13] 004: the claim function is not callable by authenticated users.
do $$
declare denied boolean := false;
begin
  perform set_config('request.jwt.claim.sub','33333333-3333-3333-3333-333333333333', true);
  begin
    perform claim_email_delivery_jobs(10, 'authenticated-should-not-run');
  exception when others then denied := true;
  end;
  if not denied then raise exception 'FAIL[claim-authz]: authenticated could execute claim_email_delivery_jobs'; end if;
  raise notice 'PASS[13]: 004 claim function denied to authenticated role';
end $$;

reset role;

-- [14] 004: the service role (worker) can atomically claim due jobs.
set role service_role;
do $$
declare n int; s email_delivery_status;
begin
  select count(*) into n from claim_email_delivery_jobs(10, 'test-worker');
  if n < 1 then raise exception 'FAIL[claim]: service_role claimed % jobs (expected >=1)', n; end if;
  select status into s from email_delivery_jobs where note_id='0d000000-0000-0000-0000-0000000000d1' limit 1;
  if s <> 'processing' then raise exception 'FAIL[claim-state]: claimed job status is % (expected processing)', s; end if;
  raise notice 'PASS[14]: 004 service_role claims due jobs and marks them processing';
end $$;

reset role;

-- [15] 005: reclaim jobs stuck in 'processing' past the lock timeout, but not
-- recently-locked ones.
set role service_role;
do $$
declare stale_id uuid; recent_id uuid; got_stale int; got_recent int;
begin
  -- the job claimed in [14] is 'processing' with a fresh lock (locked_by='test-worker')
  select id into recent_id from email_delivery_jobs where locked_by='test-worker' and status='processing' limit 1;
  -- simulate a crashed worker: a 'processing' job locked an hour ago
  insert into email_delivery_jobs (organization_id, note_id, enqueued_by_therapist_id, destination_email, status, locked_at, locked_by, attempts)
    values ('0a000000-0000-0000-0000-0000000000aa','0d000000-0000-0000-0000-0000000000d1','cccccccc-0000-0000-0000-00000000cccc','stale@x','processing', now() - interval '1 hour','dead-worker',1)
    returning id into stale_id;

  create temporary table _claimed on commit drop as
    select id from claim_email_delivery_jobs(10, 'recovery-worker', 60);

  select count(*) into got_stale from _claimed where id = stale_id;
  select count(*) into got_recent from _claimed where id = recent_id;
  if got_stale <> 1 then raise exception 'FAIL[stale]: stale processing job was not reclaimed'; end if;
  if got_recent <> 0 then raise exception 'FAIL[stale]: a recently-locked job was wrongly reclaimed'; end if;
  raise notice 'PASS[15]: 005 reclaims stale processing jobs but not recently-locked ones';
end $$;

reset role;
