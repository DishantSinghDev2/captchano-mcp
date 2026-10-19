import { test } from "node:test";
import assert from "node:assert/strict";

import { Budget } from "../src/budget.js";
import { API_ERROR_CODES, hintFor } from "../src/errors.js";
import { redact } from "../src/log.js";
import { handleGetBalance, handleGetTask, handleListTypes, handleSolve } from "../src/server.js";
import { FAKE_KEY, READY, SOLVING, V2_ARGS, fakeClock, makeDeps, mockFetch, textOf } from "./helpers.js";

type SC = Record<string, unknown> & { error?: { code: string; message: string; hint?: string } };
const sc = (r: { structuredContent?: unknown }) => r.structuredContent as SC;

// ------------------------------------------------------------ happy path

test("ready on first response: request shape, auth header, structured + text output", async () => {
  const m = mockFetch([{ status: 200, body: READY() }]);
  const deps = makeDeps(m.fetch, { waitSeconds: 45 });
  const r = await handleSolve({ ...V2_ARGS, userAgent: "UA/1" }, deps);

  assert.equal(r.isError, undefined);
  assert.equal(m.calls.length, 1);
  const call = m.calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.example.test/v1/solve?wait=45");
  assert.equal(call.headers.authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(call.headers["content-type"], "application/json");
  assert.deepEqual(call.body, { type: "recaptcha_v2", url: V2_ARGS.url, sitekey: V2_ARGS.sitekey, userAgent: "UA/1" });

  assert.equal(sc(r).token, "03AFcWeA-token");
  assert.equal(sc(r).cost, "0.00285");
  assert.equal(sc(r).status, "ready");
  const text = textOf(r);
  assert.match(text, /token: 03AFcWeA-token/);
  assert.match(text, /cost: \$0\.00285 USD/);
  assert.match(text, /solveTime: 12\.4/);
  assert.ok(!text.includes(FAKE_KEY), "key must never be echoed");
  assert.equal(deps.budget.spentUsd, 0.00285);
});

test("datadome cookie, image text and solution userAgent are surfaced", async () => {
  const m = mockFetch([
    { status: 200, body: READY("d1", { type: "datadome", solution: { cookie: "datadome=abc", userAgent: "Mozilla/5.0 X" } }) },
    { status: 200, body: READY("i1", { type: "image", solution: { text: "x7k2p" } }) },
  ]);
  const deps = makeDeps(m.fetch);
  const d = await handleSolve({ type: "datadome", url: "https://a.example", challengeUrl: "https://c.example/?x", proxy: "http://u:p@h:1" }, deps);
  assert.match(textOf(d), /cookie: datadome=abc/);
  assert.match(textOf(d), /userAgent: Mozilla\/5\.0 X/);
  assert.equal(sc(d).userAgent, "Mozilla/5.0 X");
  const i = await handleSolve({ type: "image", body: "data:image/png;base64,aGk=" }, deps);
  assert.equal(sc(i).text, "x7k2p");
  assert.deepEqual(m.calls[1]!.body, { type: "image", body: "aGk=" });
});

// ------------------------------------------------------------ 202 -> poll

test("202 then polls GET /v1/task/{id} every 5 s until ready", async () => {
  const clock = fakeClock();
  const m = mockFetch([
    { status: 202, body: SOLVING("t_9") },
    { status: 200, body: SOLVING("t_9") },
    { status: 200, body: SOLVING("t_9") },
    { status: 200, body: READY("t_9") },
  ]);
  const deps = makeDeps(m.fetch, { clock });
  const pending: number[] = [];
  const r = await handleSolve(V2_ARGS, deps, { onPending: (_t, e) => void pending.push(e) });

  assert.equal(r.isError, undefined);
  assert.equal(sc(r).status, "ready");
  assert.deepEqual(m.calls.map((c) => `${c.method} ${c.url.replace("https://api.example.test", "")}`), [
    "POST /v1/solve?wait=60",
    "GET /v1/task/t_9",
    "GET /v1/task/t_9",
    "GET /v1/task/t_9",
  ]);
  assert.deepEqual(clock.sleeps, [5000, 5000, 5000]);
  assert.equal(pending.length, 3);
  assert.equal(deps.budget.spentUsd, 0.00285);
});

test("polling stops at 120 s total and returns a resumable 'solving' result", async () => {
  const clock = fakeClock();
  const m = mockFetch((call) => {
    if (call.method === "POST") clock.advance(60_000); // the API blocked for wait=60
    return { status: call.method === "POST" ? 202 : 200, body: SOLVING("t_slow") };
  });
  const deps = makeDeps(m.fetch, { clock });
  const r = await handleSolve(V2_ARGS, deps);

  assert.equal(r.isError, undefined);
  assert.equal(sc(r).status, "solving");
  assert.equal(sc(r).id, "t_slow");
  assert.match(textOf(r), /get_task/);
  // 60 s blocked + 12 polls x 5 s = 120 s
  assert.equal(m.calls.filter((c) => c.method === "GET").length, 12);
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 60_000);
  assert.equal(deps.budget.spentUsd, 0);

  // later get_task on that id counts its cost once
  const m2 = mockFetch([{ status: 200, body: READY("t_slow") }, { status: 200, body: READY("t_slow") }]);
  const deps2 = { ...deps, client: makeDeps(m2.fetch).client };
  await handleGetTask("t_slow", deps2);
  await handleGetTask("t_slow", deps2);
  assert.equal(deps.budget.spentUsd, 0.00285);
});

