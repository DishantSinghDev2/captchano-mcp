import { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { Budget, formatUsd } from "./budget.js";
import { CATALOG, CAPTCHA_TYPES, buildSolveRequest, validateSolveArgs, type SolveArgs } from "./catalog.js";
import { CaptchaNoClient, type Task } from "./client.js";
import type { Config } from "./config.js";
import { CaptchaNoError, hintFor } from "./errors.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

export interface ServerDeps {
  config: Config;
  client: CaptchaNoClient;
  budget: Budget;
  /** Ids of tasks this process submitted; get_task only bills these towards the budget. */
  pendingTaskIds: Set<string>;
}

/** Shared state for one process: one client and one budget across every connection/request. */
export function createDeps(config: Config, client?: CaptchaNoClient): ServerDeps {
  return {
    config,
    client: client ?? new CaptchaNoClient({ apiKey: config.apiKey, apiBase: config.apiBase, maxTotalMs: config.toolTimeoutSeconds * 1000 }),
    budget: new Budget(config.maxSpendUsd),
    pendingTaskIds: new Set<string>(),
  };
}

const INSTRUCTIONS = `CaptchaNo solves captchas through our own solving infrastructure so an agent can continue an authorised automation flow.
Workflow: (1) identify the captcha on the page and its sitekey (call list_captcha_types if unsure which fields a type needs), (2) call solve_captcha, (3) inject the returned token/cookie/text into the page exactly as the usage hint says, reusing solution.userAgent and the same proxy when they are returned.
Every successful solve is billed to the user's CaptchaNo balance; failed solves are not. Only solve captchas on sites the user is authorised to automate.`;

// ---------------------------------------------------------------- schemas

const proxyObject = z.object({
  scheme: z.enum(["http", "socks4", "socks5"]).describe("Proxy protocol."),
  host: z.string().min(1).describe("Proxy hostname or IP."),
  port: z.number().int().min(1).max(65535).describe("Proxy port."),
  username: z.string().optional().describe("Proxy username, if the proxy needs auth."),
  password: z.string().optional().describe("Proxy password, if the proxy needs auth."),
});

export const solveInputSchema = z.object({
  type: z
    .enum(CAPTCHA_TYPES)
    .describe(
      "Captcha kind: recaptcha_v2 (checkbox / invisible), recaptcha_v3 (score, no widget), recaptcha_enterprise, turnstile (Cloudflare), datadome, image (OCR)."
    ),
  url: z
    .string()
    .max(4096)
    .optional()
    .describe("Full URL of the page that shows the captcha. Required for every type except image."),
  sitekey: z
    .string()
    .max(512)
    .optional()
    .describe("Site key from the page (data-sitekey / k= / render= parameter). Required for recaptcha_* and turnstile."),
  action: z
    .string()
    .max(256)
    .optional()
    .describe("Action name for recaptcha_v3 / recaptcha_enterprise (from grecaptcha.execute) or Turnstile data-action."),
  minScore: z
    .number()
    .min(0.1)
    .max(0.9)
    .optional()
    .describe("recaptcha_v3 only: minimum score the token must reach, 0.1-0.9."),
  invisible: z.boolean().optional().describe("recaptcha_v2 / recaptcha_enterprise: true when the widget is invisible (no checkbox)."),
  cData: z.string().max(4096).optional().describe("Turnstile only: value of data-cdata / the cData render option, if present."),
  pageData: z
    .string()
    .max(65536)
    .optional()
    .describe("Turnstile only: chlPageData value when the captcha is a Cloudflare challenge page rather than a widget."),
  challengeUrl: z
    .string()
    .max(8192)
    .optional()
    .describe("DataDome only (required): the full captcha URL from the blocked response (iframe src / redirect), including its query string."),
  body: z
    .string()
    .max(8_000_000)
    .optional()
    .describe("image only (required): the captcha image, base64-encoded (a data:image/...;base64, prefix is accepted)."),
  userAgent: z
    .string()
    .max(1024)
    .optional()
    .describe("User-Agent of the browser/HTTP client that will use the solution. Recommended so the solution matches your client."),
  proxy: z
    .union([z.string().max(2048), proxyObject])
    .optional()
    .describe(
      'Proxy the solve should run through: "http://user:pass@host:port" (schemes http, socks4, socks5) or an object. Required for datadome; optional otherwise.'
    ),
});

const errorShape = z.object({ code: z.string(), message: z.string(), hint: z.string().optional() });

const taskOutputSchema = z.object({
  id: z.string().describe("Task id; pass to get_task to fetch the result again (kept 10 minutes)."),
  type: z.string(),
  status: z.enum(["solving", "ready", "failed"]),
  token: z.string().optional().describe("Token for recaptcha_* / turnstile."),
  cookie: z.string().optional().describe("Cookie for datadome."),
  text: z.string().optional().describe("Recognised text for image captchas."),
  userAgent: z.string().optional().describe("User-Agent the solution is bound to; reuse it when present."),
  cost: z.string().optional().describe("Amount billed in USD (decimal string)."),
  billedFrom: z.string().optional(),
  solveTime: z.union([z.number(), z.string()]).optional(),
  createdAt: z.string().optional(),
  error: errorShape.optional(),
  sessionSpend: z
    .object({ spentUsd: z.string(), limitUsd: z.string().nullable(), remainingUsd: z.string().nullable() })
    .optional()
    .describe("Spend tracked by this MCP server process (CAPTCHANO_MAX_SPEND_USD)."),
});

const balanceOutputSchema = z.object({
  balance: z.string().describe("Account balance as a decimal string."),
  currency: z.string(),
  sessionSpend: z.object({ spentUsd: z.string(), limitUsd: z.string().nullable(), remainingUsd: z.string().nullable() }),
});

const typesOutputSchema = z.object({
  types: z.array(
    z.object({
      type: z.string(),
      name: z.string(),
      required: z.array(z.string()),
      optional: z.array(z.string()),
      solutionField: z.string(),
      sitekeyHint: z.string(),
      usageHint: z.string(),
    })
  ),
});

// ---------------------------------------------------------------- helpers

export function errorResult(code: string, message: string, extra: { taskId?: string } = {}): CallToolResult {
  const hint = hintFor(code);
  const lines = [`Error ${code}: ${message}`];
  if (extra.taskId) lines.push(`Task id: ${extra.taskId}`);
  lines.push(`Hint: ${hint}`);
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: { error: { code, message, hint }, ...(extra.taskId ? { id: extra.taskId } : {}) },
  };
}

