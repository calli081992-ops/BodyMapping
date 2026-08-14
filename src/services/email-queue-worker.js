import { env } from "../config.js";
import { logger } from "../logger.js";
import { sendEncryptedNoteEmail } from "./paubox-service.js";
import { buildSoapNotePdfBuffer } from "./pdf-service.js";
import { uploadEncryptedPdf } from "./s3-storage.js";
import { createAdminSupabaseClient } from "./supabase.js";

const adminDb = createAdminSupabaseClient();

const claimableStatuses = ["queued", "retry_pending"];
let isProcessing = false;
let rerunRequested = false;
let pollHandle = null;

const getErrorCode = (error) => {
  if (typeof error?.response?.status === "number") {
    return `PAUBOX_HTTP_${error.response.status}`;
  }
  return "SEND_FAILURE";
};

const getErrorMessage = (error) => {
  if (typeof error?.message === "string") {
    return error.message.slice(0, 400);
  }
  return "Unknown error";
};

const getRetryTimestamp = (attemptCount) => {
  const multiplier = Math.max(1, 2 ** Math.max(attemptCount - 1, 0));
  const waitSeconds = env.EMAIL_QUEUE_BACKOFF_BASE_SECONDS * multiplier;
  return new Date(Date.now() + waitSeconds * 1000).toISOString();
};

const logAuditEvent = async ({
  organizationId,
  noteId,
  therapistId,
  destinationEmail,
  status,
  externalMessageId = null,
  errorCode = null,
  jobId = null,
  attemptNumber = null,
}) => {
  const { error } = await adminDb.from("email_send_audit").insert({
    organization_id: organizationId,
    note_id: noteId,
    sent_by_therapist_id: therapistId,
    destination_email: destinationEmail,
    status,
    external_message_id: externalMessageId,
    error_code: errorCode,
    job_id: jobId,
    attempt_number: attemptNumber,
  });
  if (error) {
    logger.error({ err: error, jobId }, "Failed to write email send audit event.");
  }
};

const fetchNoteForDelivery = async (organizationId, noteId) => {
  const { data, error } = await adminDb
    .from("soap_notes")
    .select(
      "id, organization_id, client_id, created_at, session_at, retention_until, subjective, objective, assessment, plan, s3_object_key, client:clients!inner(id, first_name, last_name, email), therapist:therapists!inner(id, display_name), organization:organizations!inner(name)",
    )
    .eq("organization_id", organizationId)
    .eq("id", noteId)
    .single();
  if (error) {
    throw error;
  }
  return data;
};

const ensureNotePdfStored = async (note) => {
  const pdfBuffer = await buildSoapNotePdfBuffer({
    note,
    therapistName: note.therapist?.display_name ?? "Therapist",
    organizationName: note.organization?.name ?? "Organization",
    client: note.client,
  });

  if (!note.s3_object_key) {
    const upload = await uploadEncryptedPdf({
      organizationId: note.organization_id,
      clientId: note.client_id,
      noteId: note.id,
      pdfBuffer,
    });
    const { error } = await adminDb
      .from("soap_notes")
      .update({
        s3_object_key: upload.objectKey,
        s3_etag: upload.etag,
        pdf_storage_status: "stored",
      })
      .eq("organization_id", note.organization_id)
      .eq("id", note.id);
    if (error) {
      throw error;
    }
  }

  return pdfBuffer;
};

const markJob = async (jobId, patch) => {
  const { error } = await adminDb.from("email_delivery_jobs").update(patch).eq("id", jobId);
  if (error) {
    throw error;
  }
};

