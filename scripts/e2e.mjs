#!/usr/bin/env node
// End-to-end protocol check against the BUILT server (dist/index.js):
//  1. stdio: spawn the server with a dummy key, list tools, call
//     list_captcha_types and get_balance (expects a clean invalid_api_key result
//     from the real API).
//  2. http: start `--http` on a free port, list tools and call list_captcha_types
//     over Streamable HTTP.
//  3. live: only when CAPTCHANO_TEST_API_KEY is set, solve the public reCAPTCHA
//     v2 demo once. The key is passed via env and never printed.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const DUMMY_KEY = "cn-e2e-dummy-not-a-real-key";
const text = (r) => (r.content ?? []).map((c) => c.text ?? "").join("\n");
const ok = (m) => console.log(`  ok  ${m}`);

async function stdioCheck() {
  console.log("stdio transport");
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...getDefaultEnvironment(), CAPTCHANO_API_KEY: DUMMY_KEY },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => stderr.push(String(d)));
  const client = new Client({ name: "captchano-e2e", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["get_balance", "get_task", "list_captcha_types", "solve_captcha"]);
  ok(`tools/list -> ${tools.map((t) => t.name).join(", ")}`);

  const types = await client.callTool({ name: "list_captcha_types", arguments: {} });
  assert.notEqual(types.isError, true);
  ok(`list_captcha_types -> ${types.structuredContent.types.length} types`);

  const bal = await client.callTool({ name: "get_balance", arguments: {} });
  assert.equal(bal.isError, true, "dummy key must produce an error result");
  assert.equal(bal.structuredContent?.error?.code, "invalid_api_key", `got: ${text(bal)}`);
  ok(`get_balance (dummy key) -> isError, ${text(bal).split("\n")[0]}`);

  await client.close();
  const logs = stderr.join("");
  assert.ok(!logs.includes(DUMMY_KEY.slice(3)), "the key must never appear in logs");
  ok("key absent from stderr logs");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function httpCheck() {
  console.log("streamable http transport (--http)");
  const port = await freePort();
  const child = spawn(process.execPath, [entry, "--http", "--port", String(port)], {
    env: { ...process.env, CAPTCHANO_API_KEY: DUMMY_KEY, CAPTCHANO_TEST_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("http server did not start")), 10_000);
      child.stderr.on("data", (d) => {
        if (String(d).includes("listening")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.once("exit", (c) => reject(new Error(`server exited ${c}`)));
    });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
    assert.equal(health.ok, true);
    ok("GET /healthz");

    const client = new Client({ name: "captchano-e2e-http", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const { tools } = await client.listTools();
    assert.equal(tools.length, 4);
    ok(`tools/list -> ${tools.length} tools`);
    const types = await client.callTool({ name: "list_captcha_types", arguments: {} });
    assert.notEqual(types.isError, true);
    ok("list_captcha_types");
    const bal = await client.callTool({ name: "get_balance", arguments: {} });
    assert.equal(bal.structuredContent?.error?.code, "invalid_api_key");
    ok("get_balance (dummy key) -> invalid_api_key");
    await client.close();
    assert.equal(stdout, "", "nothing may be written to stdout");
  } finally {
    child.kill("SIGTERM");
  }
}

async function liveCheck() {
  const key = process.env.CAPTCHANO_TEST_API_KEY;
  if (!key) {
    console.log("live solve: SKIPPED (CAPTCHANO_TEST_API_KEY not set)");
    return;
  }
  console.log("live solve (recaptcha_v2 demo)");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...getDefaultEnvironment(), CAPTCHANO_API_KEY: key, CAPTCHANO_MAX_SPEND_USD: "0.05" },
    stderr: "ignore",
  });
  const client = new Client({ name: "captchano-e2e-live", version: "1.0.0" });
  await client.connect(transport);
  const r = await client.callTool(
    {
      name: "solve_captcha",
      arguments: {
        type: "recaptcha_v2",
        url: "https://www.google.com/recaptcha/api2/demo",
        sitekey: "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-",
      },
    },
    undefined,
    { timeout: 180_000 }
  );
  const sc = r.structuredContent ?? {};
  if (r.isError) {
    console.log(`  FAIL ${text(r).split("\n").slice(0, 2).join(" | ")}`);
    process.exitCode = 1;
  } else {
    assert.equal(sc.status, "ready");
    ok(`solved: task ${sc.id}, token length ${sc.token?.length ?? 0}, cost $${sc.cost}, solveTime ${sc.solveTime}`);
  }
  await client.close();
}

try {
  await stdioCheck();
  await httpCheck();
  await liveCheck();
  console.log(process.exitCode ? "e2e: FAILED" : "e2e: all checks passed");
} catch (err) {
  console.error("e2e: FAILED", err);
  process.exit(1);
}
