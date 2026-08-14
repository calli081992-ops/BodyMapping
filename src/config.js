import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  CORS_ORIGIN: z.string().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_S3_BUCKET: z.string().min(1),
  AWS_KMS_KEY_ID: z.string().optional(),
  PAUBOX_API_KEY: z.string().min(1),
  PAUBOX_API_ENDPOINT: z.string().min(1),
  PAUBOX_FROM_EMAIL: z.string().email(),
  NOTE_RETENTION_YEARS: z.coerce.number().int().min(10).default(10),
  PDF_DOWNLOAD_URL_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(300),
  EMAIL_QUEUE_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .transform((value) => value === "true")
    .default("true"),
  EMAIL_QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).max(60000).default(5000),
  EMAIL_QUEUE_BATCH_SIZE: z.coerce.number().int().min(1).max(50).default(10),
  EMAIL_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  EMAIL_QUEUE_BACKOFF_BASE_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
  EMAIL_QUEUE_PROCESSING_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const errorLines = parsed.error.issues.map(
    (issue) => `${issue.path.join(".")}: ${issue.message}`,
  );
  throw new Error(`Invalid environment configuration:\n${errorLines.join("\n")}`);
}

export const env = parsed.data;
