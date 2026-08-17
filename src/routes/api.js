import { Router } from "express";
import { z } from "zod";

import { env } from "../config.js";
import { HttpError } from "../lib/http-error.js";
import { parseBody, parseQuery, sanitizeIlikeTerm } from "../lib/request-helpers.js";
import {
  bulkRetryEmailJobsSchema,
  createClientSchema,
  downloadUrlQuerySchema,
  emailAuditQuerySchema,
  emailJobQuerySchema,
  grantClientAccessSchema,
  historyQuerySchema,
  queueEmailRequestSchema,
  retryEmailJobSchema,
  soapNoteInputSchema,
} from "../lib/validators.js";
import { logger } from "../logger.js";
import { requireAuthContext } from "../middleware/auth-context.js";
import { triggerEmailQueueProcessing } from "../services/email-queue-worker.js";
import { buildSoapNotePdfBuffer } from "../services/pdf-service.js";
import { createSignedPdfDownloadUrl, uploadEncryptedPdf } from "../services/s3-storage.js";

const noteIdParamSchema = z.object({
  noteId: z.string().uuid(),
});

const clientIdParamSchema = z.object({
  clientId: z.string().uuid(),
});

const clientAccessParamsSchema = z.object({
  clientId: z.string().uuid(),
  therapistId: z.string().uuid(),
});

const emailDeliveryJobIdParamSchema = z.object({
  jobId: z.string().uuid(),
});

const router = Router();

router.use(requireAuthContext);

const adminRoles = new Set(["owner", "admin"]);

const hasAdminRole = (auth) => adminRoles.has(auth.role);

const ensureAdminRole = (auth) => {
  if (!hasAdminRole(auth)) {
    throw new HttpError(403, "Only owner/admin roles can perform this action.");
  }
};

const loadNoteWithContext = async ({ db, organizationId, noteId }) => {
  const { data, error } = await db
    .from("soap_notes")
    .select(
      "id, organization_id, client_id, therapist_id, created_at, session_at, retention_until, subjective, objective, assessment, plan, pdf_storage_status, s3_object_key, client:clients!inner(id, first_name, last_name, email), therapist:therapists!inner(id, display_name), organization:organizations!inner(name)",
    )
    .eq("organization_id", organizationId)
    .eq("id", noteId)
    .single();
  if (error) {
    throw error;
  }
  return data;
};

router.get("/me", (req, res) => {
  res.json({
    userId: req.auth.userId,
    therapistId: req.auth.therapistId,
    therapistName: req.auth.therapistName,
    organizationId: req.auth.organizationId,
    role: req.auth.role,
  });
});