function exceptionResult(err: unknown): CallToolResult {
  if (err instanceof CaptchaNoError) return errorResult(err.code, err.message, err.taskId ? { taskId: err.taskId } : {});
  const message = err instanceof Error ? err.message : String(err);
  log.error(`unexpected error: ${message}`);
  return errorResult("http_error", message);
}

function taskStructured(task: Task, deps: ServerDeps): z.infer<typeof taskOutputSchema> {
  const out: z.infer<typeof taskOutputSchema> = { id: task.id, type: task.type, status: task.status };
  const s = task.solution;
  if (s?.token) out.token = s.token;
  if (s?.cookie) out.cookie = s.cookie;
  if (s?.text !== undefined && s.text !== "") out.text = s.text;
  if (s?.userAgent) out.userAgent = s.userAgent;
  if (task.cost !== undefined && task.cost !== null) out.cost = String(task.cost);
  if (task.billedFrom) out.billedFrom = task.billedFrom;
  if (task.solveTime !== undefined && task.solveTime !== null) out.solveTime = task.solveTime;
  if (task.createdAt != null) {
    out.createdAt = typeof task.createdAt === "number" ? new Date(task.createdAt).toISOString() : task.createdAt;
  }
  if (task.error) out.error = { code: task.error.code, message: task.error.message, hint: hintFor(task.error.code) };
  out.sessionSpend = deps.budget.summary();
  return out;
}

