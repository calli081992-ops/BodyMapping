# AGENTS.md

## Cursor Cloud specific instructions

This repo is a single Node.js/Express app (HIPAA SOAP notes for massage therapists). Standard commands live in `README.md` and `package.json` scripts; the notes below only cover non-obvious startup/run caveats.

### Where the code lives
- The application code currently lives on the `cursor/soap-notes-platform-e2b7` branch. The `main` branch only contains a stub `README.md`, so `npm install` / `npm run dev` only work on a branch that actually has `package.json` (e.g. `cursor/soap-notes-platform-e2b7`).

### Runtime / services
- **Node >= 22 is required** (the strictest dependency is `@supabase/supabase-js` at `>=22`; Express 5 needs `>=18`, AWS SDK v3 needs `>=20`). The cloud VM ships Node 22, which is compatible.
- The update script installs deterministically from the lockfile (`npm ci` when `package-lock.json` exists) and auto-creates `.env` from `.env.example` if missing, so `npm test` and `npm run dev` work immediately on a fresh VM with no manual setup.
- No lint tooling is configured; `npm test` runs the Node built-in test runner (`node --test`) over `test/*.test.js` and needs no external services.
- Dev server: `npm run dev` (uses `node --watch`), serves on `PORT` (default 3000): UI at `/`, health at `/health`, API under `/api`.

### Key gotcha: the server boots with placeholder env
- `src/config.js` validates env vars with Zod at startup but only checks their **format**, not that credentials are real. It fails fast (throwing and listing every missing var) if any Supabase/S3/Paubox prerequisite is absent. The auto-created `.env` (from `.env.example`) satisfies the format checks, so the server boots and can exercise `/health`, the static UI (`public/index.html`), and PDF generation (`src/services/pdf-service.js`, a pure in-process function) without real credentials.
- External services are only contacted on `/api/*` requests. Full end-to-end of the API (create client/note, history, encrypted email) requires REAL credentials that are not in the repo:
  - Supabase (`SUPABASE_URL`, `SUPABASE_ANON_KEY`) with the schema from `supabase/migrations/001_initial_schema.sql` applied, plus a valid user JWT + organization UUID (entered in the UI's "Session context").
  - AWS S3 (`AWS_REGION`, `AWS_S3_BUCKET`, credentials) — `POST /api/soap-notes` returns HTTP 502 if the encrypted-PDF upload fails, so note creation cannot complete without a working bucket.
  - Paubox (`PAUBOX_API_KEY`, `PAUBOX_API_ENDPOINT`, `PAUBOX_FROM_EMAIL`) — only for `POST /api/soap-notes/:noteId/email`.
- Without those secrets you can still verify the environment: `npm test`, boot the server, `curl /health`, load the UI, and generate a SOAP-note PDF directly via `src/services/pdf-service.js`.
- `.env` is gitignored; never commit real credentials.
