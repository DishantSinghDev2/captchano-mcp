import { CaptchaNoClient, type FetchLike } from "../src/client.js";
import type { Config } from "../src/config.js";
import { createDeps, type ServerDeps } from "../src/server.js";

export const FAKE_KEY = "cn-test-0000000000000000";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Reply = { status: number; body?: unknown; raw?: string } | Error;

/** A scripted fetch: each call shifts the next reply (or uses the route function). */
export function mockFetch(replies: Reply[] | ((call: RecordedCall) => Reply)) {
  const calls: RecordedCall[] = [];
  const queue = Array.isArray(replies) ? [...replies] : undefined;
  const fn: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const call: RecordedCall = {
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const reply = queue ? queue.shift() : (replies as (c: RecordedCall) => Reply)(call);
    if (!reply) throw new Error(`unexpected fetch #${calls.length}: ${call.method} ${url}`);
    if (reply instanceof Error) throw reply;
    const text = reply.raw ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: fn, calls };
}

/** Fake clock: sleep() advances now() instantly. */
export function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

export function makeDeps(fetch: FetchLike, opts: { maxSpendUsd?: number; waitSeconds?: number; clock?: ReturnType<typeof fakeClock> } = {}): ServerDeps {
  const config: Config = {
    apiKey: FAKE_KEY,
    apiBase: "https://api.example.test",
    waitSeconds: opts.waitSeconds ?? 60,
    maxSpendUsd: opts.maxSpendUsd,
  };
  const clock = opts.clock ?? fakeClock();
  const client = new CaptchaNoClient({ apiKey: config.apiKey, apiBase: config.apiBase, fetch, now: clock.now, sleep: clock.sleep });
  return createDeps(config, client);
}

export function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

export const READY = (id = "t_1", extra: Record<string, unknown> = {}) => ({
  id,
  type: "recaptcha_v2",
  status: "ready",
  solution: { token: "03AFcWeA-token" },
  cost: "0.00285",
  solveTime: 12.4,
  createdAt: "2026-10-19T10:00:00Z",
  ...extra,
});

export const SOLVING = (id = "t_1") => ({ id, type: "recaptcha_v2", status: "solving", createdAt: "2026-10-19T10:00:00Z" });

export const V2_ARGS = { type: "recaptcha_v2" as const, url: "https://example.com/login", sitekey: "6Lc_example_sitekey" };
