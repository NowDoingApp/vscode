import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as http from "node:http";
import { after, before, test } from "node:test";
import { buildAuthHeaders } from "../auth";

// A TypeScript port of the Swift `BranchChangeServer` verification rules,
// kept intentionally close to the original so this test pins the wire format
// the Mac app expects. If the Swift side changes, mirror the change here.
//
// Source of truth: NowDoing/BranchChangeServer.swift (validateReplayProtection
// and requestSignature).

const MAX_TIMESTAMP_DRIFT_SECONDS = 60;
const TOKEN = "test-token-please-ignore-1234567890abcdef";

function isValidNonce(nonce: string): boolean {
  if (nonce.length < 16 || nonce.length > 128) return false;
  return /^[a-z0-9]+$/i.test(nonce);
}

function isValidSignatureFormat(sig: string): boolean {
  return /^[0-9a-f]{64}$/.test(sig);
}

function recomputeSignature(
  token: string,
  method: string,
  target: string,
  timestamp: string,
  nonce: string,
  body: Buffer
): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method, target, timestamp, nonce, bodyHash].join("\n");
  return crypto.createHmac("sha256", token).update(canonical).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

interface VerifierState {
  seenNonces: Set<string>;
  now: () => number;
}

function verify(
  state: VerifierState,
  req: http.IncomingMessage,
  body: Buffer
): { status: number; message?: string } {
  const headers = req.headers;
  const timestampRaw = String(headers["x-nowdoing-timestamp"] ?? "");
  // Mirror Swift's `Int64(timestampRaw)` which rejects empty strings and any
  // non-integer text. Number("") is 0 in JS, so we must guard explicitly.
  if (!/^-?\d+$/.test(timestampRaw)) {
    return { status: 401, message: "invalid timestamp" };
  }
  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp)) {
    return { status: 401, message: "invalid timestamp" };
  }
  const now = state.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_SECONDS) {
    return { status: 401, message: "expired timestamp" };
  }

  const nonce = String(headers["x-nowdoing-nonce"] ?? "")
    .trim()
    .toLowerCase();
  if (!isValidNonce(nonce)) {
    return { status: 401, message: "invalid nonce" };
  }
  if (state.seenNonces.has(nonce)) {
    return { status: 409, message: "replay detected" };
  }

  const sig = String(headers["x-nowdoing-signature"] ?? "")
    .trim()
    .toLowerCase();
  if (!isValidSignatureFormat(sig)) {
    return { status: 401, message: "invalid signature" };
  }

  const expected = recomputeSignature(
    TOKEN,
    req.method ?? "",
    req.url ?? "",
    timestampRaw,
    nonce,
    body
  );
  if (!constantTimeEquals(sig, expected)) {
    return { status: 401, message: "bad signature" };
  }

  state.seenNonces.add(nonce);
  return { status: 200 };
}

let server: http.Server;
let baseUrl: string;
const verifierState: VerifierState = {
  seenNonces: new Set(),
  now: () => Math.floor(Date.now() / 1000),
};

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const result = verify(verifierState, req, body);
      res.statusCode = result.status;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          result.message ? { error: result.message } : { ok: true }
        )
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve())
  );
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface RawResponse {
  status: number;
  body: string;
}

function rawRequest(
  method: "GET" | "POST",
  requestPath: string,
  headers: Record<string, string>,
  payload?: Buffer
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname + url.search,
        method,
        headers: {
          ...headers,
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(payload.byteLength),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sendSigned(
  method: "GET" | "POST",
  requestPath: string,
  payload?: Buffer
): Promise<RawResponse> {
  const headers = buildAuthHeaders(method, requestPath, payload, TOKEN);
  return rawRequest(
    method,
    requestPath,
    {
      "X-NowDoing-Token": TOKEN,
      "X-NowDoing-Timestamp": headers.timestamp,
      "X-NowDoing-Nonce": headers.nonce,
      "X-NowDoing-Signature": headers.signature,
    },
    payload
  );
}

test("a freshly signed request from buildAuthHeaders passes verification", async () => {
  const res = await sendSigned("GET", "/healthcheck");
  assert.equal(res.status, 200);
});

test("a signed POST with a JSON body verifies end-to-end", async () => {
  const body = Buffer.from(JSON.stringify({ branch: "main" }), "utf8");
  const res = await sendSigned("POST", "/branch-changed", body);
  assert.equal(res.status, 200);
});

test("the canonical includes the querystring — signing without it is rejected", async () => {
  // Sign the bare path, then send to a URL with a query — the verifier
  // recomputes against req.url (with query), so the signatures will diverge.
  const signedPath = "/activities/search";
  const sentPath = "/activities/search?q=foo&limit=20";
  const headers = buildAuthHeaders("GET", signedPath, undefined, TOKEN);
  const res = await rawRequest("GET", sentPath, {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": headers.timestamp,
    "X-NowDoing-Nonce": headers.nonce,
    "X-NowDoing-Signature": headers.signature,
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /bad signature/);
});

test("a tampered body fails verification even with valid headers", async () => {
  const original = Buffer.from(JSON.stringify({ branch: "main" }), "utf8");
  const tampered = Buffer.from(JSON.stringify({ branch: "evil" }), "utf8");
  const headers = buildAuthHeaders("POST", "/branch-changed", original, TOKEN);
  const res = await rawRequest(
    "POST",
    "/branch-changed",
    {
      "X-NowDoing-Token": TOKEN,
      "X-NowDoing-Timestamp": headers.timestamp,
      "X-NowDoing-Nonce": headers.nonce,
      "X-NowDoing-Signature": headers.signature,
    },
    tampered
  );
  assert.equal(res.status, 401);
  assert.match(res.body, /bad signature/);
});

test("a stale timestamp (drift > 60s) is rejected as expired", async () => {
  const stale = Math.floor(Date.now() / 1000) - 120;
  const headers = buildAuthHeaders(
    "GET",
    "/healthcheck",
    undefined,
    TOKEN,
    () => stale * 1000
  );
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": headers.timestamp,
    "X-NowDoing-Nonce": headers.nonce,
    "X-NowDoing-Signature": headers.signature,
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /expired timestamp/);
});

test("reusing a nonce within the TTL is rejected as replay (409)", async () => {
  const fixedNonce = Buffer.from("11223344556677889900aabbccddeeff", "hex");
  const sign = () =>
    buildAuthHeaders(
      "GET",
      "/healthcheck",
      undefined,
      TOKEN,
      Date.now,
      () => fixedNonce
    );

  const first = sign();
  const res1 = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": first.timestamp,
    "X-NowDoing-Nonce": first.nonce,
    "X-NowDoing-Signature": first.signature,
  });
  assert.equal(res1.status, 200);

  // Second request: same nonce, fresh timestamp + signature.
  const second = sign();
  const res2 = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": second.timestamp,
    "X-NowDoing-Nonce": second.nonce,
    "X-NowDoing-Signature": second.signature,
  });
  assert.equal(res2.status, 409);
  assert.match(res2.body, /replay detected/);
});

