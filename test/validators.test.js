import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeIlikeTerm } from "../src/lib/request-helpers.js";
import {
  createClientSchema,
  downloadUrlQuerySchema,
  emailAuditQuerySchema,
  emailJobQuerySchema,
  emailNoteInputSchema,
  grantClientAccessSchema,
  historyQuerySchema,
  queueEmailRequestSchema,
  soapNoteInputSchema,
} from "../src/lib/validators.js";

test("soapNoteInputSchema accepts complete SOAP payload", () => {
  const result = soapNoteInputSchema.safeParse({
    clientId: "550e8400-e29b-41d4-a716-446655440000",
    sessionAt: new Date().toISOString(),
    subjective: "Client reports mild soreness.",
    objective: "Palpation noted tension in right trapezius.",
    assessment: "Likely overuse-related strain.",
    plan: "Continue weekly myofascial treatment and stretching.",
  });

  assert.equal(result.success, true);
});

test("createClientSchema rejects invalid email", () => {
  const result = createClientSchema.safeParse({
    firstName: "Sam",
    lastName: "Lee",
    email: "not-an-email",
  });

  assert.equal(result.success, false);
});

test("emailNoteInputSchema allows empty payload for default destination", () => {
  const result = emailNoteInputSchema.safeParse({});
  assert.equal(result.success, true);
});

test("sanitizeIlikeTerm escapes wildcard characters", () => {
  assert.equal(sanitizeIlikeTerm("john_100%(a,b)"), "john\\_100\\%\\(a\\,b\\)");
});

test("historyQuerySchema defaults scope to organization", () => {
  const result = historyQuerySchema.safeParse({
    limit: 25,
  });
  assert.equal(result.success, true);
  assert.equal(result.data.scope, "organization");
});

test("grantClientAccessSchema accepts viewer and editor permission", () => {
  const viewer = grantClientAccessSchema.safeParse({
    therapistId: "550e8400-e29b-41d4-a716-446655440000",
    permission: "viewer",
  });
  const editor = grantClientAccessSchema.safeParse({
    therapistId: "550e8400-e29b-41d4-a716-446655440000",
    permission: "editor",
  });
  assert.equal(viewer.success, true);
  assert.equal(editor.success, true);
});

test("emailAuditQuerySchema validates optional status filter", () => {
  const result = emailAuditQuerySchema.safeParse({
    status: "failed",
    limit: 10,
  });
  assert.equal(result.success, true);
});

test("queueEmailRequestSchema accepts empty and explicit destination payload", () => {
  const empty = queueEmailRequestSchema.safeParse({});
  const explicit = queueEmailRequestSchema.safeParse({
    destinationEmail: "client@example.com",
  });
  assert.equal(empty.success, true);
  assert.equal(explicit.success, true);
});

test("emailJobQuerySchema validates known status values", () => {
  const result = emailJobQuerySchema.safeParse({
    status: "retry_pending",
    limit: 15,
  });
  assert.equal(result.success, true);
});

test("downloadUrlQuerySchema constrains signed URL ttl range", () => {
  const ok = downloadUrlQuerySchema.safeParse({
    expiresInSeconds: 120,
  });
  const fail = downloadUrlQuerySchema.safeParse({
    expiresInSeconds: 10,
  });
  assert.equal(ok.success, true);
  assert.equal(fail.success, false);
});