/** Converts a task (any status) into a tool result: ready → success, failed → isError, solving → pending note. */
export function taskResult(task: Task, deps: ServerDeps): CallToolResult {
  const sc = taskStructured(task, deps);

  if (task.status === "failed") {
    const code = task.error?.code ?? "unsolvable";
    const message = task.error?.message ?? "The captcha could not be solved.";
    const r = errorResult(code, message, { taskId: task.id });
    return { ...r, structuredContent: sc };
  }

  if (task.status === "solving") {
    return {
      content: [
        {
          type: "text",
          text: `Still solving (task ${task.id}, type ${task.type}). Nothing is billed until it is ready. Call get_task with id "${task.id}" in a few seconds to fetch the result (kept for 10 minutes); do not submit a new solve for the same captcha.`,
        },
      ],
      structuredContent: sc,
    };
  }

  const lines: string[] = [`Solved ${task.type} (task ${task.id}).`];
  if (sc.token) lines.push(`token: ${sc.token}`);
  if (sc.cookie) lines.push(`cookie: ${sc.cookie}`);
  if (sc.text !== undefined) lines.push(`text: ${sc.text}`);
  if (sc.userAgent) lines.push(`userAgent: ${sc.userAgent} (use this exact User-Agent when submitting the solution)`);
  if (sc.cost) lines.push(`cost: $${sc.cost} USD`);
  if (sc.solveTime !== undefined) lines.push(`solveTime: ${sc.solveTime}`);
  const budget = deps.budget;
  if (budget.limitUsd !== undefined) {
    lines.push(`session spend: $${formatUsd(budget.spentUsd)} of $${formatUsd(budget.limitUsd)} limit`);
  }
  const usage = CATALOG.find((c) => c.type === task.type)?.usageHint;
  if (usage) lines.push(`next: ${usage}`);
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: sc };
}

function budgetExhaustedResult(deps: ServerDeps): CallToolResult {
  const b = deps.budget;
  return errorResult(
    "budget_exhausted",
    `Spend limit reached: $${formatUsd(b.spentUsd)} spent of the $${formatUsd(b.limitUsd ?? 0)} CAPTCHANO_MAX_SPEND_USD limit for this server process. No new solves will be submitted.`
  );
}

// ---------------------------------------------------------------- tool handlers (exported for tests)

interface HandlerContext {
  signal?: AbortSignal;
  onPending?: (task: Task, elapsedMs: number) => void | Promise<void>;
}

export async function handleSolve(args: SolveArgs, deps: ServerDeps, ctx: HandlerContext = {}): Promise<CallToolResult> {
  const problems = validateSolveArgs(args);
  if (problems.length > 0) return errorResult("invalid_arguments", problems.join("; "));
  if (deps.budget.exhausted) return budgetExhaustedResult(deps);

  const payload = buildSolveRequest(args);
  try {
    const task = await deps.client.solve(payload, {
      waitSeconds: deps.config.waitSeconds,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onPending: async (t, elapsed) => {
        deps.pendingTaskIds.add(t.id);
        if (ctx.onPending) await ctx.onPending(t, elapsed);
      },
    });
    deps.pendingTaskIds.add(task.id);
    if (task.status === "ready") deps.budget.record(task.id, task.cost);
    log.info(`solve ${args.type} task=${task.id} status=${task.status}${task.cost ? ` cost=${task.cost}` : ""}`);
    return taskResult(task, deps);
  } catch (err) {
    if (err instanceof CaptchaNoError) log.warn(`solve ${args.type} failed: ${err.code}`);
    return exceptionResult(err);
  }
}

export async function handleGetTask(id: string, deps: ServerDeps, ctx: HandlerContext = {}): Promise<CallToolResult> {
  const trimmed = id.trim();
  if (!trimmed) return errorResult("invalid_arguments", "id is required");
  try {
    const task = await deps.client.getTask(trimmed, ctx.signal);
    // Only tasks submitted by this process count towards its budget.
    if (task.status === "ready" && deps.pendingTaskIds.has(task.id)) deps.budget.record(task.id, task.cost);
    return taskResult(task, deps);
  } catch (err) {
    return exceptionResult(err);
  }
}

export async function handleGetBalance(deps: ServerDeps, ctx: HandlerContext = {}): Promise<CallToolResult> {
  try {
    const bal = await deps.client.getBalance(ctx.signal);
    const sessionSpend = deps.budget.summary();
    const lines = [`Balance: ${bal.balance} ${bal.currency}`];
    if (sessionSpend.limitUsd !== null) {
      lines.push(`This session: $${sessionSpend.spentUsd} spent of $${sessionSpend.limitUsd} limit ($${sessionSpend.remainingUsd} left).`);
    } else {
      lines.push(`This session: $${sessionSpend.spentUsd} spent (no CAPTCHANO_MAX_SPEND_USD limit set).`);
    }
    lines.push("Top up at https://captchano.com/dashboard/topup");
    return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { ...bal, sessionSpend } };
  } catch (err) {
    return exceptionResult(err);
  }
}

