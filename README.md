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

## Architecture

- **Frontend prototype**: static HTML/JS client served by Express
- **Backend**: `/api` routes for auth context, clients, SOAP notes, history search, and secure email send
- **Database**: Supabase migration in `supabase/migrations/001_initial_schema.sql`
- **Storage**: S3 object key per tenant/client/note (`orgId/clientId/noteId.pdf`) with enforced server-side encryption
- **Email**: Paubox `/messages` API with encrypted notification flow and PDF attachment

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
- `AWS_REGION`, `AWS_S3_BUCKET`, optional `AWS_KMS_KEY_ID`
- `PAUBOX_API_KEY`, `PAUBOX_API_ENDPOINT`, `PAUBOX_FROM_EMAIL`

### 3) Apply Supabase migration

Run `supabase/migrations/001_initial_schema.sql` against your Supabase Postgres database.

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
- `GET /api/clients`
- `POST /api/clients`
- `GET /api/clients/history?query=&clientId=&limit=`
- `POST /api/soap-notes`
- `POST /api/soap-notes/:noteId/email`

## Frontend Prototype Usage

In `public/index.html`:

1. Paste Supabase user JWT + organization ID
2. Validate session context
3. Create client(s)
4. Create SOAP note(s)
5. Search history
6. Click **Send encrypted PDF** for one-click secure client delivery via Paubox

## Future SaaS Scaling Notes

This project is prepared for multi-tenant growth with isolated org data views and RLS. For production SaaS maturity, next steps typically include:

- SSO + session management frontend
- background job queue for retryable email delivery
- immutable audit export pipeline
- per-tenant KMS key strategy
- SOC2/HIPAA control automation and centralized observability
