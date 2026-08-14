-- 002_access_policy_hardening.sql
--
-- Hardens the access model established in 001:
--
-- 1. Close the client_access self-grant loophole. In 001 any authenticated
--    therapist could insert their own `editor` client_access row for ANY client
--    in their organization. Because clients_view_policy grants visibility to
--    anyone holding a client_access row, that let every therapist self-grant
--    access to every client, defeating per-client sharing. After this migration a
--    therapist may only self-grant access to a client they created or are the
--    primary therapist for; broader grants require an owner/admin.
--
-- 2. Prevent cross-tenant / cross-client record moves via UPDATE. RLS WITH CHECK
--    cannot compare OLD vs NEW, so a multi-org user with the right memberships
--    could otherwise re-parent a client or note into another organization. These
--    BEFORE UPDATE triggers make the tenant/ownership keys immutable.

-- ---- 1. Hardened client_access insert policy ----
-- SECURITY DEFINER so the ownership lookup bypasses RLS on `clients`; otherwise the
-- policy could not confirm a therapist owns a client they cannot yet see (they have
-- no client_access row at grant time), which is the exact case we want to allow.
create or replace function therapist_owns_client(target_org uuid, target_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from clients c
    where c.id = target_client
      and c.organization_id = target_org
      and (
        c.created_by_therapist_id = current_therapist_id()
        or c.primary_therapist_id = current_therapist_id()
      )
  );
$$;

drop policy if exists client_access_insert_policy on client_access;
create policy client_access_insert_policy
on client_access
for insert
to authenticated
with check (
  has_org_role(client_access.organization_id, array['owner', 'admin']::membership_role[])
  or (
    client_access.therapist_id = current_therapist_id()
    and client_access.permission in ('viewer', 'editor')
    and therapist_owns_client(client_access.organization_id, client_access.client_id)
  )
);

-- ---- 2. Immutable tenant/ownership keys ----
create or replace function enforce_client_tenant_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id then
    raise exception 'organization_id is immutable for clients (attempted % -> %)',
      old.organization_id, new.organization_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clients_tenant_immutable on clients;
create trigger trg_clients_tenant_immutable
before update on clients
for each row
execute function enforce_client_tenant_immutable();

create or replace function enforce_soap_note_tenant_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id or new.client_id <> old.client_id then
    raise exception 'organization_id and client_id are immutable for soap_notes';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_soap_notes_tenant_immutable on soap_notes;
create trigger trg_soap_notes_tenant_immutable
before update on soap_notes
for each row
execute function enforce_soap_note_tenant_immutable();
