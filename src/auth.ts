import * as crypto from "crypto";

export interface AuthHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export function buildAuthHeaders(
  method: "GET" | "POST",
  requestPath: string,
  payload: Buffer | undefined,
  token: string,
  now: () => number = Date.now,
  randomBytes: (size: number) => Buffer = crypto.randomBytes
): AuthHeaders {
  const timestamp = Math.floor(now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  return {
    timestamp,
    nonce,
    signature: signRequest(method, requestPath, payload, token, timestamp, nonce),
  };
}

export function signRequest(
  method: "GET" | "POST",
  requestPath: string,
  payload: Buffer | undefined,
  token: string,
  timestamp: string,
  nonce: string
): string {
  const bodyHash = crypto
    .createHash("sha256")
    .update(payload ?? Buffer.alloc(0))
    .digest("hex");
  const canonical = [method, requestPath, timestamp, nonce, bodyHash].join("\n");
  return crypto.createHmac("sha256", token).update(canonical).digest("hex");
}