test("the buildAuthHeaders nonce satisfies the Swift verifier's format rules", () => {
  const { nonce } = buildAuthHeaders("GET", "/healthcheck", undefined, TOKEN);
  assert.ok(isValidNonce(nonce), `nonce ${nonce} must pass server validation`);
});

// --- Boundary cases ----------------------------------------------------------

function freshNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

test("a missing timestamp header is rejected as invalid", async () => {
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Nonce": freshNonce(),
    "X-NowDoing-Signature": "0".repeat(64),
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /invalid timestamp/);
});

test("a non-integer timestamp is rejected as invalid", async () => {
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": "not-a-number",
    "X-NowDoing-Nonce": freshNonce(),
    "X-NowDoing-Signature": "0".repeat(64),
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /invalid timestamp/);
});

test("a timestamp exactly at the 60-second drift boundary is accepted", async () => {
  // Swift: `if drift > 60` — so drift == 60 must pass.
  const skewedClock = () => (Math.floor(Date.now() / 1000) - 60) * 1000;
  const headers = buildAuthHeaders(
    "GET",
    "/healthcheck",
    undefined,
    TOKEN,
    skewedClock
  );
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": headers.timestamp,
    "X-NowDoing-Nonce": headers.nonce,
    "X-NowDoing-Signature": headers.signature,
  });
  assert.equal(res.status, 200);
});

test("a timestamp 61 seconds in the past is rejected as expired", async () => {
  const skewedClock = () => (Math.floor(Date.now() / 1000) - 61) * 1000;
  const headers = buildAuthHeaders(
    "GET",
    "/healthcheck",
    undefined,
    TOKEN,
    skewedClock
  );
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": headers.timestamp,
    "X-NowDoing-Nonce": headers.nonce,
    "X-NowDoing-Signature": headers.signature,
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /expired timestamp/);
});

test("a nonce shorter than 16 chars is rejected as invalid", async () => {
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": String(Math.floor(Date.now() / 1000)),
    "X-NowDoing-Nonce": "deadbeefdeadbee", // 15 chars
    "X-NowDoing-Signature": "0".repeat(64),
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /invalid nonce/);
});

test("a nonce with non-alphanumeric characters is rejected as invalid", async () => {
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": String(Math.floor(Date.now() / 1000)),
    "X-NowDoing-Nonce": "deadbeef-deadbeef-deadbeef-dead", // hyphens
    "X-NowDoing-Signature": "0".repeat(64),
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /invalid nonce/);
});

test("a signature of wrong length is rejected as invalid format", async () => {
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": String(Math.floor(Date.now() / 1000)),
    "X-NowDoing-Nonce": freshNonce(),
    "X-NowDoing-Signature": "deadbeef", // too short
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /invalid signature/);
});

test("a signature with non-hex characters is rejected as invalid format", async () => {
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": String(Math.floor(Date.now() / 1000)),
    "X-NowDoing-Nonce": freshNonce(),
    "X-NowDoing-Signature": "z".repeat(64),
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /invalid signature/);
});

test("an uppercase-hex signature is accepted (server lowercases before compare)", async () => {
  const headers = buildAuthHeaders("GET", "/healthcheck", undefined, TOKEN);
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": headers.timestamp,
    "X-NowDoing-Nonce": headers.nonce,
    "X-NowDoing-Signature": headers.signature.toUpperCase(),
  });
  assert.equal(res.status, 200);
});

test("a signature signed with the wrong token is rejected as a bad signature", async () => {
  const headers = buildAuthHeaders("GET", "/healthcheck", undefined, "WRONG-TOKEN");
  const res = await rawRequest("GET", "/healthcheck", {
    "X-NowDoing-Token": TOKEN,
    "X-NowDoing-Timestamp": headers.timestamp,
    "X-NowDoing-Nonce": headers.nonce,
    "X-NowDoing-Signature": headers.signature,
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /bad signature/);
});

test("a POST with an empty body signs and verifies correctly", async () => {
  // sha256("") must be used as the body hash — easy to mis-implement.
  const res = await sendSigned("POST", "/branch-changed", Buffer.alloc(0));
  assert.equal(res.status, 200);
});
