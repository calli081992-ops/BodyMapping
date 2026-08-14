create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'account_type') then
    create type account_type as enum ('solo', 'spa');
  end if;
  if not exists (select 1 from pg_type where typname = 'membership_role') then
    create type membership_role as enum ('owner', 'admin', 'therapist', 'staff');
  end if;
  if not exists (select 1 from pg_type where typname = 'pdf_storage_status') then
    create type pdf_storage_status as enum ('pending', 'stored', 'failed');
  end if;
  if not exists (select 1 from pg_type where typname = 'email_send_status') then
    create type email_send_status as enum ('success', 'failed');
  end if;
end $$;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type account_type not null,
  created_at timestamptz not null default now()
);

create table if not exists therapists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  display_name text not null,
  email text not null,
  created_at timestamptz not null default now()
);

create table if not exists organization_memberships (
  organization_id uuid not null references organizations(id) on delete cascade,
  therapist_id uuid not null references therapists(id) on delete cascade,
  role membership_role not null default 'therapist',
  created_at timestamptz not null default now(),
  primary key (organization_id, therapist_id)
);

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  primary_therapist_id uuid not null references therapists(id) on delete restrict,
  created_by_therapist_id uuid not null references therapists(id) on delete restrict,
  first_name text not null,
  last_name text not null,
  email text not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (organization_id, id),
  constraint clients_primary_membership_fk
    foreign key (organization_id, primary_therapist_id)
    references organization_memberships (organization_id, therapist_id),
  constraint clients_created_by_membership_fk
    foreign key (organization_id, created_by_therapist_id)
    references organization_memberships (organization_id, therapist_id)
);

create table if not exists client_access (
  organization_id uuid not null references organizations(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  therapist_id uuid not null references therapists(id) on delete cascade,
  permission text not null check (permission in ('viewer', 'editor')),
  created_at timestamptz not null default now(),
  primary key (organization_id, client_id, therapist_id),
  constraint client_access_client_fk
    foreign key (organization_id, client_id)
    references clients (organization_id, id) on delete cascade,
  constraint client_access_membership_fk
    foreign key (organization_id, therapist_id)
    references organization_memberships (organization_id, therapist_id) on delete cascade
);

create table if not exists soap_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  client_id uuid not null references clients(id) on delete restrict,
  therapist_id uuid not null references therapists(id) on delete restrict,
  session_at timestamptz,
  subjective text not null,
  objective text not null,
  assessment text not null,
  plan text not null,
  search_document tsvector generated always as (
    to_tsvector(
      'english',
      coalesce(subjective, '') || ' ' ||
      coalesce(objective, '') || ' ' ||
      coalesce(assessment, '') || ' ' ||
      coalesce(plan, '')
    )
  ) stored,
  retention_until timestamptz not null default (now() + interval '10 years'),
  pdf_storage_status pdf_storage_status not null default 'pending',
  s3_object_key text,
  s3_etag text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  constraint soap_notes_client_fk
    foreign key (organization_id, client_id)
    references clients (organization_id, id),
  constraint soap_notes_therapist_membership_fk
    foreign key (organization_id, therapist_id)
    references organization_memberships (organization_id, therapist_id)
);

create table if not exists email_send_audit (
  id bigint generated always as identity primary key,
  organization_id uuid not null references organizations(id) on delete restrict,
  note_id uuid not null references soap_notes(id) on delete cascade,
  sent_by_therapist_id uuid not null references therapists(id) on delete restrict,
  destination_email text not null,
  status email_send_status not null,
  external_message_id text,
  error_code text,
  sent_at timestamptz not null default now(),
  constraint email_audit_note_fk
    foreign key (organization_id, note_id)
    references soap_notes (organization_id, id),
  constraint email_audit_sender_membership_fk
    foreign key (organization_id, sent_by_therapist_id)
    references organization_memberships (organization_id, therapist_id)
);

create index if not exists idx_clients_org_name
  on clients (organization_id, last_name, first_name);
create index if not exists idx_client_access_therapist
  on client_access (organization_id, therapist_id, client_id);
create index if not exists idx_soap_notes_org_client_session
  on soap_notes (organization_id, client_id, session_at desc nulls last, created_at desc);
create index if not exists idx_soap_notes_search_document
  on soap_notes using gin (search_document);
create index if not exists idx_email_audit_org_sent_at
  on email_send_audit (organization_id, sent_at desc);

create or replace function set_row_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_soap_notes_updated_at on soap_notes;
create trigger trg_soap_notes_updated_at
before update on soap_notes
for each row
execute function set_row_updated_at();

create or replace function prevent_early_soap_note_delete()
returns trigger
language plpgsql
as $$
begin
  if old.retention_until > now() then
    raise exception 'SOAP notes must be retained until %', old.retention_until;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_soap_notes_retention_guard on soap_notes;
create trigger trg_soap_notes_retention_guard
before delete on soap_notes
for each row
execute function prevent_early_soap_note_delete();

-- These helpers query tables (therapists, organization_memberships, client_access)
-- whose own RLS policies call these same helpers. They must run as SECURITY DEFINER
-- so their internal reads bypass RLS (and are not SQL-inlined); otherwise every
-- policy check recurses into itself and fails with "stack depth limit exceeded".
create or replace function current_therapist_id()
returns uuid
language sql
stable
security definer
set search_path = public, auth
as $$
  select t.id
  from therapists t
  where t.user_id = auth.uid()
  limit 1;
