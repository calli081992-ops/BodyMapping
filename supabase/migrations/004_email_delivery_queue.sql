-- 004_email_delivery_queue.sql
--
-- Async, retryable Paubox email delivery. Instead of sending inline during the API
-- request, the app enqueues a job; a background worker (running with the Supabase
-- service role) claims due jobs, sends the encrypted PDF, and reschedules failures
-- with exponential backoff until they succeed or exhaust max_attempts (-> 'dead').

do $$
begin
  if not exists (select 1 from pg_type where typname = 'email_delivery_status') then
    create type email_delivery_status as enum ('pending', 'processing', 'sent', 'failed', 'dead');
  end if;
end $$;

create table if not exists email_delivery_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete restrict,
  note_id uuid not null references soap_notes(id) on delete cascade,
  enqueued_by_therapist_id uuid not null references therapists(id) on delete restrict,
  destination_email text not null,
  status email_delivery_status not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts >= 1),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  error_code text,
  external_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_jobs_note_fk
    foreign key (organization_id, note_id)
    references soap_notes (organization_id, id),
  constraint email_jobs_enqueuer_membership_fk
    foreign key (organization_id, enqueued_by_therapist_id)
    references organization_memberships (organization_id, therapist_id)
);

create index if not exists idx_email_jobs_due
  on email_delivery_jobs (next_attempt_at)
  where status = 'pending';
create index if not exists idx_email_jobs_org_created
  on email_delivery_jobs (organization_id, created_at desc);

drop trigger if exists trg_email_jobs_updated_at on email_delivery_jobs;
create trigger trg_email_jobs_updated_at
before update on email_delivery_jobs
for each row
execute function set_row_updated_at();

-- Atomic claim primitive: mark up to p_batch due 'pending' jobs as 'processing' and
-- return them. FOR UPDATE SKIP LOCKED makes it safe to run multiple workers.
create or replace function claim_email_delivery_jobs(p_batch integer default 10, p_worker text default null)
returns setof email_delivery_jobs
language sql
volatile
security definer
set search_path = public, auth
as $$
  with due as (
    select id
    from email_delivery_jobs
    where status = 'pending'
      and next_attempt_at <= now()
    order by next_attempt_at
    for update skip locked
    limit greatest(p_batch, 1)
  )
  update email_delivery_jobs j
  set status = 'processing',
      locked_at = now(),
      locked_by = p_worker,
      attempts = j.attempts + 1,
      updated_at = now()
  from due
  where j.id = due.id
  returning j.*;
$$;

-- Only the service role (the worker) may claim jobs.
revoke all on function claim_email_delivery_jobs(integer, text) from public;
grant execute on function claim_email_delivery_jobs(integer, text) to service_role;

alter table email_delivery_jobs enable row level security;

-- Reporting roles can view their org's delivery jobs (mirrors email_send_audit).
drop policy if exists email_jobs_select_policy on email_delivery_jobs;
create policy email_jobs_select_policy
on email_delivery_jobs
for select
to authenticated
using (
  has_org_role(email_delivery_jobs.organization_id, array['owner', 'admin', 'therapist']::membership_role[])
);

-- A therapist may enqueue jobs they own in an org they belong to. Row processing and
-- status transitions are done by the service role (which bypasses RLS); there is
-- intentionally no UPDATE/DELETE policy for authenticated users.
drop policy if exists email_jobs_insert_policy on email_delivery_jobs;
create policy email_jobs_insert_policy
on email_delivery_jobs
for insert
to authenticated
with check (
  email_delivery_jobs.enqueued_by_therapist_id = current_therapist_id()
  and has_org_role(email_delivery_jobs.organization_id, array['owner', 'admin', 'therapist']::membership_role[])
);
