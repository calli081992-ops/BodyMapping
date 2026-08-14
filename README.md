# BodyMapping HIPAA SOAP Notes Platform

HIPAA-oriented SOAP notes web app starter for massage therapists and spa teams. This implementation provides:

- Existing HTML-style prototype UI (`public/index.html`) for rapid workflows
- Node.js + Express API backend
- Supabase Postgres schema with Row-Level Security (RLS) for tenant isolation
- Organization model that supports:
  - Solo therapist accounts
  - Multi-therapist spa/business accounts sharing clients
- In-memory PDF generation for SOAP notes
- Encrypted AWS S3 PDF storage (`AES256` or `aws:kms`)
- One-click secure Paubox email delivery with **no PHI in email body**
- Email send audit logging (timestamp, destination email, success/fail, external id/error code)
- Minimum 10-year record retention controls at the database layer
- Team client-sharing controls for spa/business organizations
- Background delivery queue with retry/backoff for Paubox sends
- Signed S3 download URLs for secure PDF retrieval
- Stale-lock recovery and dead-letter retry operations for delivery jobs

## Architecture

- **Frontend prototype**: static HTML/JS client served by Express
- **Backend**: `/api` routes for auth context, clients, SOAP notes, history search, delivery queue, and secure download URLs
- **Database**: Supabase migration in `supabase/migrations/001_initial_schema.sql`
- **Storage**: S3 object key per tenant/client/note (`orgId/clientId/noteId.pdf`) with enforced server-side encryption
- **Email**: Paubox `/messages` API with encrypted notification flow and PDF attachment, driven by a retrying queue worker

## Security/Compliance Notes

1. **Tenant isolation**
   - All records are attached to an `organization_id`.
   - RLS policies restrict all reads/writes by therapist membership and client access.
2. **PHI controls**
   - SOAP content is never written to audit logs.
   - Paubox email body is generic and contains no client/session detail.
   - PHI is delivered via encrypted PDF attachment.
3. **Retention**
   - `retention_until` defaults to `now() + 10 years`.
   - Delete trigger blocks note deletion before retention expires.
4. **Storage encryption**
   - Uses S3 SSE-KMS when `AWS_KMS_KEY_ID` is set, otherwise SSE-S3 (`AES256`).

> This repository is an application starter, not legal advice or a completed compliance program. You still need BAA coverage, secure hosting controls, key rotation, logging/monitoring, backup strategy, incident response, and formal compliance review.

## Quick Start

### 1) Install dependencies

```bash
npm install
```

### 2) Configure environment

```bash
cp .env.example .env
```

Fill all values in `.env`:

- `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AWS_REGION`, `AWS_S3_BUCKET`, optional `AWS_KMS_KEY_ID`
- `PAUBOX_API_KEY`, `PAUBOX_API_ENDPOINT`, `PAUBOX_FROM_EMAIL`
- `PDF_DOWNLOAD_URL_TTL_SECONDS`, `EMAIL_QUEUE_*` queue settings

### 3) Apply Supabase migrations

Run migrations in order:

1. `supabase/migrations/001_initial_schema.sql`
2. `supabase/migrations/002_access_policy_hardening.sql`
3. `supabase/migrations/003_email_delivery_queue.sql`
4. `supabase/migrations/004_email_delivery_job_admin_controls.sql`

### 4) Start the server

```bash
npm run dev
```

Open:

- App UI: `http://localhost:3000`
- Health: `http://localhost:3000/health`

## Supabase Data Model

Top-level tables:

- `organizations` (solo/spa tenant)
- `therapists` (maps Supabase Auth user to therapist profile)
- `organization_memberships` (many-to-many therapist/org with role)
- `clients` (tenant-scoped client records)
- `client_access` (shared-client permissions within org)
- `soap_notes` (SOAP content, retention metadata, storage metadata)
- `email_send_audit` (send events only; no note body)

## API Endpoints

All `/api/*` endpoints require:

- `Authorization: Bearer <supabase-access-token>`
- `X-Organization-Id: <organization-uuid>`

Endpoints:

- `GET /api/me`
- `GET /api/organization/therapists`
- `GET /api/clients`
- `POST /api/clients`
- `GET /api/clients/:clientId/access`
- `POST /api/clients/:clientId/access`
- `DELETE /api/clients/:clientId/access/:therapistId`
- `GET /api/clients/history?query=&clientId=&limit=&scope=organization|therapist`
- `POST /api/soap-notes`
- `GET /api/soap-notes/:noteId/download-url`
- `POST /api/soap-notes/:noteId/email`
- `GET /api/email-delivery-jobs`
- `GET /api/email-delivery-jobs/:jobId`
- `GET /api/email-delivery-jobs/dead-letter`
- `GET /api/email-delivery-jobs/metrics`
- `POST /api/email-delivery-jobs/:jobId/retry`
- `POST /api/email-delivery-jobs/retry-failed` (owner/admin)
- `GET /api/audit/email-sends`

## Frontend Prototype Usage

In `public/index.html`:

1. Paste Supabase user JWT + organization ID
2. Validate session context
3. Create client(s)
4. Share client access to other therapists (viewer/editor)
5. Create SOAP note(s)
6. Search history by organization-accessible records or only your therapist-authored records
7. Click **Send encrypted PDF** to queue delivery (automatic retry/backoff in background worker)
8. Use **Secure PDF link** for short-lived signed download URLs
9. Retry dead-letter jobs (single or bulk for owner/admin) and review queue metrics
10. Review metadata-only email audit events and delivery-job status

## Future SaaS Scaling Notes

This project is prepared for multi-tenant growth with isolated org data views and RLS. For production SaaS maturity, next steps typically include:

- SSO + session management frontend
- dedicated external worker + dead-letter queue for large-scale delivery throughput
- immutable audit export pipeline
- per-tenant KMS key strategy
- SOC2/HIPAA control automation and centralized observability
