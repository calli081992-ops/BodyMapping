-- 007_client_primary_creator_visibility.sql
--
-- Let a client's creator / primary therapist see the client without a client_access
-- row. Previously clients_view_policy used only can_access_client (owner/admin OR an
-- explicit client_access grant), so a non-admin therapist could not SELECT a client
-- they just created -- which breaks POST /api/clients (insert ... returning) for them,
-- since RETURNING applies the SELECT policy to the just-inserted row.
--
-- The SELECT policy checks the row's OWN columns directly (created_by/primary), which
-- is required for the INSERT ... RETURNING case: a STABLE re-query helper uses the
-- statement-start snapshot and cannot see the row inserted by the same statement.
-- can_access_client is also extended (for existing rows, e.g. SOAP-note access) via a
-- SECURITY DEFINER ownership helper.

create or replace function therapist_owns_client(target_org uuid, target_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.clients c
    where c.id = target_client
      and c.organization_id = target_org
      and (
        c.created_by_therapist_id = current_therapist_id()
        or c.primary_therapist_id = current_therapist_id()
      )
  );
$$;

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
set search_path = public
as $$
  select
    has_org_role(target_org, array['owner', 'admin']::membership_role[])
    or therapist_owns_client(target_org, target_client)
    or exists (
      select 1
      from public.client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
    );
$$;
