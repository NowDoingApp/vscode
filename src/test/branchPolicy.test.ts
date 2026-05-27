import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  evaluateWatchIgnorePattern,
  getRetryDelayMs,
  isRetryableNotifyError,
} from "../util";

test("evaluateWatchIgnorePattern handles empty pattern", () => {
  const result = evaluateWatchIgnorePattern("", "main");
  assert.equal(result.invalidPattern, false);
  assert.equal(result.isIgnored, false);
});

test("evaluateWatchIgnorePattern matches configured regex", () => {
  const result = evaluateWatchIgnorePattern("^(main|develop)$", "main");
  assert.equal(result.invalidPattern, false);
  assert.equal(result.isIgnored, true);
});

test("evaluateWatchIgnorePattern reports invalid regex", () => {
  const result = evaluateWatchIgnorePattern("(", "main");
  assert.equal(result.invalidPattern, true);
  assert.equal(result.isIgnored, false);
});

test("getRetryDelayMs uses capped exponential backoff", () => {
  assert.equal(getRetryDelayMs(1), 1000);
  assert.equal(getRetryDelayMs(2), 2000);
  assert.equal(getRetryDelayMs(3), 4000);
  assert.equal(getRetryDelayMs(10), 30000);
});

test("isRetryableNotifyError identifies transient errors", () => {
  assert.equal(isRetryableNotifyError(new Error("HTTP 503: unavailable")), true);
  assert.equal(isRetryableNotifyError(new Error("ECONNREFUSED")), true);
  assert.equal(isRetryableNotifyError(new Error("timeout")), true);
});

test("isRetryableNotifyError ignores non-retryable errors", () => {
  assert.equal(isRetryableNotifyError(new Error("HTTP 401: unauthorized")), false);
  assert.equal(isRetryableNotifyError(new Error("HTTP 400: invalid json")), false);
});
