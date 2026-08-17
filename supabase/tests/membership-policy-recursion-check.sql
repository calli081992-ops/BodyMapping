-- Manual smoke test for membership select recursion.
-- Run in Supabase SQL Editor after migrations 001-006.

begin;

-- Replace with real IDs from your environment.
-- user_id: auth.users.id for a seeded therapist member.
-- org_id: organizations.id that user belongs to.
do $$
declare
  v_user_id uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  v_org_id uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  v_visible_count integer;
begin
  if v_user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
     or v_org_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' then
    raise exception 'Replace v_user_id and v_org_id placeholders before running.';
  end if;

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  execute 'set local role authenticated';

  select count(*)
  into v_visible_count
  from organization_memberships
  where organization_id = v_org_id;

  if v_visible_count < 1 then
    raise exception 'Expected at least one visible membership row for org %, got %', v_org_id, v_visible_count;
  end if;
end $$;

rollback;
