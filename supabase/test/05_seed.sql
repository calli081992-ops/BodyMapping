-- TEST-ONLY seed, inserted as the test DB superuser (bypasses RLS), mimicking
-- Supabase admin/service-role provisioning of orgs, therapists, and memberships.
--
-- Org A (spa): owner A + regular therapist C.  Org B (solo): owner B.
--   clientA  -> created by / primary A     (Org A)
--   clientC  -> created by / primary C     (Org A)
--   noteA    -> A's SOAP note on clientA   (Org A)

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','a@x'),
  ('22222222-2222-2222-2222-222222222222','b@x'),
  ('33333333-3333-3333-3333-333333333333','c@x');

insert into organizations (id, name, account_type) values
  ('0a000000-0000-0000-0000-0000000000aa','Org A','spa'),
  ('0b000000-0000-0000-0000-0000000000bb','Org B','solo');

insert into therapists (id, user_id, display_name, email) values
  ('aaaaaaaa-0000-0000-0000-00000000aaaa','11111111-1111-1111-1111-111111111111','A','a@x'),
  ('bbbbbbbb-0000-0000-0000-00000000bbbb','22222222-2222-2222-2222-222222222222','B','b@x'),
  ('cccccccc-0000-0000-0000-00000000cccc','33333333-3333-3333-3333-333333333333','C','c@x');

insert into organization_memberships (organization_id, therapist_id, role) values
  ('0a000000-0000-0000-0000-0000000000aa','aaaaaaaa-0000-0000-0000-00000000aaaa','owner'),
  ('0a000000-0000-0000-0000-0000000000aa','cccccccc-0000-0000-0000-00000000cccc','therapist'),
  ('0b000000-0000-0000-0000-0000000000bb','bbbbbbbb-0000-0000-0000-00000000bbbb','owner');

insert into clients (id, organization_id, primary_therapist_id, created_by_therapist_id, first_name, last_name, email) values
  ('0c000000-0000-0000-0000-0000000000c1','0a000000-0000-0000-0000-0000000000aa','aaaaaaaa-0000-0000-0000-00000000aaaa','aaaaaaaa-0000-0000-0000-00000000aaaa','Owned','ByA','oa@x'),
  ('0c000000-0000-0000-0000-0000000000c2','0a000000-0000-0000-0000-0000000000aa','cccccccc-0000-0000-0000-00000000cccc','cccccccc-0000-0000-0000-00000000cccc','Owned','ByC','oc@x');

insert into soap_notes (id, organization_id, client_id, therapist_id, subjective, objective, assessment, plan) values
  ('0d000000-0000-0000-0000-0000000000d1','0a000000-0000-0000-0000-0000000000aa','0c000000-0000-0000-0000-0000000000c1','aaaaaaaa-0000-0000-0000-00000000aaaa',
   'Lower-back tightness after long drives','Hypertonicity right QL','Postural strain','Weekly deep-tissue x3');
