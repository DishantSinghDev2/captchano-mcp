#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { HELP, parseArgs } from "./cli.js";
import { ConfigError, loadConfig } from "./config.js";
import { startHttpServer } from "./http.js";
import { log } from "./log.js";
import { createDeps, createServer } from "./server.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stderr.write(`${HELP}\n`);
    return;
  }
  if (args.version) {
    process.stderr.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  if (!config.apiKey.startsWith("cn-")) log.warn("CAPTCHANO_API_KEY does not start with cn-; the API will probably reject it.");
  const deps = createDeps(config);
  const limit = config.maxSpendUsd === undefined ? "none" : `$${config.maxSpendUsd}`;

  if (args.http) {
    const authToken = process.env.CAPTCHANO_MCP_HTTP_TOKEN?.trim() || undefined;
    const server = await startHttpServer(deps, { port: args.port, host: args.host, authToken });
    log.info(`v${VERSION} listening on http://${args.host}:${args.port}/mcp (stateless; spend limit: ${limit}; endpoint auth: ${authToken ? "bearer token" : "none"})`);
    if (!authToken && args.host !== "127.0.0.1" && args.host !== "localhost" && args.host !== "::1") {
      log.warn("HTTP mode is reachable beyond localhost without CAPTCHANO_MCP_HTTP_TOKEN: anyone who can reach this port can spend your balance.");
    }
    const shutdown = () => server.close(() => process.exit(0));
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  const handle = serveStdio(() => createServer(deps), { onerror: (err) => log.warn(`stdio: ${err.message}`) });
  log.info(`v${VERSION} running on stdio (api: ${config.apiBase}; spend limit: ${limit})`);
  const shutdown = () => {
    handle.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    log.error(err.message);
  } else {
    log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
  process.exit(1);
});
