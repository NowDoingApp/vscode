import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface APICapability {
  version: number;
  socketPath: string;
  token: string;
  pid: number;
}

/// Path of the discovery file the Mac app writes alongside the loopback API
/// socket. Lives inside the sandbox container's `Data/` directory.
export function capabilityFilePath(): string {
  return path.join(
    os.homedir(),
    "Library/Containers/com.mattes.nowdoing/Data/api-endpoint.json"
  );
}

/// Reads and validates the capability file. Throws if the file is missing,
/// unreadable, malformed, or has an unexpected version. Callers should treat
/// any exception as "NowDoing is not currently reachable".
export function readCapability(
  filePath: string = capabilityFilePath()
): APICapability {
  const raw = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("capability file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("capability file is not an object");
  }
  const candidate = parsed as Record<string, unknown>;
  const version = candidate.version;
  const socketPath = candidate.socketPath;
  const token = candidate.token;
  const pid = candidate.pid;
  if (typeof version !== "number" || version !== 1) {
    throw new Error(`unsupported capability version: ${String(version)}`);
  }
  if (typeof socketPath !== "string" || socketPath.length === 0) {
    throw new Error("capability file missing socketPath");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("capability file missing token");
  }
  if (typeof pid !== "number" || !Number.isInteger(pid)) {
    throw new Error("capability file missing pid");
  }
  return { version, socketPath, token, pid };
}
