import test from "node:test";
import assert from "node:assert/strict";

import { sanitizeIlikeTerm } from "../src/lib/request-helpers.js";
import {
  createClientSchema,
  emailNoteInputSchema,
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
  assert.equal(sanitizeIlikeTerm("john_100%"), "john\\_100\\%");
});
