-- TEST-ONLY seed, inserted as the DB superuser (bypasses RLS), mimicking Supabase
-- admin/service-role provisioning.
--
-- Org A (spa): owner A, therapist C, therapist E.   Org B (solo): owner B.
--   clientA  -> primary/created_by A   (Org A)
--   clientC  -> primary/created_by C   (Org A)
--   noteA    -> A's SOAP note on clientA

insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-000000000001','a@x'),
  ('10000000-0000-0000-0000-000000000002','b@x'),
  ('10000000-0000-0000-0000-000000000003','c@x'),
  ('10000000-0000-0000-0000-000000000005','e@x');

insert into organizations (id, name, account_type) values
  ('20000000-0000-0000-0000-000000000001','Org A','spa'),
  ('20000000-0000-0000-0000-000000000002','Org B','solo');

insert into therapists (id, user_id, display_name, email) values
  ('aaaaaaaa-0000-0000-0000-00000000aaaa','10000000-0000-0000-0000-000000000001','A','a@x'),
  ('bbbbbbbb-0000-0000-0000-00000000bbbb','10000000-0000-0000-0000-000000000002','B','b@x'),
  ('cccccccc-0000-0000-0000-00000000cccc','10000000-0000-0000-0000-000000000003','C','c@x'),
  ('eeeeeeee-0000-0000-0000-00000000eeee','10000000-0000-0000-0000-000000000005','E','e@x');

insert into organization_memberships (organization_id, therapist_id, role) values
  ('20000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000aaaa','owner'),
  ('20000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-00000000cccc','therapist'),
  ('20000000-0000-0000-0000-000000000001','eeeeeeee-0000-0000-0000-00000000eeee','therapist'),
  ('20000000-0000-0000-0000-000000000002','bbbbbbbb-0000-0000-0000-00000000bbbb','owner');

insert into clients (id, organization_id, primary_therapist_id, created_by_therapist_id, first_name, last_name, email) values
  ('30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000aaaa','aaaaaaaa-0000-0000-0000-00000000aaaa','Owned','ByA','oa@x'),
  ('30000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-00000000cccc','cccccccc-0000-0000-0000-00000000cccc','Owned','ByC','oc@x');

-- Creator/primary therapist gets editor access on their client (as the app grants on
-- client creation). Base's clients SELECT policy requires a client_access row (or
-- owner/admin) to see a client.
insert into client_access (organization_id, client_id, therapist_id, permission) values
  ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000aaaa','editor'),
  ('20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-00000000cccc','editor');

insert into soap_notes (id, organization_id, client_id, therapist_id, subjective, objective, assessment, plan) values
  ('40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-00000000aaaa',
   'Lower-back tightness after long drives','Hypertonicity right QL','Postural strain','Weekly deep-tissue x3');