test("transient errors while polling are retried on the next tick", async () => {
  const clock = fakeClock();
  const m = mockFetch([
    { status: 202, body: SOLVING("t_2") },
    new TypeError("fetch failed"),
    { status: 429, body: { error: { code: "rate_limited", message: "slow down" } } },
    { status: 200, body: READY("t_2") },
  ]);
  const r = await handleSolve(V2_ARGS, makeDeps(m.fetch, { clock }));
  assert.equal(sc(r).status, "ready");
  assert.equal(m.calls.length, 4);
});

test("a failed task while polling becomes an isError result with the task's code", async () => {
  const m = mockFetch([
    { status: 202, body: SOLVING("t_3") },
    { status: 200, body: { id: "t_3", type: "recaptcha_v2", status: "failed", error: { code: "unsolvable", message: "gave up" } } },
  ]);
  const deps = makeDeps(m.fetch);
  const r = await handleSolve(V2_ARGS, deps);
  assert.equal(r.isError, true);
  assert.equal(sc(r).error?.code, "unsolvable");
  assert.match(textOf(r), /Error unsolvable: gave up/);
  assert.match(textOf(r), /Task id: t_3/);
  assert.equal(deps.budget.spentUsd, 0, "failed solves are never billed");
});

// ------------------------------------------------------------ error mapping

const errorCases: Array<[string, number, unknown, string, RegExp]> = [
  ["401 invalid key", 401, { error: { code: "invalid_api_key", message: "Invalid API key" } }, "invalid_api_key", /captchano\.com\/dashboard/],
  ["402 no balance", 402, { error: { code: "insufficient_balance", message: "Insufficient balance" } }, "insufficient_balance", /captchano\.com\/dashboard\/topup/],
  ["400 bad sitekey", 400, { error: { code: "invalid_sitekey", message: "bad key" } }, "invalid_sitekey", /data-sitekey/],
  ["400 proxy", 400, { error: { code: "proxy_required", message: "need proxy" } }, "proxy_required", /proxy/],
  ["429 no body", 429, undefined, "rate_limited", /Wait a few seconds/],
  ["503 no body", 503, undefined, "capacity_unavailable", /retry/],
  ["500 html", 500, "<html>oops</html>", "upstream_error", /support@captchano\.com/],
  ["418 odd", 418, {}, "http_error", /unexpected/],
];

for (const [name, status, body, code, hint] of errorCases) {
  test(`error mapping: ${name} -> ${code}`, async () => {
    const reply = typeof body === "string" ? { status, raw: body } : { status, body };
    const m = mockFetch([reply]);
    const r = await handleSolve(V2_ARGS, makeDeps(m.fetch));
    assert.equal(r.isError, true);
    assert.equal(sc(r).error?.code, code);
    assert.match(textOf(r), new RegExp(`Error ${code}:`));
    assert.match(textOf(r), hint);
    assert.ok(!textOf(r).includes(FAKE_KEY));
  });
}

test("422 failed solve maps the body's error code (score_not_met)", async () => {
  const m = mockFetch([{ status: 422, body: { id: "t_4", type: "recaptcha_v3", status: "failed", error: { code: "score_not_met", message: "score 0.3 < 0.7" } } }]);
  const r = await handleSolve({ type: "recaptcha_v3", url: "https://a.example", sitekey: "k", minScore: 0.7 }, makeDeps(m.fetch));
  assert.equal(r.isError, true);
  assert.equal(sc(r).error?.code, "score_not_met");
  assert.match(textOf(r), /lower `minScore`/);
});

test("network failure maps to network_error", async () => {
  const m = mockFetch([new TypeError("getaddrinfo ENOTFOUND")]);
  const r = await handleSolve(V2_ARGS, makeDeps(m.fetch));
  assert.equal(sc(r).error?.code, "network_error");
});

