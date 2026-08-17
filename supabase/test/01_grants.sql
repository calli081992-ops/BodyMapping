-- TEST-ONLY grants. Supabase grants the authenticated/service_role roles table
-- access automatically (RLS then restricts rows). We replicate that locally.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
