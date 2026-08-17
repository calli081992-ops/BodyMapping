create or replace function can_manage_email_delivery_job(target_org uuid, requester_therapist uuid)
returns boolean
language sql
stable
as $$
  select
    requester_therapist = current_therapist_id()
    or has_org_role(target_org, array['owner', 'admin']::membership_role[]);
$$;

create or replace function enforce_email_delivery_job_immutables()
returns trigger
language plpgsql
as $$
begin
  if new.organization_id <> old.organization_id then
    raise exception 'organization_id is immutable';
  end if;
  if new.note_id <> old.note_id then
    raise exception 'note_id is immutable';
  end if;
  if new.requested_by_therapist_id <> old.requested_by_therapist_id then
    raise exception 'requested_by_therapist_id is immutable';
  end if;
  if new.destination_email <> old.destination_email then
    raise exception 'destination_email is immutable';
  end if;
  if new.created_at <> old.created_at then
    raise exception 'created_at is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_email_delivery_job_immutables on email_delivery_jobs;
create trigger trg_email_delivery_job_immutables
before update on email_delivery_jobs
for each row
execute function enforce_email_delivery_job_immutables();

drop policy if exists email_delivery_jobs_update_policy on email_delivery_jobs;
create policy email_delivery_jobs_update_policy
on email_delivery_jobs
for update
to authenticated
using (
  can_manage_email_delivery_job(organization_id, requested_by_therapist_id)
)
with check (
  can_manage_email_delivery_job(organization_id, requested_by_therapist_id)
);
