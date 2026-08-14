import { randomUUID } from "node:crypto";

import { env } from "../config.js";
import { logger } from "../logger.js";
import { buildSoapNotePdfBuffer } from "./pdf-service.js";
import { sendEncryptedNoteEmail } from "./paubox-service.js";
import { createServiceRoleClient } from "./supabase.js";

// Exponential backoff for the Nth attempt: base * 2^(attempts-1), capped at 24h.
export const computeBackoffSeconds = (attempts, baseSeconds = env.EMAIL_QUEUE_BACKOFF_BASE_SECONDS) => {
  const exponent = Math.max(attempts - 1, 0);
  return Math.min(baseSeconds * 2 ** exponent, 24 * 60 * 60);
};

// Enqueue an email delivery job using the request-scoped (RLS) client, so the
// insert is authorized as the acting therapist.
export const enqueueEmailDelivery = async (
  db,
  { organizationId, noteId, therapistId, destinationEmail, maxAttempts = env.EMAIL_QUEUE_MAX_ATTEMPTS },
) => {
  const { data, error } = await db
    .from("email_delivery_jobs")
    .insert({
      organization_id: organizationId,
      note_id: noteId,
      enqueued_by_therapist_id: therapistId,
      destination_email: destinationEmail,
      max_attempts: maxAttempts,
    })
    .select("id, status")
    .single();
  if (error) {
    throw error;
  }
  return data;
};

const loadNoteForJob = async (serviceDb, job) => {
  const { data, error } = await serviceDb
    .from("soap_notes")
    .select(
      "id, session_at, created_at, retention_until, subjective, objective, assessment, plan, client:clients!inner(id, first_name, last_name, email), organization:organizations!inner(name), therapist:therapists!inner(display_name)",
    )
    .eq("id", job.note_id)
    .eq("organization_id", job.organization_id)
    .single();
  if (error) {
    throw error;
  }
  return data;
};

const markSent = async (serviceDb, job, messageId) => {
  await serviceDb
    .from("email_delivery_jobs")
    .update({
      status: "sent",
      external_message_id: messageId ?? null,
      last_error: null,
      error_code: null,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", job.id);
  await serviceDb.from("email_send_audit").insert({
    organization_id: job.organization_id,
    note_id: job.note_id,
    sent_by_therapist_id: job.enqueued_by_therapist_id,
    destination_email: job.destination_email,
    status: "success",
    external_message_id: messageId ?? null,
  });
};

const markFailure = async (serviceDb, job, error) => {
  const errorCode =
    typeof error?.response?.status === "number" ? `PAUBOX_HTTP_${error.response.status}` : "SEND_FAILURE";
  const message = String(error?.message ?? error);
  // job.attempts already reflects this attempt (incremented at claim time).
  const exhausted = job.attempts >= job.max_attempts;

  if (exhausted) {
    await serviceDb
      .from("email_delivery_jobs")
      .update({ status: "dead", last_error: message, error_code: errorCode, locked_at: null, locked_by: null })
      .eq("id", job.id);
    await serviceDb.from("email_send_audit").insert({
      organization_id: job.organization_id,
      note_id: job.note_id,
      sent_by_therapist_id: job.enqueued_by_therapist_id,
      destination_email: job.destination_email,
      status: "failed",
      error_code: errorCode,
    });
    return "dead";
  }

  const nextAttemptAt = new Date(Date.now() + computeBackoffSeconds(job.attempts) * 1000).toISOString();
  await serviceDb
    .from("email_delivery_jobs")
    .update({
      status: "pending",
      next_attempt_at: nextAttemptAt,
      last_error: message,
      error_code: errorCode,
      locked_at: null,
      locked_by: null,
    })
    .eq("id", job.id);
  return "retry";
};

// Claim and process one batch of due jobs. Returns a small summary for logging/tests.
export const runEmailQueueOnce = async (
  serviceDb = createServiceRoleClient(),
  { batchSize = env.EMAIL_QUEUE_BATCH_SIZE, workerId = `worker-${randomUUID()}` } = {},
) => {
  const { data: jobs, error } = await serviceDb.rpc("claim_email_delivery_jobs", {
    p_batch: batchSize,
    p_worker: workerId,
  });
  if (error) {
    throw error;
  }

  const summary = { claimed: jobs?.length ?? 0, sent: 0, retried: 0, dead: 0 };
  for (const job of jobs ?? []) {
    try {
      const note = await loadNoteForJob(serviceDb, job);
      const pdfBuffer = await buildSoapNotePdfBuffer({
        note,
        therapistName: note.therapist?.display_name ?? "Therapist",
        organizationName: note.organization.name,
        client: note.client,
      });
      const { messageId } = await sendEncryptedNoteEmail({
        toEmail: job.destination_email,
        attachmentBuffer: pdfBuffer,
        noteId: note.id,
      });
      await markSent(serviceDb, job, messageId);
      summary.sent += 1;
    } catch (jobError) {
      const outcome = await markFailure(serviceDb, job, jobError);
      if (outcome === "dead") {
        summary.dead += 1;
        logger.error({ jobId: job.id, err: jobError }, "email delivery job exhausted retries");
      } else {
        summary.retried += 1;
        logger.warn({ jobId: job.id, attempts: job.attempts, err: jobError }, "email delivery job failed; will retry");
      }
    }
  }
  return summary;
};

let workerHandle = null;

// Start the background polling worker. No-op unless EMAIL_QUEUE_ENABLED is set.
export const startEmailQueueWorker = () => {
  if (!env.EMAIL_QUEUE_ENABLED) {
    logger.info("email queue worker disabled (EMAIL_QUEUE_ENABLED=false)");
    return null;
  }
  if (workerHandle) {
    return workerHandle;
  }

  const serviceDb = createServiceRoleClient();
  let inFlight = false;
  const tick = async () => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const summary = await runEmailQueueOnce(serviceDb);
      if (summary.claimed > 0) {
        logger.info(summary, "email queue batch processed");
      }
    } catch (pollError) {
      logger.error({ err: pollError }, "email queue poll failed");
    } finally {
      inFlight = false;
    }
  };

  workerHandle = setInterval(tick, env.EMAIL_QUEUE_POLL_INTERVAL_MS);
  if (typeof workerHandle.unref === "function") {
    workerHandle.unref();
  }
  logger.info(
    { intervalMs: env.EMAIL_QUEUE_POLL_INTERVAL_MS, batchSize: env.EMAIL_QUEUE_BATCH_SIZE },
    "email queue worker started",
  );
  return workerHandle;
};

export const stopEmailQueueWorker = () => {
  if (workerHandle) {
    clearInterval(workerHandle);
    workerHandle = null;
  }
};
