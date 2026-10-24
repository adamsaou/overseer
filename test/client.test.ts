import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, beforeEach, test } from "node:test";
import { ANTHROPIC_API, apiBase, checkGateway } from "../lib/client.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "overseer-test-"));
const config = (value: object) => writeFileSync(path.join(home, "config.json"), JSON.stringify(value));
const saved = { ...process.env };
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  for (const name of ["ANTHROPIC_BASE_URL", "NODE_TLS_REJECT_UNAUTHORIZED"]) delete process.env[name];
  rmSync(path.join(home, "config.json"), { force: true });
});
after(() => Object.assign(process.env, saved));

test("the key goes to the Anthropic API by default", () => {
  assert.equal(apiBase(home), ANTHROPIC_API);
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/";
  assert.equal(apiBase(home), ANTHROPIC_API);
});

test("an ANTHROPIC_BASE_URL nobody allowed is refused, naming the fix", () => {
  process.env.ANTHROPIC_BASE_URL = "https://collector.example.net/v1";
  assert.throws(() => apiBase(home), (err: Error & { code?: string; fatal?: boolean }) => {
    assert.equal(err.code, "UNSAFE_ENV");
    assert.equal(err.fatal, true);
    assert.match(err.message, /collector\.example\.net/);
    assert.match(err.message, /"gateway": "https:\/\/collector\.example\.net\/v1"/);
    return true;
  });
  // Not even a look-alike of the Anthropic address passes.
  process.env.ANTHROPIC_BASE_URL = "http://api.anthropic.com";
  assert.throws(() => apiBase(home));
  process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com.example.net";
  assert.throws(() => apiBase(home));
});

test("a gateway in config.json is used, and allows the same ANTHROPIC_BASE_URL", () => {
  config({ gateway: "https://llm.example.com/anthropic/" });
  assert.equal(apiBase(home), "https://llm.example.com/anthropic");
  process.env.ANTHROPIC_BASE_URL = "https://llm.example.com/anthropic";
  assert.equal(apiBase(home), "https://llm.example.com/anthropic");
  process.env.ANTHROPIC_BASE_URL = ANTHROPIC_API;
  assert.equal(apiBase(home), ANTHROPIC_API);
  process.env.ANTHROPIC_BASE_URL = "https://llm.example.com/other";
  assert.throws(() => apiBase(home), /your gateway, https:\/\/llm\.example\.com\/anthropic/);
});

test("a gateway must be https, except on this machine", () => {
  assert.equal(checkGateway("http://localhost:4000", "x"), "http://localhost:4000");
  assert.equal(checkGateway("http://127.0.0.1:4000/", "x"), "http://127.0.0.1:4000");
  assert.throws(() => checkGateway("http://llm.example.com", "x"), /https:\/\//);
  assert.throws(() => checkGateway("https://user:pw@llm.example.com", "x"));
  assert.throws(() => checkGateway("ftp://llm.example.com", "x"));
  config({ gateway: "http://llm.example.com" });
  assert.throws(() => apiBase(home), /has to start with https/);
});

test("turning off certificate checks stops every request", () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  assert.throws(() => apiBase(home), /NODE_TLS_REJECT_UNAUTHORIZED/);
});
