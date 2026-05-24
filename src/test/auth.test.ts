import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { test } from "node:test";
import { buildAuthHeaders, signRequest } from "../auth";

const TOKEN = "test-token-please-ignore-1234567890abcdef";

test("buildAuthHeaders uses the injected clock and RNG", () => {
  const fixedNow = 1_700_000_000_000;
  const fixedNonce = Buffer.alloc(16, 0xab);

  const headers = buildAuthHeaders(
    "GET",
    "/healthcheck",
    undefined,
    TOKEN,
    () => fixedNow,
    () => fixedNonce
  );

  assert.equal(headers.timestamp, "1700000000");
  assert.equal(headers.nonce, fixedNonce.toString("hex"));
  assert.equal(headers.nonce.length, 32);
});

test("buildAuthHeaders produces a 16-byte nonce by default", () => {
  const headers = buildAuthHeaders("GET", "/healthcheck", undefined, TOKEN);
  assert.equal(headers.nonce.length, 32);
  assert.match(headers.nonce, /^[0-9a-f]+$/);
});

test("buildAuthHeaders timestamp tracks seconds since epoch", () => {
  const before = Math.floor(Date.now() / 1000);
  const headers = buildAuthHeaders("POST", "/branch-changed", undefined, TOKEN);
  const after = Math.floor(Date.now() / 1000);
  const ts = Number(headers.timestamp);
  assert.ok(Number.isInteger(ts), "timestamp must be an integer");
  assert.ok(ts >= before && ts <= after, "timestamp must be within now +/-1s");
});

test("signRequest matches the canonical HMAC-SHA256 of the request fields", () => {
  const timestamp = "1700000000";
  const nonce = "deadbeefdeadbeefdeadbeefdeadbeef";
  const payload = Buffer.from(JSON.stringify({ branch: "main" }), "utf8");

  const actual = signRequest(
    "POST",
    "/branch-changed",
    payload,
    TOKEN,
    timestamp,
    nonce
  );

  const bodyHash = crypto.createHash("sha256").update(payload).digest("hex");
  const canonical = [
    "POST",
    "/branch-changed",
    timestamp,
    nonce,
    bodyHash,
  ].join("\n");
  const expected = crypto
    .createHmac("sha256", TOKEN)
    .update(canonical)
    .digest("hex");

  assert.equal(actual, expected);
});

test("signRequest hashes empty body as sha256('')", () => {
  const emptyHash = crypto.createHash("sha256").update("").digest("hex");
  const timestamp = "1700000000";
  const nonce = "00000000000000000000000000000000";

  const sig = signRequest("GET", "/healthcheck", undefined, TOKEN, timestamp, nonce);

  const canonical = ["GET", "/healthcheck", timestamp, nonce, emptyHash].join("\n");
  const expected = crypto
    .createHmac("sha256", TOKEN)
    .update(canonical)
    .digest("hex");
  assert.equal(sig, expected);
});

test("signRequest is sensitive to method, path, body, timestamp, nonce and token", () => {
  const base: {
    method: "GET" | "POST";
    path: string;
    body: Buffer;
    token: string;
    ts: string;
    nonce: string;
  } = {
    method: "POST",
    path: "/branch-changed",
    body: Buffer.from("{}", "utf8"),
    token: TOKEN,
    ts: "1700000000",
    nonce: "deadbeefdeadbeefdeadbeefdeadbeef",
  };
  const sig = (overrides: Partial<typeof base>) => {
    const o = { ...base, ...overrides };
    return signRequest(o.method, o.path, o.body, o.token, o.ts, o.nonce);
  };

  const baseline = sig({});
  assert.notEqual(baseline, sig({ method: "GET" }));
  assert.notEqual(baseline, sig({ path: "/healthcheck" }));
  assert.notEqual(baseline, sig({ body: Buffer.from("{ }", "utf8") }));
  assert.notEqual(baseline, sig({ ts: "1700000001" }));
  assert.notEqual(baseline, sig({ nonce: "11111111111111111111111111111111" }));
  assert.notEqual(baseline, sig({ token: TOKEN + "x" }));
});