export function handleListTypes(): CallToolResult {
  const types = CATALOG.map((c) => ({ ...c, required: [...c.required], optional: [...c.optional] }));
  const text = CATALOG.map(
    (c) =>
      `${c.type} - ${c.name}\n  required: ${c.required.join(", ")}\n  optional: ${c.optional.join(", ") || "-"}\n  returns: solution.${c.solutionField}\n  find it: ${c.sitekeyHint}`
  ).join("\n\n");
  return { content: [{ type: "text", text }], structuredContent: { types } };
}

// ---------------------------------------------------------------- server

/** Builds a fresh McpServer with all CaptchaNo tools registered against shared deps. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: "captchano-mcp", title: "CaptchaNo", version: VERSION, websiteUrl: "https://captchano.com/agents/mcp" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  server.registerTool(
    "solve_captcha",
    {
      title: "Solve a captcha",
      description: `Solve a captcha on a web page and return the token / cookie / text needed to pass it.
Use when an authorised browser or HTTP automation is blocked by reCAPTCHA (v2, v3, Enterprise), Cloudflare Turnstile, DataDome or an image captcha.
Before calling: identify the type and read the sitekey from the page (call list_captcha_types for where to find it and which fields each type needs).
Required: recaptcha_* and turnstile → url + sitekey; datadome → url + challengeUrl + proxy; image → body (base64).
Waits for the result (up to ~50 s by default, polling automatically). If it is still solving at the end, it returns the task id: call get_task with it instead of solving again.
Each successful solve is billed to the CaptchaNo balance (cost is returned); failed solves are free. Do not call repeatedly for the same captcha: one token is valid for one submission and expires in about 2 minutes, so use it right away.`,
      inputSchema: solveInputSchema,
      outputSchema: taskOutputSchema,
      annotations: {
        title: "Solve a captcha",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      return handleSolve(args as SolveArgs, deps, {
        signal: ctx.mcpReq.signal,
        onPending: async (task, elapsedMs) => {
          if (progressToken === undefined) return;
          try {
            await ctx.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: Math.round(elapsedMs / 1000),
                total: Math.round(deps.client.maxTotalMs / 1000),
                message: `Task ${task.id} still solving`,
              },
            });
          } catch {
            // progress is best-effort
          }
        },
      });
    }
  );

  server.registerTool(
    "get_task",
    {
      title: "Get a captcha task",
      description: `Fetch the current status and solution of a task created by solve_captcha.
Use when solve_captcha returned status "solving" (call again every ~5 s), or to re-read a solution you already received. Results are kept for 10 minutes. Free and read-only.`,
      inputSchema: z.object({
        id: z.string().min(1).max(200).describe("Task id returned by solve_captcha."),
      }),
      outputSchema: taskOutputSchema,
      annotations: { title: "Get a captcha task", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }, ctx) => handleGetTask(id, deps, { signal: ctx.mcpReq.signal })
  );

  server.registerTool(
    "get_balance",
    {
      title: "Get CaptchaNo balance",
      description: `Return the CaptchaNo account balance (USD) and how much this MCP server has spent in the current session against its optional CAPTCHANO_MAX_SPEND_USD limit.
Use before a large batch of solves, or after an insufficient_balance error. Free and read-only.`,
      inputSchema: z.object({}),
      outputSchema: balanceOutputSchema,
      annotations: { title: "Get CaptchaNo balance", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (_args, ctx) => handleGetBalance(deps, { signal: ctx.mcpReq.signal })
  );

  server.registerTool(
    "list_captcha_types",
    {
      title: "List supported captcha types",
      description: `List every captcha type solve_captcha supports, with its required and optional fields, which solution field it returns, and how to find the sitekey (or other inputs) on the page.
Use when you are unsure which type a page uses or which arguments to pass. Static, free, no network call.`,
      inputSchema: z.object({}),
      outputSchema: typesOutputSchema,
      annotations: { title: "List supported captcha types", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => handleListTypes()
  );

  return server;
}
