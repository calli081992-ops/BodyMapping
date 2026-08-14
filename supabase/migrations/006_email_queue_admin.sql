-- 006_email_queue_admin.sql
--
-- Admin controls for the delivery queue, exposed as SECURITY DEFINER functions with
-- owner/admin authorization. This preserves the 004 invariant that authenticated
-- users have no direct UPDATE on email_delivery_jobs.
--
--   requeue_email_delivery_job(job_id)  -> reset a dead/failed job back to pending
--   email_queue_status_counts(org)      -> per-status job counts for dashboards/alerts

create or replace function requeue_email_delivery_job(p_job_id uuid)
returns email_delivery_jobs
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_job email_delivery_jobs;
begin
  select * into v_job from email_delivery_jobs where id = p_job_id;
  if not found then
    raise exception 'email delivery job % not found', p_job_id using errcode = 'no_data_found';
  end if;

  if not has_org_role(v_job.organization_id, array['owner', 'admin']::membership_role[]) then
    raise exception 'not authorized to requeue this job' using errcode = 'insufficient_privilege';
  end if;

  if v_job.status not in ('dead', 'failed') then
    raise exception 'only dead or failed jobs can be requeued (status = %)', v_job.status
      using errcode = 'invalid_parameter_value';
  end if;

  update email_delivery_jobs
  set status = 'pending',
      attempts = 0,
      next_attempt_at = now(),
      locked_at = null,
      locked_by = null,
      last_error = null,
      error_code = null,
      updated_at = now()
  where id = p_job_id
  returning * into v_job;

  return v_job;
end;
$$;

revoke all on function requeue_email_delivery_job(uuid) from public;
grant execute on function requeue_email_delivery_job(uuid) to authenticated, service_role;

-- Per-status counts for a caller who is owner/admin of the org (empty otherwise).
create or replace function email_queue_status_counts(p_org uuid)
returns table (status email_delivery_status, count bigint)
language sql
stable
security definer
set search_path = public, auth
as $$
  select j.status, count(*)
  from email_delivery_jobs j
  where j.organization_id = p_org
    and has_org_role(p_org, array['owner', 'admin']::membership_role[])
  group by j.status;
$$;

revoke all on function email_queue_status_counts(uuid) from public;
grant execute on function email_queue_status_counts(uuid) to authenticated, service_role;
