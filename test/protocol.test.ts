import { test } from "node:test";
import assert from "node:assert/strict";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { createServer } from "../src/server.js";
import { READY, makeDeps, mockFetch } from "./helpers.js";

async function connect(fetchReplies: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(fetchReplies);
  const deps = makeDeps(m.fetch);
  const server = createServer(deps);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return { client, server, m };
}

test("tools/list exposes four tools with schemas and annotations", async () => {
  const { client, server } = await connect([]);
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ["get_balance", "get_task", "list_captcha_types", "solve_captcha"]);

  const solve = byName.solve_captcha!;
  assert.equal(solve.annotations?.readOnlyHint, false);
  assert.equal(solve.annotations?.destructiveHint, false);
  assert.equal(solve.annotations?.openWorldHint, true);
  const props = (solve.inputSchema as { properties: Record<string, { enum?: string[] }>; required?: string[] }).properties;
  assert.deepEqual(props.type?.enum, ["recaptcha_v2", "recaptcha_v3", "recaptcha_enterprise", "turnstile", "datadome", "image"]);
  assert.ok(!("apiKey" in props) && !("api_key" in props), "the API key is never a tool argument");
  assert.ok(solve.outputSchema);

  assert.equal(byName.get_balance!.annotations?.readOnlyHint, true);
  assert.equal(byName.get_task!.annotations?.readOnlyHint, true);
  assert.equal(byName.list_captcha_types!.annotations?.openWorldHint, false);
  for (const t of tools) assert.ok((t.description ?? "").length > 80, `${t.name} needs an LLM-friendly description`);
  await client.close();
  await server.close();
});

test("tools/call round-trips structured content and error results", async () => {
  const { client, server, m } = await connect([{ status: 200, body: READY("p1") }]);

  const types = await client.callTool({ name: "list_captcha_types", arguments: {} });
  assert.equal(types.isError, undefined);
  assert.ok(Array.isArray((types.structuredContent as { types: unknown[] }).types));

  const solved = await client.callTool({
    name: "solve_captcha",
    arguments: { type: "recaptcha_v2", url: "https://example.com", sitekey: "k" },
  });
  assert.notEqual(solved.isError, true);
  assert.equal((solved.structuredContent as { token: string }).token, "03AFcWeA-token");

  const invalid = await client.callTool({ name: "solve_captcha", arguments: { type: "turnstile", url: "https://example.com" } });
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /sitekey is required/);

  const schemaErr = await client.callTool({ name: "solve_captcha", arguments: { type: "hcaptcha" } });
  assert.equal(schemaErr.isError, true);

  assert.equal(m.calls.length, 1);
  await client.close();
  await server.close();
});
