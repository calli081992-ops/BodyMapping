-- 005_email_queue_stale_lock_recovery.sql
--
-- If a worker crashes mid-send, its job is left in 'processing' with a stale
-- locked_at and would never be retried. This redefines the claim primitive to also
-- pick up 'processing' jobs whose lock is older than a visibility timeout
-- (p_lock_timeout_seconds), so a healthy worker recovers them.

-- Replace the 2-arg claim function with a 3-arg version (adds the lock timeout).
drop function if exists claim_email_delivery_jobs(integer, text);

create or replace function claim_email_delivery_jobs(
  p_batch integer default 10,
  p_worker text default null,
  p_lock_timeout_seconds integer default 300
)
returns setof email_delivery_jobs
language sql
volatile
security definer
set search_path = public, auth
as $$
  with due as (
    select id
    from email_delivery_jobs
    where (status = 'pending' and next_attempt_at <= now())
       or (
         status = 'processing'
         and locked_at is not null
         and locked_at < now() - make_interval(secs => greatest(p_lock_timeout_seconds, 1))
       )
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

revoke all on function claim_email_delivery_jobs(integer, text, integer) from public;
grant execute on function claim_email_delivery_jobs(integer, text, integer) to service_role;
