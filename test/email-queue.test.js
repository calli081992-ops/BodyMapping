import test from "node:test";
import assert from "node:assert/strict";

import { env } from "../src/config.js";
import { computeBackoffSeconds } from "../src/services/email-queue.js";

test("computeBackoffSeconds grows exponentially from the base", () => {
  assert.equal(computeBackoffSeconds(1, 60), 60); // 60 * 2^0
  assert.equal(computeBackoffSeconds(2, 60), 120); // 60 * 2^1
  assert.equal(computeBackoffSeconds(3, 60), 240); // 60 * 2^2
});

test("computeBackoffSeconds treats attempt 0 like the first attempt", () => {
  assert.equal(computeBackoffSeconds(0, 60), 60);
});

test("computeBackoffSeconds caps at 24 hours", () => {
  assert.equal(computeBackoffSeconds(100, 60), 24 * 60 * 60);
});

test("email queue config is parsed with correct types/defaults", () => {
  assert.equal(env.EMAIL_QUEUE_ENABLED, false); // .env sets EMAIL_QUEUE_ENABLED=false
  assert.equal(typeof env.EMAIL_QUEUE_ENABLED, "boolean");
  assert.equal(env.EMAIL_QUEUE_BATCH_SIZE, 10);
  assert.equal(env.EMAIL_QUEUE_MAX_ATTEMPTS, 5);
  assert.equal(env.EMAIL_QUEUE_POLL_INTERVAL_MS, 15000);
  assert.equal(env.EMAIL_QUEUE_BACKOFF_BASE_SECONDS, 60);
  assert.equal(env.EMAIL_QUEUE_LOCK_TIMEOUT_SECONDS, 300);
  assert.equal(env.PDF_DOWNLOAD_URL_TTL_SECONDS, 3600);
  assert.equal(typeof env.PDF_DOWNLOAD_URL_TTL_SECONDS, "number");
});
