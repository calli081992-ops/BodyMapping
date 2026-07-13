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
});

export const createClientSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().email(),
});