const processClaimedJob = async (job) => {
  const attemptNumber = job.attempt_count + 1;
  const nowIso = new Date().toISOString();

  try {
    const note = await fetchNoteForDelivery(job.organization_id, job.note_id);
    const pdfBuffer = await ensureNotePdfStored(note);
    const sendResult = await sendEncryptedNoteEmail({
      toEmail: job.destination_email,
      attachmentBuffer: pdfBuffer,
      noteId: note.id,
    });

    await markJob(job.id, {
      status: "succeeded",
      attempt_count: attemptNumber,
      last_attempt_at: nowIso,
      completed_at: nowIso,
      external_message_id: sendResult.messageId,
      last_error_code: null,
      last_error_message: null,
      next_attempt_at: nowIso,
    });

    await logAuditEvent({
      organizationId: job.organization_id,
      noteId: job.note_id,
      therapistId: job.requested_by_therapist_id,
      destinationEmail: job.destination_email,
      status: "success",
      externalMessageId: sendResult.messageId,
      jobId: job.id,
      attemptNumber,
    });
  } catch (error) {
    const errorCode = getErrorCode(error);
    const terminalFailure = attemptNumber >= job.max_attempts;
    const nextAttemptAt = terminalFailure ? nowIso : getRetryTimestamp(attemptNumber);

    await markJob(job.id, {
      status: terminalFailure ? "failed" : "retry_pending",
      attempt_count: attemptNumber,
      last_attempt_at: nowIso,
      completed_at: terminalFailure ? nowIso : null,
      next_attempt_at: nextAttemptAt,
      last_error_code: errorCode,
      last_error_message: getErrorMessage(error),
    });

    await logAuditEvent({
      organizationId: job.organization_id,
      noteId: job.note_id,
      therapistId: job.requested_by_therapist_id,
      destinationEmail: job.destination_email,
      status: "failed",
      errorCode,
      jobId: job.id,
      attemptNumber,
    });

    logger.warn(
      {
        jobId: job.id,
        noteId: job.note_id,
        organizationId: job.organization_id,
        destinationEmail: job.destination_email,
        attemptNumber,
        maxAttempts: job.max_attempts,
        errorCode,
      },
      "Background note email attempt failed.",
    );
  }
};

const claimJob = async (jobId) => {
  const nowIso = new Date().toISOString();
  const { data, error } = await adminDb
    .from("email_delivery_jobs")
    .update({
      status: "processing",
      last_attempt_at: nowIso,
    })
    .eq("id", jobId)
    .in("status", claimableStatuses)
    .lte("next_attempt_at", nowIso)
    .select("*")
    .maybeSingle();
  if (error) {
    throw error;
  }
  return data;
};

export const processEmailQueueOnce = async () => {
  if (!env.EMAIL_QUEUE_ENABLED) {
    return;
  }
  if (isProcessing) {
    rerunRequested = true;
    return;
  }

  isProcessing = true;
  try {
    const nowIso = new Date().toISOString();
    const { data: candidates, error } = await adminDb
      .from("email_delivery_jobs")
      .select("id")
      .in("status", claimableStatuses)
      .lte("next_attempt_at", nowIso)
      .order("next_attempt_at", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(env.EMAIL_QUEUE_BATCH_SIZE);
    if (error) {
      throw error;
    }

    for (const candidate of candidates ?? []) {
      const claimed = await claimJob(candidate.id);
      if (!claimed) {
        continue;
      }
      await processClaimedJob(claimed);
    }
  } catch (error) {
    logger.error({ err: error }, "Email queue processing cycle failed.");
  } finally {
    isProcessing = false;
    if (rerunRequested) {
      rerunRequested = false;
      await processEmailQueueOnce();
    }
  }
};

export const triggerEmailQueueProcessing = () => {
  void processEmailQueueOnce();
};

export const startEmailQueueWorker = () => {
  if (!env.EMAIL_QUEUE_ENABLED) {
    logger.info("Email queue worker disabled by configuration.");
    return;
  }
  if (pollHandle) {
    return;
  }

  logger.info(
    {
      pollIntervalMs: env.EMAIL_QUEUE_POLL_INTERVAL_MS,
      batchSize: env.EMAIL_QUEUE_BATCH_SIZE,
      maxAttempts: env.EMAIL_QUEUE_MAX_ATTEMPTS,
    },
    "Starting email queue worker.",
  );
  void processEmailQueueOnce();
  pollHandle = setInterval(() => {
    void processEmailQueueOnce();
  }, env.EMAIL_QUEUE_POLL_INTERVAL_MS);
  if (typeof pollHandle.unref === "function") {
    pollHandle.unref();
  }
};
