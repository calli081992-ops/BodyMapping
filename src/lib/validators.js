import { z } from "zod";

export const soapNoteInputSchema = z.object({
  clientId: z.string().uuid(),
  sessionAt: z.string().datetime().optional(),
  subjective: z.string().trim().min(1).max(12000),
  objective: z.string().trim().min(1).max(12000),
  assessment: z.string().trim().min(1).max(12000),
  plan: z.string().trim().min(1).max(12000),
});

export const emailNoteInputSchema = z.object({
  destinationEmail: z.string().email().optional(),
});

export const historyQuerySchema = z.object({
  query: z.string().trim().max(160).optional(),
  clientId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  scope: z.enum(["organization", "therapist"]).default("organization"),
});

export const createClientSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email(),
});

export const grantClientAccessSchema = z.object({
  therapistId: z.string().uuid(),
  permission: z.enum(["viewer", "editor"]).default("viewer"),
});

export const emailAuditQuerySchema = z.object({
  noteId: z.string().uuid().optional(),
  status: z.enum(["success", "failed"]).optional(),
  destinationEmail: z.string().trim().email().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const queueEmailRequestSchema = z.object({
  destinationEmail: z.string().trim().email().optional(),
});

export const emailJobQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum(["queued", "processing", "retry_pending", "succeeded", "failed"])
    .optional(),
});

export const downloadUrlQuerySchema = z.object({
  expiresInSeconds: z.coerce.number().int().min(60).max(900).optional(),
});
