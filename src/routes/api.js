import { Router } from "express";
import { z } from "zod";

import { env } from "../config.js";
import { HttpError } from "../lib/http-error.js";
import { parseBody, parseQuery, sanitizeIlikeTerm } from "../lib/request-helpers.js";
import {
  createClientSchema,
  emailAuditQuerySchema,
  emailNoteInputSchema,
  grantClientAccessSchema,
  historyQuerySchema,
  soapNoteInputSchema,
} from "../lib/validators.js";
import { logger } from "../logger.js";
import { requireAuthContext } from "../middleware/auth-context.js";
import { sendEncryptedNoteEmail } from "../services/paubox-service.js";
import { buildSoapNotePdfBuffer } from "../services/pdf-service.js";
import { uploadEncryptedPdf } from "../services/s3-storage.js";

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

const router = Router();

router.use(requireAuthContext);

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
        "id, note_id, destination_email, status, external_message_id, error_code, sent_at, sender:therapists!inner(id, display_name)",
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
        sentBy: entry.sender,
      })),
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

router.post("/soap-notes/:noteId/email", async (req, res, next) => {
  let noteId = null;
  let destinationEmail = null;
  try {
    const params = noteIdParamSchema.parse(req.params);
    noteId = params.noteId;
    const payload = parseBody(emailNoteInputSchema, req.body ?? {});

    const { data: note, error: noteError } = await req.db
      .from("soap_notes")
      .select(
        "id, created_at, session_at, retention_until, subjective, objective, assessment, plan, client_id, s3_object_key, client:clients!inner(id, first_name, last_name, email), organization:organizations!inner(name)",
      )
      .eq("id", noteId)
      .eq("organization_id", req.auth.organizationId)
      .single();
    if (noteError) {
      throw noteError;
    }

    destinationEmail = payload.destinationEmail ?? note.client.email;
    if (!destinationEmail) {
      throw new HttpError(400, "Client does not have a destination email.");
    }

    const organizationName = note.organization.name;
    const pdfBuffer = await buildSoapNotePdfBuffer({
      note,
      therapistName: req.auth.therapistName ?? "Therapist",
      organizationName,
      client: note.client,
    });

    if (!note.s3_object_key) {
      const storageResult = await uploadEncryptedPdf({
        organizationId: req.auth.organizationId,
        clientId: note.client_id,
        noteId: note.id,
        pdfBuffer,
      });
      const { error: storageError } = await req.db
        .from("soap_notes")
        .update({
          s3_object_key: storageResult.objectKey,
          s3_etag: storageResult.etag,
          pdf_storage_status: "stored",
        })
        .eq("id", note.id)
        .eq("organization_id", req.auth.organizationId);
      if (storageError) {
        throw storageError;
      }
    }

    const sendResult = await sendEncryptedNoteEmail({
      toEmail: destinationEmail,
      attachmentBuffer: pdfBuffer,
      noteId: note.id,
    });

    const { error: auditError } = await req.db.from("email_send_audit").insert({
      organization_id: req.auth.organizationId,
      note_id: note.id,
      sent_by_therapist_id: req.auth.therapistId,
      destination_email: destinationEmail,
      status: "success",
      external_message_id: sendResult.messageId,
    });
    if (auditError) {
      throw auditError;
    }

    res.json({
      noteId: note.id,
      destinationEmail,
      status: "success",
    });
  } catch (error) {
    const errorCode =
      typeof error?.response?.status === "number"
        ? `PAUBOX_HTTP_${error.response.status}`
        : "SEND_FAILURE";

    if (noteId && destinationEmail) {
      await req.db.from("email_send_audit").insert({
        organization_id: req.auth.organizationId,
        note_id: noteId,
        sent_by_therapist_id: req.auth.therapistId,
        destination_email: destinationEmail,
        status: "failed",
        error_code: errorCode,
      });
    }

    next(error);
  }
});

export default router;
