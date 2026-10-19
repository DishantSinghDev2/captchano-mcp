import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import { createMcpHandler } from "@modelcontextprotocol/server";

import { log } from "./log.js";
import { createServer, type ServerDeps } from "./server.js";

export interface HttpOptions {
  port: number;
  host: string;
  /** Optional shared secret; when set, every /mcp request must send `Authorization: Bearer <token>`. */
  authToken?: string | undefined;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function toWebRequest(req: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    else headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(req.url ?? "/", origin), init);
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    const prev = headers[key];
    if (prev === undefined) headers[key] = value;
    else headers[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    reader.cancel().catch(() => undefined);
  });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Serves the MCP endpoint at POST /mcp (stateless Streamable HTTP; a fresh
 * McpServer per request, all sharing one client + budget) and GET /healthz.
 * The CaptchaNo key comes only from the environment, never from requests.
 */
export function startHttpServer(deps: ServerDeps, opts: HttpOptions): Promise<HttpServer> {
  const handler = createMcpHandler(() => createServer(deps), {
    onerror: (err) => log.warn(`http: ${err.message}`),
  });
  const origin = `http://${opts.host.includes(":") ? `[${opts.host}]` : opts.host}:${opts.port}`;

  const server = createHttpServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/healthz" && req.method === "GET") return json(res, 200, { ok: true });
    if (path !== "/mcp") return json(res, 404, { error: "not_found", message: "MCP endpoint is /mcp" });

    if (opts.authToken) {
      const auth = req.headers.authorization ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
      if (!token || !safeEqual(token, opts.authToken)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return json(res, 401, { error: "unauthorized", message: "Missing or invalid bearer token for this MCP endpoint." });
      }
    }

    handler
      .fetch(toWebRequest(req, origin))
      .then((response) => sendWebResponse(res, response))
      .catch((err: unknown) => {
        log.error(`http handler failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
        else res.end();
      });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
