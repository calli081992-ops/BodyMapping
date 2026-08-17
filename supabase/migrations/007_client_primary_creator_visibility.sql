create or replace function can_access_client(target_org uuid, target_client uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    has_org_role(target_org, array['owner', 'admin']::membership_role[])
    or exists (
      select 1
      from public.clients c
      where c.organization_id = target_org
        and c.id = target_client
        and (
          c.primary_therapist_id = current_therapist_id()
          or c.created_by_therapist_id = current_therapist_id()
        )
    )
    or exists (
      select 1
      from public.client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
    );
$$;