$$;

create or replace function has_org_role(target_org uuid, allowed_roles membership_role[])
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists(
    select 1
    from organization_memberships om
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
set search_path = public, auth
as $$
  select
    has_org_role(target_org, array['owner', 'admin']::membership_role[])
    or exists (
      select 1
      from client_access ca
      where ca.organization_id = target_org
        and ca.client_id = target_client
        and ca.therapist_id = current_therapist_id()
    );
$$;

alter table organizations enable row level security;
alter table therapists enable row level security;
alter table organization_memberships enable row level security;
alter table clients enable row level security;
alter table client_access enable row level security;
alter table soap_notes enable row level security;
alter table email_send_audit enable row level security;

drop policy if exists organizations_member_select on organizations;
create policy organizations_member_select
on organizations
for select
to authenticated
using (
  exists (
    select 1
    from organization_memberships om
    where om.organization_id = organizations.id
      and om.therapist_id = current_therapist_id()
  )
);

drop policy if exists therapists_self_or_org_select on therapists;
create policy therapists_self_or_org_select
on therapists
for select
to authenticated
using (
  therapists.user_id = auth.uid()
  or exists (
    select 1
    from organization_memberships me
    join organization_memberships them
      on them.organization_id = me.organization_id
    where me.therapist_id = current_therapist_id()
      and them.therapist_id = therapists.id
  )
);

drop policy if exists therapists_self_insert on therapists;
create policy therapists_self_insert
on therapists
for insert
to authenticated
with check (therapists.user_id = auth.uid());

drop policy if exists membership_self_or_admin_select on organization_memberships;
create policy membership_self_or_admin_select
on organization_memberships
for select
to authenticated
using (
  organization_memberships.therapist_id = current_therapist_id()
  or has_org_role(organization_memberships.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists membership_admin_manage on organization_memberships;
create policy membership_admin_manage
on organization_memberships
for all
to authenticated
using (has_org_role(organization_memberships.organization_id, array['owner', 'admin']::membership_role[]))
with check (has_org_role(organization_memberships.organization_id, array['owner', 'admin']::membership_role[]));

drop policy if exists clients_view_policy on clients;
create policy clients_view_policy
on clients
for select
to authenticated
using (
  can_access_client(clients.organization_id, clients.id)
);

drop policy if exists clients_insert_policy on clients;
create policy clients_insert_policy
on clients
for insert
to authenticated
with check (
  clients.created_by_therapist_id = current_therapist_id()
  and (
    clients.primary_therapist_id = current_therapist_id()
    or has_org_role(clients.organization_id, array['owner', 'admin']::membership_role[])
  )
);

drop policy if exists clients_update_policy on clients;
create policy clients_update_policy
on clients
for update
to authenticated
using (
  can_access_client(clients.organization_id, clients.id)
)
with check (
  can_access_client(clients.organization_id, clients.id)
);

drop policy if exists client_access_view_policy on client_access;
create policy client_access_view_policy
on client_access
for select
to authenticated
using (
  client_access.therapist_id = current_therapist_id()
  or has_org_role(client_access.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists client_access_manage_policy on client_access;
create policy client_access_manage_policy
on client_access
for update
to authenticated
using (
  has_org_role(client_access.organization_id, array['owner', 'admin']::membership_role[])
)
with check (
  has_org_role(client_access.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists client_access_delete_policy on client_access;
create policy client_access_delete_policy
on client_access
for delete
to authenticated
using (
  has_org_role(client_access.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists client_access_insert_policy on client_access;
create policy client_access_insert_policy
on client_access
for insert
to authenticated
with check (
  (
    client_access.therapist_id = current_therapist_id()
    and client_access.permission = 'editor'
  )
  or has_org_role(client_access.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists soap_notes_select_policy on soap_notes;
create policy soap_notes_select_policy
on soap_notes
for select
to authenticated
using (
  can_access_client(soap_notes.organization_id, soap_notes.client_id)
);

drop policy if exists soap_notes_insert_policy on soap_notes;
create policy soap_notes_insert_policy
on soap_notes
for insert
to authenticated
with check (
  soap_notes.therapist_id = current_therapist_id()
  and can_access_client(soap_notes.organization_id, soap_notes.client_id)
);

drop policy if exists soap_notes_update_policy on soap_notes;
create policy soap_notes_update_policy
on soap_notes
for update
to authenticated
using (
  soap_notes.therapist_id = current_therapist_id()
  or has_org_role(soap_notes.organization_id, array['owner', 'admin']::membership_role[])
)
with check (
  soap_notes.therapist_id = current_therapist_id()
  or has_org_role(soap_notes.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists soap_notes_delete_policy on soap_notes;
create policy soap_notes_delete_policy
on soap_notes
for delete
to authenticated
using (
  has_org_role(soap_notes.organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists email_audit_view_policy on email_send_audit;
create policy email_audit_view_policy
on email_send_audit
for select
to authenticated
using (
  has_org_role(email_send_audit.organization_id, array['owner', 'admin', 'therapist']::membership_role[])
);

drop policy if exists email_audit_insert_policy on email_send_audit;
create policy email_audit_insert_policy
on email_send_audit
for insert
to authenticated
with check (
  email_send_audit.sent_by_therapist_id = current_therapist_id()
  and (
    has_org_role(email_send_audit.organization_id, array['owner', 'admin', 'therapist']::membership_role[])
  )
);
