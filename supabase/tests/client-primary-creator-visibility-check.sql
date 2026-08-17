-- Manual smoke test for client visibility without client_access row.
-- Run after migrations 001-007.

begin;

do $$
declare
  -- Replace placeholders with real IDs.
  v_user_id uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_org_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_therapist_id uuid;
  v_client_id uuid := gen_random_uuid();
  v_visible_count integer;
begin
  if v_user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     or v_org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then
    raise exception 'Replace v_user_id and v_org_id placeholders before running.';
  end if;

  select id into v_therapist_id
  from therapists
  where user_id = v_user_id;

  if v_therapist_id is null then
    raise exception 'No therapist row found for user_id %', v_user_id;
  end if;

  -- Create a client owned/created by therapist.
  insert into clients (
    id,
    organization_id,
    primary_therapist_id,
    created_by_therapist_id,
    first_name,
    last_name,
    email
  )
  values (
    v_client_id,
    v_org_id,
    v_therapist_id,
    v_therapist_id,
    'Visibility',
    'Check',
    'visibility.check@example.com'
  );

  -- Ensure no explicit client_access row exists.
  delete from client_access
  where organization_id = v_org_id
    and client_id = v_client_id
    and therapist_id = v_therapist_id;

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  execute 'set local role authenticated';

  select count(*)
  into v_visible_count
  from clients
  where id = v_client_id
    and organization_id = v_org_id;

  if v_visible_count <> 1 then
    raise exception 'Expected therapist to see owned client without client_access row; got %', v_visible_count;
  end if;
end $$;

rollback;