test("invalid arguments never reach the API", async () => {
  const m = mockFetch([]);
  const r = await handleSolve({ type: "datadome", url: "https://a.example" }, makeDeps(m.fetch));
  assert.equal(r.isError, true);
  assert.equal(sc(r).error?.code, "invalid_arguments");
  assert.match(textOf(r), /challengeUrl is required/);
  assert.match(textOf(r), /proxy is required/);
  assert.equal(m.calls.length, 0);
});

test("every API error code has a specific hint", () => {
  const generic = hintFor("something_new");
  for (const code of API_ERROR_CODES) assert.notEqual(hintFor(code), generic, code);
});

test("get_task: not found and ready", async () => {
  const m = mockFetch([{ status: 404, body: { error: { code: "task_not_found", message: "no such task" } } }, { status: 200, body: READY("t_5") }]);
  const deps = makeDeps(m.fetch);
  const nf = await handleGetTask("nope", deps);
  assert.equal(sc(nf).error?.code, "task_not_found");
  const ok = await handleGetTask("t_5", deps);
  assert.equal(sc(ok).token, "03AFcWeA-token");
  assert.equal(m.calls[1]!.url, "https://api.example.test/v1/task/t_5");
  assert.equal(deps.budget.spentUsd, 0, "tasks not created by this process are not counted");
  assert.equal(sc(await handleGetTask("  ", deps)).error?.code, "invalid_arguments");
});

test("get_balance: ok and invalid key", async () => {
  const m = mockFetch([{ status: 200, body: { balance: "12.3400", currency: "USD" } }, { status: 401, body: { error: { code: "invalid_api_key", message: "Invalid API key" } } }]);
  const deps = makeDeps(m.fetch, { maxSpendUsd: 5 });
  const r = await handleGetBalance(deps);
  assert.equal(sc(r).balance, "12.3400");
  assert.match(textOf(r), /Balance: 12\.3400 USD/);
  assert.match(textOf(r), /\$0\.0000 spent of \$5\.0000 limit/);
  const e = await handleGetBalance(deps);
  assert.equal(e.isError, true);
  assert.equal(sc(e).error?.code, "invalid_api_key");
});

// ------------------------------------------------------------ budget

test("Budget sums in micro-dollars, dedupes task ids, ignores junk", () => {
  const b = new Budget(0.01);
  assert.equal(b.record("a", "0.1"), true);
  assert.equal(b.record("a", "0.1"), false);
  assert.equal(b.record("b", "0.2"), true);
  assert.equal(b.spentUsd, 0.3);
  assert.equal(b.record("c", "abc"), false);
  assert.equal(b.record("d", "0"), false);
  assert.equal(b.record("e", undefined), false);
  assert.equal(b.exhausted, true);
  assert.equal(new Budget(undefined).exhausted, false);
});

test("solves are refused once CAPTCHANO_MAX_SPEND_USD is reached", async () => {
  const m = mockFetch([
    { status: 200, body: READY("b1", { cost: "0.003" }) },
    { status: 200, body: READY("b2", { cost: "0.003" }) },
  ]);
  const deps = makeDeps(m.fetch, { maxSpendUsd: 0.005 });
  assert.equal((await handleSolve(V2_ARGS, deps)).isError, undefined);
  assert.equal(deps.budget.exhausted, false);
  assert.equal((await handleSolve(V2_ARGS, deps)).isError, undefined); // allowed: under limit when submitted
  assert.equal(deps.budget.exhausted, true);
  const r = await handleSolve(V2_ARGS, deps);
  assert.equal(r.isError, true);
  assert.equal(sc(r).error?.code, "budget_exhausted");
  assert.match(textOf(r), /\$0\.0060 spent of the \$0\.0050/);
  assert.equal(m.calls.length, 2, "no request is sent once the budget is exhausted");
  // read-only tools keep working
  const types = handleListTypes();
  assert.equal(types.isError, undefined);
});

// ------------------------------------------------------------ misc

test("list_captcha_types covers every type with a sitekey hint", () => {
  const r = handleListTypes();
  const types = (sc(r).types as Array<{ type: string; sitekeyHint: string; required: string[] }>).map((t) => t.type);
  assert.deepEqual(types, ["recaptcha_v2", "recaptcha_v3", "recaptcha_enterprise", "turnstile", "datadome", "image"]);
  assert.match(textOf(r), /datadome[\s\S]*required: url, challengeUrl, proxy/);
});

test("redact scrubs keys, bearer tokens and proxy credentials", () => {
  const s = redact(`key cn-abcdef123456 Authorization: Bearer cn-xyz12345 proxy http://user:pass@1.2.3.4:80`);
  assert.ok(!s.includes("abcdef123456"));
  assert.ok(!s.includes("xyz12345"));
  assert.ok(!s.includes("user:pass"));
});