router.get("/organization/therapists", async (req, res, next) => {
  try {
    const { data, error } = await req.db
      .from("organization_memberships")
      .select(
        "role, therapist:therapists!inner(id, display_name, email)",
      )
      .eq("organization_id", req.auth.organizationId)
      .order("display_name", { ascending: true, foreignTable: "therapists" });
    if (error) {
      throw error;
    }

    res.json({
      therapists: (data ?? []).map((member) => ({
        id: member.therapist.id,
        displayName: member.therapist.display_name,
        email: member.therapist.email,
        role: member.role,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/clients", async (req, res, next) => {
  try {
    const term = typeof req.query.query === "string" ? req.query.query.trim() : "";
    let queryBuilder = req.db
      .from("clients")
      .select("id, first_name, last_name, email, created_at")
      .eq("organization_id", req.auth.organizationId)
      .is("archived_at", null)
      .order("last_name", { ascending: true })
      .order("first_name", { ascending: true })
      .limit(100);

    if (term.length > 0) {
      const escaped = sanitizeIlikeTerm(term);
      queryBuilder = queryBuilder.or(
        `first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%,email.ilike.%${escaped}%`,
      );
    }

    const { data, error } = await queryBuilder;
    if (error) {
      throw error;
    }

    res.json({ clients: data ?? [] });
  } catch (error) {
    next(error);
  }
});

router.post("/clients", async (req, res, next) => {
  try {
    const payload = parseBody(createClientSchema, req.body);
    const insertRecord = {
      organization_id: req.auth.organizationId,
      first_name: payload.firstName,
      last_name: payload.lastName,
      email: payload.email,
      primary_therapist_id: req.auth.therapistId,
      created_by_therapist_id: req.auth.therapistId,
    };

    const { data, error } = await req.db
      .from("clients")
      .insert(insertRecord)
      .select("id, first_name, last_name, email, created_at")
      .single();
    if (error) {
      throw error;
    }

    const { error: accessError } = await req.db.from("client_access").upsert(
      {
        organization_id: req.auth.organizationId,
        client_id: data.id,
        therapist_id: req.auth.therapistId,
        permission: "editor",
      },
      { onConflict: "organization_id,client_id,therapist_id" },
    );
    if (accessError) {
      throw accessError;
    }

    res.status(201).json({ client: data });
  } catch (error) {
    next(error);
  }
});

router.get("/clients/:clientId/access", async (req, res, next) => {
  try {
    const { clientId } = clientIdParamSchema.parse(req.params);
    const { data, error } = await req.db
      .from("client_access")
      .select(
        "permission, created_at, therapist:therapists!inner(id, display_name, email)",
      )
      .eq("organization_id", req.auth.organizationId)
      .eq("client_id", clientId)
      .order("display_name", { ascending: true, foreignTable: "therapists" });
    if (error) {
      throw error;
    }

    res.json({
      access: (data ?? []).map((entry) => ({
        therapistId: entry.therapist.id,
        therapistName: entry.therapist.display_name,
        therapistEmail: entry.therapist.email,
        permission: entry.permission,
        createdAt: entry.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/clients/:clientId/access", async (req, res, next) => {
  try {
    const { clientId } = clientIdParamSchema.parse(req.params);
    const payload = parseBody(grantClientAccessSchema, req.body);

    const { data: upserted, error } = await req.db
      .from("client_access")
      .upsert(
        {
          organization_id: req.auth.organizationId,
          client_id: clientId,
          therapist_id: payload.therapistId,
          permission: payload.permission,
        },
        { onConflict: "organization_id,client_id,therapist_id" },
      )
      .select("organization_id, client_id, therapist_id, permission, created_at")
      .single();
    if (error) {
      throw error;
    }

    res.status(201).json({
      access: {
        organizationId: upserted.organization_id,
        clientId: upserted.client_id,
        therapistId: upserted.therapist_id,
        permission: upserted.permission,
        createdAt: upserted.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.delete("/clients/:clientId/access/:therapistId", async (req, res, next) => {
  try {
    const params = clientAccessParamsSchema.parse(req.params);
    if (params.therapistId === req.auth.therapistId) {
      throw new HttpError(400, "Cannot remove your own access via this endpoint.");
    }

    const { error } = await req.db
      .from("client_access")
      .delete()
      .eq("organization_id", req.auth.organizationId)
      .eq("client_id", params.clientId)
      .eq("therapist_id", params.therapistId);
    if (error) {
      throw error;
    }

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

router.get("/clients/history", async (req, res, next) => {
  try {
    const query = parseQuery(historyQuerySchema, req.query);
    let notesQuery = req.db
      .from("soap_notes")
      .select(
        "id, created_at, session_at, retention_until, pdf_storage_status, client:clients!inner(id, first_name, last_name, email), therapist:therapists!inner(id, display_name), subjective, objective, assessment, plan",
      )
      .eq("organization_id", req.auth.organizationId)
      .order("session_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(query.limit);

    if (query.clientId) {
      notesQuery = notesQuery.eq("client_id", query.clientId);
    }

    if (query.scope === "therapist") {
      notesQuery = notesQuery.eq("therapist_id", req.auth.therapistId);
    }

    if (query.query && query.query.length > 0) {
      const escaped = sanitizeIlikeTerm(query.query);
      notesQuery = notesQuery.or(
        `subjective.ilike.%${escaped}%,objective.ilike.%${escaped}%,assessment.ilike.%${escaped}%,plan.ilike.%${escaped}%`,
      );
      notesQuery = notesQuery.or(
        `first_name.ilike.%${escaped}%,last_name.ilike.%${escaped}%,email.ilike.%${escaped}%`,
        { foreignTable: "clients" },
      );
    }

    const { data, error } = await notesQuery;
    if (error) {
      throw error;
    }

    res.json({
      history: (data ?? []).map((item) => ({
        id: item.id,
        sessionAt: item.session_at,
        createdAt: item.created_at,
        retentionUntil: item.retention_until,
        pdfStorageStatus: item.pdf_storage_status,
        therapist: item.therapist,
        client: item.client,
        subjective: item.subjective,
        objective: item.objective,
        assessment: item.assessment,
        plan: item.plan,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/audit/email-sends", async (req, res, next) => {
  try {
    const query = parseQuery(emailAuditQuerySchema, req.query);
    let auditQuery = req.db
      .from("email_send_audit")
      .select(
        "id, note_id, destination_email, status, external_message_id, error_code, sent_at, job_id, attempt_number, sender:therapists!inner(id, display_name)",
      )
      .eq("organization_id", req.auth.organizationId)
      .order("sent_at", { ascending: false })
      .limit(query.limit);

    if (query.noteId) {
      auditQuery = auditQuery.eq("note_id", query.noteId);
    }
    if (query.status) {
      auditQuery = auditQuery.eq("status", query.status);
    }
    if (query.destinationEmail) {
      auditQuery = auditQuery.eq("destination_email", query.destinationEmail);
    }
    if (query.from) {
      auditQuery = auditQuery.gte("sent_at", query.from);
    }
    if (query.to) {
      auditQuery = auditQuery.lte("sent_at", query.to);
    }

    const { data, error } = await auditQuery;
    if (error) {
      throw error;
    }

    res.json({
      sends: (data ?? []).map((entry) => ({
        id: entry.id,
        noteId: entry.note_id,
        destinationEmail: entry.destination_email,
        status: entry.status,
        externalMessageId: entry.external_message_id,
        errorCode: entry.error_code,
        sentAt: entry.sent_at,
        jobId: entry.job_id,
        attemptNumber: entry.attempt_number,
        sentBy: entry.sender,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/email-delivery-jobs", async (req, res, next) => {
  try {
    const query = parseQuery(emailJobQuerySchema, req.query);
    let jobsQuery = req.db
      .from("email_delivery_jobs")
      .select(
        "id, note_id, destination_email, status, attempt_count, max_attempts, next_attempt_at, last_attempt_at, completed_at, last_error_code, created_at",
      )
      .eq("organization_id", req.auth.organizationId)
      .order("created_at", { ascending: false })
      .limit(query.limit);

    if (query.status) {
      jobsQuery = jobsQuery.eq("status", query.status);
    }

    const { data, error } = await jobsQuery;
    if (error) {
      throw error;
    }

    res.json({
      jobs: (data ?? []).map((job) => ({
        id: job.id,
        noteId: job.note_id,
        destinationEmail: job.destination_email,
        status: job.status,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        nextAttemptAt: job.next_attempt_at,
        lastAttemptAt: job.last_attempt_at,
        completedAt: job.completed_at,
        lastErrorCode: job.last_error_code,
        createdAt: job.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/email-delivery-jobs/dead-letter", async (req, res, next) => {
  try {
    const query = parseQuery(emailJobQuerySchema, req.query);
    const { data, error } = await req.db
      .from("email_delivery_jobs")
      .select(
        "id, note_id, requested_by_therapist_id, destination_email, status, attempt_count, max_attempts, next_attempt_at, last_attempt_at, completed_at, last_error_code, last_error_message, created_at",
      )
      .eq("organization_id", req.auth.organizationId)
      .eq("status", "failed")
      .order("completed_at", { ascending: false })
      .limit(query.limit);
    if (error) {
      throw error;
    }

    res.json({
      deadLetterJobs: (data ?? []).map((job) => ({
        id: job.id,
        noteId: job.note_id,
        requestedByTherapistId: job.requested_by_therapist_id,
        destinationEmail: job.destination_email,
        status: job.status,
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        nextAttemptAt: job.next_attempt_at,
        lastAttemptAt: job.last_attempt_at,
        completedAt: job.completed_at,
        lastErrorCode: job.last_error_code,
        lastErrorMessage: job.last_error_message,
        createdAt: job.created_at,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/email-delivery-jobs/metrics", async (req, res, next) => {
  try {
    const nowIso = new Date().toISOString();
    const staleCutoffIso = new Date(
      Date.now() - env.EMAIL_QUEUE_PROCESSING_TIMEOUT_SECONDS * 1000,
    ).toISOString();
    const statuses = ["queued", "processing", "retry_pending", "succeeded", "failed"];

    const countByStatus = await Promise.all(
      statuses.map(async (status) => {
        const { count, error } = await req.db
          .from("email_delivery_jobs")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", req.auth.organizationId)
          .eq("status", status);
        if (error) {
          throw error;
        }
        return [status, count ?? 0];
      }),
    );

    const { count: dueNowCount, error: dueNowError } = await req.db
      .from("email_delivery_jobs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", req.auth.organizationId)
      .in("status", ["queued", "retry_pending"])
      .lte("next_attempt_at", nowIso);
    if (dueNowError) {
      throw dueNowError;
    }

    const { count: staleProcessingCount, error: staleError } = await req.db
      .from("email_delivery_jobs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", req.auth.organizationId)
      .eq("status", "processing")
      .or(
        `last_attempt_at.lt.${staleCutoffIso},and(last_attempt_at.is.null,created_at.lt.${staleCutoffIso})`,
      );
    if (staleError) {
      throw staleError;
    }

    res.json({
      metrics: {
        byStatus: Object.fromEntries(countByStatus),
        dueNowCount: dueNowCount ?? 0,
        staleProcessingCount: staleProcessingCount ?? 0,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/email-delivery-jobs/retry-failed", async (req, res, next) => {
  try {
    ensureAdminRole(req.auth);
    const payload = parseBody(bulkRetryEmailJobsSchema, req.body ?? {});
    const { data: failedJobs, error: failedFetchError } = await req.db
      .from("email_delivery_jobs")
      .select("id")
      .eq("organization_id", req.auth.organizationId)
      .eq("status", "failed")
      .order("completed_at", { ascending: false })
      .limit(payload.limit);
    if (failedFetchError) {
      throw failedFetchError;
    }

    const jobIds = (failedJobs ?? []).map((job) => job.id);
    if (jobIds.length === 0) {
      return res.json({
        retriedCount: 0,
        retriedJobIds: [],
      });
    }

    const patch = {
      status: "queued",
      next_attempt_at: new Date().toISOString(),
      completed_at: null,
      last_error_code: null,
      last_error_message: null,
      external_message_id: null,
    };
    if (payload.resetAttempts) {
      patch.attempt_count = 0;
    }

    const { data: updated, error: updateError } = await req.db
      .from("email_delivery_jobs")
      .update(patch)
      .eq("organization_id", req.auth.organizationId)
      .in("id", jobIds)
      .select("id");
    if (updateError) {
      throw updateError;
    }

    triggerEmailQueueProcessing();

    return res.json({
      retriedCount: (updated ?? []).length,
      retriedJobIds: (updated ?? []).map((row) => row.id),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/email-delivery-jobs/:jobId", async (req, res, next) => {
  try {
    const { jobId } = emailDeliveryJobIdParamSchema.parse(req.params);
    const { data, error } = await req.db
      .from("email_delivery_jobs")
      .select(
        "id, note_id, destination_email, status, attempt_count, max_attempts, next_attempt_at, last_attempt_at, completed_at, last_error_code, created_at",
      )
      .eq("organization_id", req.auth.organizationId)
      .eq("id", jobId)
      .single();
    if (error) {
      throw error;
    }

    res.json({
      job: {
        id: data.id,
        noteId: data.note_id,
        destinationEmail: data.destination_email,
        status: data.status,
        attemptCount: data.attempt_count,
        maxAttempts: data.max_attempts,
        nextAttemptAt: data.next_attempt_at,
        lastAttemptAt: data.last_attempt_at,
        completedAt: data.completed_at,
        lastErrorCode: data.last_error_code,
        createdAt: data.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/email-delivery-jobs/:jobId/retry", async (req, res, next) => {
  try {
    const { jobId } = emailDeliveryJobIdParamSchema.parse(req.params);
    const payload = parseBody(retryEmailJobSchema, req.body ?? {});
    const { data: job, error: jobFetchError } = await req.db
      .from("email_delivery_jobs")
      .select(
        "id, requested_by_therapist_id, status, attempt_count, max_attempts, note_id, destination_email, next_attempt_at, last_attempt_at, completed_at",
      )
      .eq("organization_id", req.auth.organizationId)
      .eq("id", jobId)
      .single();
    if (jobFetchError) {
      throw jobFetchError;
    }

    const requesterOwnsJob = job.requested_by_therapist_id === req.auth.therapistId;
    if (!requesterOwnsJob && !hasAdminRole(req.auth)) {
      throw new HttpError(
        403,
        "Only the requesting therapist or an owner/admin can retry this job.",
      );
    }
    if (job.status === "succeeded") {
      throw new HttpError(409, "Completed successful jobs cannot be retried.");
    }

    const patch = {
      status: "queued",
      next_attempt_at: new Date().toISOString(),
      completed_at: null,
      last_error_code: null,
      last_error_message: null,
      external_message_id: null,
    };
    if (payload.resetAttempts) {
      patch.attempt_count = 0;
    }

    const { data: updated, error: updateError } = await req.db
      .from("email_delivery_jobs")
      .update(patch)
      .eq("organization_id", req.auth.organizationId)
      .eq("id", job.id)
      .select(
        "id, note_id, destination_email, status, attempt_count, max_attempts, next_attempt_at, last_attempt_at, completed_at, last_error_code",
      )
      .single();
    if (updateError) {
      throw updateError;
    }

    triggerEmailQueueProcessing();

    res.json({
      job: {
        id: updated.id,
        noteId: updated.note_id,
        destinationEmail: updated.destination_email,
        status: updated.status,
        attemptCount: updated.attempt_count,
        maxAttempts: updated.max_attempts,
        nextAttemptAt: updated.next_attempt_at,
        lastAttemptAt: updated.last_attempt_at,
        completedAt: updated.completed_at,
        lastErrorCode: updated.last_error_code,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/soap-notes", async (req, res, next) => {
  try {
    const payload = parseBody(soapNoteInputSchema, req.body);
    const { data: client, error: clientError } = await req.db
      .from("clients")
      .select("id, first_name, last_name, email")
      .eq("id", payload.clientId)
      .eq("organization_id", req.auth.organizationId)
      .single();
    if (clientError) {
      throw clientError;
    }

    const insertPayload = {
      organization_id: req.auth.organizationId,
      client_id: payload.clientId,
      therapist_id: req.auth.therapistId,
      session_at: payload.sessionAt ?? null,
      subjective: payload.subjective,
      objective: payload.objective,
      assessment: payload.assessment,
      plan: payload.plan,
      retention_until: new Date(
        Date.now() + env.NOTE_RETENTION_YEARS * 365 * 24 * 60 * 60 * 1000,
      ).toISOString(),
    };

    const { data: note, error: createError } = await req.db
      .from("soap_notes")
      .insert(insertPayload)
      .select(
        "id, created_at, session_at, retention_until, subjective, objective, assessment, plan, client_id",
      )
      .single();
    if (createError) {
      throw createError;
    }

    const { data: organization, error: organizationError } = await req.db
      .from("organizations")
      .select("id, name")
      .eq("id", req.auth.organizationId)
      .single();
    if (organizationError) {
      throw organizationError;
    }

    const pdfBuffer = await buildSoapNotePdfBuffer({
      note,
      therapistName: req.auth.therapistName ?? "Therapist",
      organizationName: organization.name,
      client,
    });

    try {
      const storageResult = await uploadEncryptedPdf({
        organizationId: req.auth.organizationId,
        clientId: payload.clientId,
        noteId: note.id,
        pdfBuffer,
      });

      const { error: storageUpdateError } = await req.db
        .from("soap_notes")
        .update({
          pdf_storage_status: "stored",
          s3_object_key: storageResult.objectKey,
          s3_etag: storageResult.etag,
        })
        .eq("id", note.id)
        .eq("organization_id", req.auth.organizationId);
      if (storageUpdateError) {
        throw storageUpdateError;
      }
    } catch (storageError) {
      logger.error(
        {
          noteId: note.id,
          organizationId: req.auth.organizationId,
          err: storageError,
        },
        "Encrypted PDF storage failed for new note.",
      );
      await req.db
        .from("soap_notes")
        .update({ pdf_storage_status: "failed" })
        .eq("id", note.id)
        .eq("organization_id", req.auth.organizationId);
      throw new HttpError(502, "Note saved but encrypted PDF storage failed.", { noteId: note.id });
    }

    res.status(201).json({
      note: {
        id: note.id,
        clientId: note.client_id,
        createdAt: note.created_at,
        sessionAt: note.session_at,
        retentionUntil: note.retention_until,
        pdfStorageStatus: "stored",
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/soap-notes/:noteId/download-url", async (req, res, next) => {
  try {
    const { noteId } = noteIdParamSchema.parse(req.params);
    const query = parseQuery(downloadUrlQuerySchema, req.query);

    const note = await loadNoteWithContext({
      db: req.db,
      organizationId: req.auth.organizationId,
      noteId,
    });

    let objectKey = note.s3_object_key;
    if (!objectKey) {
      const pdfBuffer = await buildSoapNotePdfBuffer({
        note,
        therapistName: note.therapist?.display_name ?? req.auth.therapistName ?? "Therapist",
        organizationName: note.organization?.name ?? "Organization",
        client: note.client,
      });
      const uploadResult = await uploadEncryptedPdf({
        organizationId: req.auth.organizationId,
        clientId: note.client_id,
        noteId: note.id,
        pdfBuffer,
      });
      objectKey = uploadResult.objectKey;
      const { error: updateError } = await req.db
        .from("soap_notes")
        .update({
          s3_object_key: uploadResult.objectKey,
          s3_etag: uploadResult.etag,
          pdf_storage_status: "stored",
        })
        .eq("organization_id", req.auth.organizationId)
        .eq("id", note.id);
      if (updateError) {
        throw updateError;
      }
    }

    const expiresInSeconds = query.expiresInSeconds ?? env.PDF_DOWNLOAD_URL_TTL_SECONDS;
    const signed = await createSignedPdfDownloadUrl({
      objectKey,
      expiresInSeconds,
    });

    res.json({
      noteId: note.id,
      downloadUrl: signed.url,
      expiresInSeconds,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/soap-notes/:noteId/email", async (req, res, next) => {
  try {
    const { noteId } = noteIdParamSchema.parse(req.params);
    const payload = parseBody(queueEmailRequestSchema, req.body ?? {});
    const note = await loadNoteWithContext({
      db: req.db,
      organizationId: req.auth.organizationId,
      noteId,
    });

    const destinationEmail = payload.destinationEmail ?? note.client.email;
    if (!destinationEmail) {
      throw new HttpError(400, "Client does not have a destination email.");
    }

    const { data: job, error: jobError } = await req.db
      .from("email_delivery_jobs")
      .insert({
        organization_id: req.auth.organizationId,
        note_id: note.id,
        requested_by_therapist_id: req.auth.therapistId,
        destination_email: destinationEmail,
        status: "queued",
        max_attempts: env.EMAIL_QUEUE_MAX_ATTEMPTS,
      })
      .select(
        "id, note_id, destination_email, status, attempt_count, max_attempts, next_attempt_at, created_at",
      )
      .single();
    if (jobError) {
      throw jobError;
    }

    triggerEmailQueueProcessing();

    res.status(202).json({
      jobId: job.id,
      noteId: job.note_id,
      destinationEmail,
      status: job.status,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      nextAttemptAt: job.next_attempt_at,
      createdAt: job.created_at,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
