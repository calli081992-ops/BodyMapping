-- TEST-ONLY grants. Supabase grants the authenticated role table/sequence access
-- automatically (RLS then restricts rows). We replicate that for local testing.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- service_role (used by the email-queue worker) has full table access in Supabase.
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
