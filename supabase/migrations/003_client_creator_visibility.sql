-- 003_client_creator_visibility.sql
--
-- Fixes a pre-existing gap: a client's creator / primary therapist could not see
-- the client until a client_access row existed for them. Because the app creates a
-- client with `INSERT ... RETURNING` (and only writes client_access afterward), the
-- RETURNING clause tripped the clients SELECT policy (can_access_client) and raised
-- an RLS error for non-owner/admin therapists, so they could not create clients.
--
-- Fix: allow a therapist to view clients they created or are the primary therapist
-- for. The clients SELECT policy checks the row's OWN columns directly, which is
-- important for the INSERT ... RETURNING case: a re-query helper marked STABLE would
-- use the statement-start snapshot and not see the row just inserted by that same
-- statement. can_access_client() is also extended (for existing rows) so ownership
-- grants access to a client's SOAP notes without requiring an explicit client_access
-- row; there the client already exists, so the STABLE lookup is fine.

drop policy if exists clients_view_policy on clients;
create policy clients_view_policy
on clients
for select
to authenticated
using (
  clients.created_by_therapist_id = current_therapist_id()
  or clients.primary_therapist_id = current_therapist_id()
  or can_access_client(clients.organization_id, clients.id)
);

create or replace function can_access_client(target_org uuid, target_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    has_org_role(target_org, array['owner', 'admin']::membership_role[])
    or therapist_owns_client(target_org, target_client)
    or exists (
      select 1
      from client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
    );
$$;
