create or replace function can_manage_client_access(target_org uuid, target_client uuid)
returns boolean
language sql
stable
as $$
  select
    has_org_role(target_org, array['owner', 'admin']::membership_role[])
    or exists (
      select 1
      from clients c
      where c.organization_id = target_org
        and c.id = target_client
        and c.primary_therapist_id = current_therapist_id()
    );
$$;

create or replace function can_edit_client(target_org uuid, target_client uuid)
returns boolean
language sql
stable
as $$
  select
    has_org_role(target_org, array['owner', 'admin']::membership_role[])
    or exists (
      select 1
      from clients c
      where c.organization_id = target_org
        and c.id = target_client
        and c.primary_therapist_id = current_therapist_id()
    )
    or exists (
      select 1
      from client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
        and ca.permission = 'editor'
    );
$$;

drop policy if exists membership_self_or_admin_select on organization_memberships;
create policy membership_self_or_admin_select
on organization_memberships
for select
to authenticated
using (
  exists (
    select 1
    from organization_memberships current_member
    where current_member.organization_id = organization_memberships.organization_id
      and current_member.therapist_id = current_therapist_id()
  )
);

drop policy if exists clients_update_policy on clients;
create policy clients_update_policy
on clients
for update
to authenticated
using (
  can_edit_client(clients.organization_id, clients.id)
)
with check (
  can_edit_client(clients.organization_id, clients.id)
);

drop policy if exists client_access_manage_policy on client_access;
drop policy if exists client_access_delete_policy on client_access;
drop policy if exists client_access_insert_policy on client_access;
drop policy if exists client_access_view_policy on client_access;

create policy client_access_view_policy
on client_access
for select
to authenticated
using (
  client_access.therapist_id = current_therapist_id()
  or can_manage_client_access(client_access.organization_id, client_access.client_id)
);

create policy client_access_manage_policy
on client_access
for update
to authenticated
using (
  can_manage_client_access(client_access.organization_id, client_access.client_id)
)
with check (
  can_manage_client_access(client_access.organization_id, client_access.client_id)
);

create policy client_access_delete_policy
on client_access
for delete
to authenticated
using (
  can_manage_client_access(client_access.organization_id, client_access.client_id)
);

create policy client_access_insert_policy
on client_access
for insert
to authenticated
with check (
  can_manage_client_access(client_access.organization_id, client_access.client_id)
);
