-- 007_email_queue_bulk_and_metrics.sql
--
-- Operational helpers for the delivery queue:
--   requeue_dead_email_delivery_jobs(org, limit) -> owner/admin bulk retry of
--     dead/failed jobs; returns how many were requeued.
--   email_queue_global_status_counts()           -> all-org per-status counts for
--     an infrastructure metrics scrape (service role only; aggregate, no PHI).

create or replace function requeue_dead_email_delivery_jobs(p_org uuid, p_limit integer default 500)
returns integer
language plpgsql
volatile
security definer
set search_path = public, auth
as $$
declare
  v_count integer;
begin
  if not has_org_role(p_org, array['owner', 'admin']::membership_role[]) then
    raise exception 'not authorized to requeue jobs for this organization' using errcode = 'insufficient_privilege';
  end if;

  with target as (
    select id
    from email_delivery_jobs
    where organization_id = p_org
      and status in ('dead', 'failed')
    order by updated_at
    limit greatest(p_limit, 1)
    for update skip locked
  )
  update email_delivery_jobs j
  set status = 'pending',
      attempts = 0,
      next_attempt_at = now(),
      locked_at = null,
      locked_by = null,
      last_error = null,
      error_code = null,
      updated_at = now()
  from target
  where j.id = target.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function requeue_dead_email_delivery_jobs(uuid, integer) from public;
grant execute on function requeue_dead_email_delivery_jobs(uuid, integer) to authenticated, service_role;

-- Aggregate counts across all organizations for infra metrics (/metrics scrape).
-- Service role only; returns only status + count (no tenant data or PHI).
create or replace function email_queue_global_status_counts()
returns table (status email_delivery_status, count bigint)
language sql
stable
security definer
set search_path = public, auth
as $$
  select j.status, count(*)
  from email_delivery_jobs j
  group by j.status;
$$;

revoke all on function email_queue_global_status_counts() from public;
grant execute on function email_queue_global_status_counts() to service_role;
