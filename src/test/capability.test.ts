import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { capabilityFilePath, readCapability } from "../capability";

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowdoing-cap-"));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCap(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("capabilityFilePath points at the sandbox container under the user home", () => {
  const cap = capabilityFilePath();
  assert.ok(cap.startsWith(os.homedir()), "must live under home");
  assert.ok(
    cap.endsWith(
      "Library/Containers/com.mattes.nowdoing/Data/api-endpoint.json"
    ),
    `unexpected tail: ${cap}`
  );
});

test("readCapability parses a well-formed file", () => {
  const file = writeCap(
    "ok.json",
    JSON.stringify({
      version: 1,
      socketPath: "/tmp/api.sock",
      token: "abc",
      pid: 4242,
    })
  );
  const cap = readCapability(file);
  assert.deepEqual(cap, {
    version: 1,
    socketPath: "/tmp/api.sock",
    token: "abc",
    pid: 4242,
  });
});

test("readCapability throws when the file is missing", () => {
  assert.throws(() =>
    readCapability(path.join(tmpDir, "does-not-exist.json"))
  );
});

test("readCapability rejects invalid JSON", () => {
  const file = writeCap("garbage.json", "not-json{");
  assert.throws(() => readCapability(file), /not valid JSON/);
});

test("readCapability rejects an unsupported version", () => {
  const file = writeCap(
    "v2.json",
    JSON.stringify({ version: 2, socketPath: "/x", token: "t", pid: 1 })
  );
  assert.throws(() => readCapability(file), /unsupported capability version/);
});

test("readCapability rejects an empty socketPath", () => {
  const file = writeCap(
    "no-sock.json",
    JSON.stringify({ version: 1, socketPath: "", token: "t", pid: 1 })
  );
  assert.throws(() => readCapability(file), /socketPath/);
});

test("readCapability rejects an empty token", () => {
  const file = writeCap(
    "no-token.json",
    JSON.stringify({ version: 1, socketPath: "/x", token: "", pid: 1 })
  );
  assert.throws(() => readCapability(file), /token/);
});

test("readCapability rejects a missing pid", () => {
  const file = writeCap(
    "no-pid.json",
    JSON.stringify({ version: 1, socketPath: "/x", token: "t" })
  );
  assert.throws(() => readCapability(file), /pid/);
});
