import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildActivitySearchPath,
  errorMessageFromResponse,
  formatError,
  parseJson,
} from "../util";

test("parseJson returns the decoded value for valid JSON", () => {
  const result = parseJson<{ a: number }>('{"a":1}');
  assert.deepEqual(result, { a: 1 });
});

test("parseJson returns undefined for empty or whitespace-only input", () => {
  assert.equal(parseJson(""), undefined);
  assert.equal(parseJson("   \n\t"), undefined);
});

test("parseJson returns undefined for malformed JSON instead of throwing", () => {
  assert.equal(parseJson("{not json"), undefined);
  assert.equal(parseJson("undefined"), undefined);
});

test("errorMessageFromResponse uses the body's error field when present", () => {
  const msg = errorMessageFromResponse(409, '{"error":"replay detected"}');
  assert.equal(msg, "HTTP 409: replay detected");
});

test("errorMessageFromResponse falls back to status when body has no error field", () => {
  assert.equal(errorMessageFromResponse(500, ""), "HTTP 500");
  assert.equal(errorMessageFromResponse(500, "not json"), "HTTP 500");
  assert.equal(errorMessageFromResponse(500, '{"other":"x"}'), "HTTP 500");
});

test("formatError unwraps Error instances", () => {
  assert.equal(formatError(new Error("boom")), "boom");
});

test("formatError stringifies non-Error values", () => {
  assert.equal(formatError("plain string"), "plain string");
  assert.equal(formatError(42), "42");
  assert.equal(formatError(undefined), "undefined");
  assert.equal(formatError(null), "null");
});

test("buildActivitySearchPath URL-encodes the query and appends the limit", () => {
  assert.equal(
    buildActivitySearchPath("/activities/search", "review PRs", 20),
    "/activities/search?q=review%20PRs&limit=20"
  );
});

test("buildActivitySearchPath escapes characters that would break query parsing", () => {
  // Ampersand and equals in the query must not leak into the query structure
  const path = buildActivitySearchPath("/activities/search", "a&b=c", 10);
  assert.equal(path, "/activities/search?q=a%26b%3Dc&limit=10");
});

test("buildActivitySearchPath handles an empty query without producing an unkeyed param", () => {
  assert.equal(
    buildActivitySearchPath("/activities/search", "", 50),
    "/activities/search?q=&limit=50"
  );
});

test("buildActivitySearchPath encodes unicode safely", () => {
  const path = buildActivitySearchPath("/activities/search", "café", 5);
  assert.equal(path, "/activities/search?q=caf%C3%A9&limit=5");
});
