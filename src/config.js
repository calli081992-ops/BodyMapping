import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(1),
  AWS_KMS_KEY_ID: z.string().optional(),
  PAUBOX_API_KEY: z.string().min(1),
  PAUBOX_API_ENDPOINT: z.string().min(1),
  PAUBOX_FROM_EMAIL: z.string().email(),
  NOTE_RETENTION_YEARS: z.coerce.number().int().min(10).default(10),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const errorLines = parsed.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid environment configuration:\n${errorLines.join("\n")}`);
}

export const env = parsed.data;
