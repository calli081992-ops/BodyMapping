create or replace function current_therapist_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.id
  from public.therapists t
  where t.user_id = auth.uid()
  limit 1;
$$;

create or replace function has_org_role(target_org uuid, allowed_roles membership_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.organization_memberships om
    where om.organization_id = target_org
      and om.therapist_id = current_therapist_id()
      and om.role = any(allowed_roles)
  );
$$;

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
      from public.client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
    );
$$;

create or replace function is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.organization_memberships om
    where om.organization_id = target_org
      and om.therapist_id = current_therapist_id()
  );
$$;

create or replace function can_manage_client_access(target_org uuid, target_client uuid)
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
        and c.primary_therapist_id = current_therapist_id()
    );
$$;

create or replace function can_edit_client(target_org uuid, target_client uuid)
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
        and c.primary_therapist_id = current_therapist_id()
    )
    or exists (
      select 1
      from public.client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
        and ca.permission = 'editor'
    );
$$;

create or replace function can_manage_email_delivery_job(target_org uuid, requester_therapist uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    requester_therapist = current_therapist_id()
    or has_org_role(target_org, array['owner', 'admin']::membership_role[]);
$$;
