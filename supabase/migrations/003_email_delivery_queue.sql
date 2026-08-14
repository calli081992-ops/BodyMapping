do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_delivery_job_status') then
    create type email_delivery_job_status as enum (
      'queued',
      'processing',
      'retry_pending',
      'succeeded',
      'failed'
    );
  end if;
end $$;

create table if not exists email_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  note_id uuid not null references soap_notes(id) on delete cascade,
  requested_by_therapist_id uuid not null references therapists(id) on delete restrict,
  destination_email text not null,
  status email_delivery_job_status not null default 'queued',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  completed_at timestamptz,
  external_message_id text,
  last_error_code text,
  last_error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_delivery_membership_fk
    foreign key (organization_id, requested_by_therapist_id)
    references organization_memberships (organization_id, therapist_id),
  constraint email_delivery_note_fk
    foreign key (organization_id, note_id)
    references soap_notes (organization_id, id)
);

create index if not exists idx_email_delivery_jobs_sched
  on email_delivery_jobs (status, next_attempt_at, created_at);
create index if not exists idx_email_delivery_jobs_org
  on email_delivery_jobs (organization_id, created_at desc);

alter table email_send_audit
  add column if not exists job_id uuid references email_delivery_jobs(id) on delete set null;
alter table email_send_audit
  add column if not exists attempt_number integer;

create index if not exists idx_email_send_audit_job
  on email_send_audit (job_id, sent_at desc);

drop trigger if exists trg_email_delivery_jobs_updated_at on email_delivery_jobs;
create trigger trg_email_delivery_jobs_updated_at
before update on email_delivery_jobs
for each row
execute function set_row_updated_at();

alter table email_delivery_jobs enable row level security;

create or replace function is_org_member(target_org uuid)
returns boolean
language sql
stable
as $$
  select exists(
    select 1
    from organization_memberships om
    where om.organization_id = target_org
      and om.therapist_id = current_therapist_id()
  );
$$;

drop policy if exists email_delivery_jobs_select_policy on email_delivery_jobs;
create policy email_delivery_jobs_select_policy
on email_delivery_jobs
for select
to authenticated
using (
  requested_by_therapist_id = current_therapist_id()
  or has_org_role(organization_id, array['owner', 'admin']::membership_role[])
);

drop policy if exists email_delivery_jobs_insert_policy on email_delivery_jobs;
create policy email_delivery_jobs_insert_policy
on email_delivery_jobs
for insert
to authenticated
with check (
  requested_by_therapist_id = current_therapist_id()
  and is_org_member(organization_id)
);
