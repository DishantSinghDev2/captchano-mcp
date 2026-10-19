import { CaptchaNoError, codeForStatus } from "./errors.js";
import { MAX_WAIT_SECONDS } from "./config.js";
import { VERSION } from "./version.js";

export type TaskStatus = "solving" | "ready" | "failed";

export interface TaskSolution {
  token?: string;
  cookie?: string;
  text?: string;
  userAgent?: string;
}

export interface Task {
  id: string;
  type: string;
  status: TaskStatus;
  solution?: TaskSolution;
  error?: { code: string; message: string };
  /** USD amount as a decimal string, e.g. "0.00285". */
  cost?: string;
  billedFrom?: string;
  solveTime?: number | string;
  /** Unix epoch milliseconds, as the API returns it. */
  createdAt?: number | string;
}

export interface Balance {
  balance: string;
  currency: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  apiKey: string;
  apiBase: string;
  fetch?: FetchLike;
  /** Injected for tests. Must resolve after `ms` or reject when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /** Interval between GET /v1/task polls. Default 5000 ms. */
  pollIntervalMs?: number;
  /** Upper bound for one solve call including the initial wait. Default 120000 ms. */
  maxTotalMs?: number;
}

export interface SolveOptions {
  /** Seconds the API blocks before answering 202 (capped at 120). */
  waitSeconds: number;
  signal?: AbortSignal;
  /** Called after the 202 and after every poll that is still solving. */
  onPending?: (task: Task, elapsedMs: number) => void | Promise<void>;
}

/** Errors worth retrying on the next poll tick instead of failing the whole solve. */
const TRANSIENT = new Set(["network_error", "timeout", "rate_limited", "upstream_error", "capacity_unavailable", "http_error"]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isTask(v: unknown): v is Task {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && (o.status === "solving" || o.status === "ready" || o.status === "failed");
}

function isBalance(v: unknown): v is Balance {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (typeof o.balance === "string" || typeof o.balance === "number") && typeof o.currency === "string";
}

/** Minimal client for the CaptchaNo HTTP API (https://captchano.com/captcha-solver-api). */
export class CaptchaNoClient {
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  readonly pollIntervalMs: number;
  readonly maxTotalMs: number;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxTotalMs = opts.maxTotalMs ?? 120_000;
  }

  private async request(method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; data: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `captchano-mcp/${VERSION}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      });
    } catch (err) {
      if (signal?.aborted) throw new CaptchaNoError("cancelled", "The request was cancelled by the client.");
      if (timeout.aborted) throw new CaptchaNoError("timeout", `No response from the CaptchaNo API within ${Math.round(timeoutMs / 1000)} s.`);
      const msg = err instanceof Error ? err.message : String(err);
      throw new CaptchaNoError("network_error", `Could not reach the CaptchaNo API: ${msg}`);
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    return { status: res.status, data };
  }

  private toError(status: number, data: unknown): CaptchaNoError {
    const o = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
    const e = o.error;
    let code: string | undefined;
    let message: string | undefined;
    if (typeof e === "object" && e !== null) {
      const eo = e as Record<string, unknown>;
      if (typeof eo.code === "string") code = eo.code;
      if (typeof eo.message === "string") message = eo.message;
    } else if (typeof e === "string") {
      code = e;
    }
    if (!message && typeof o.message === "string") message = o.message;
    code ??= codeForStatus(status);
    message ??= `CaptchaNo API returned HTTP ${status}.`;
    return new CaptchaNoError(code, message, { httpStatus: status, taskId: typeof o.id === "string" ? o.id : undefined });
  }

  /**
   * POST /v1/solve?wait=N. Resolves with the task for 200 (ready), 202
   * (solving) and 422 (failed, with error). Throws CaptchaNoError otherwise.
   */
  async submit(payload: Record<string, unknown>, waitSeconds: number, signal?: AbortSignal): Promise<Task> {
    const wait = Math.max(0, Math.min(Math.floor(waitSeconds), MAX_WAIT_SECONDS));
    const path = wait > 0 ? `/v1/solve?wait=${wait}` : "/v1/solve";
    const { status, data } = await this.request("POST", path, payload, wait * 1000 + 20_000, signal);
    if ((status === 200 || status === 201 || status === 202 || status === 422) && isTask(data)) return data;
    throw this.toError(status, data);
  }

  /** GET /v1/task/{id}. Solutions stay retrievable for 10 minutes. */
  async getTask(id: string, signal?: AbortSignal): Promise<Task> {
    const { status, data } = await this.request("GET", `/v1/task/${encodeURIComponent(id)}`, undefined, 20_000, signal);
    if (status >= 200 && status < 300 && isTask(data)) return data;
    if (status === 422 && isTask(data)) return data;
    throw this.toError(status, data);
  }

  /** GET /v1/balance. */
  async getBalance(signal?: AbortSignal): Promise<Balance> {
    const { status, data } = await this.request("GET", "/v1/balance", undefined, 20_000, signal);
    if (status >= 200 && status < 300 && isBalance(data)) return { balance: String(data.balance), currency: data.currency };
    throw this.toError(status, data);
  }

  /**
   * Submits a solve and, if the API answers 202 (still solving), polls
   * GET /v1/task/{id} every `pollIntervalMs` until the task is ready/failed or
   * `maxTotalMs` has elapsed since the call started. A task still "solving"
   * at the deadline is returned as-is so the caller can resume with getTask.
   */
  async solve(payload: Record<string, unknown>, opts: SolveOptions): Promise<Task> {
    const start = this.now();
    const maxWait = Math.floor(this.maxTotalMs / 1000);
    let task = await this.submit(payload, Math.min(opts.waitSeconds, maxWait), opts.signal);

    while (task.status === "solving") {
      const elapsed = this.now() - start;
      const remaining = this.maxTotalMs - elapsed;
      if (opts.onPending) await opts.onPending(task, elapsed);
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.pollIntervalMs, remaining), opts.signal);
      try {
        task = await this.getTask(task.id, opts.signal);
      } catch (err) {
        if (err instanceof CaptchaNoError && TRANSIENT.has(err.code)) continue;
        throw err;
      }
    }
    return task;
  }
}
