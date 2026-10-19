import { ConfigError } from "./config.js";
import { VERSION } from "./version.js";

export const HELP = `captchano-mcp ${VERSION} - CaptchaNo MCP server

Usage:
  npx -y captchano-mcp                       stdio transport (default)
  npx -y captchano-mcp --http [--port 8080] [--host 127.0.0.1]
                                             stateless Streamable HTTP at /mcp

Environment:
  CAPTCHANO_API_KEY        required, your CaptchaNo key (cn-...)
  CAPTCHANO_API_BASE       optional, default https://api.captchano.com
  CAPTCHANO_WAIT           optional, seconds the API blocks per solve (1-120, default 45)
  CAPTCHANO_TOOL_TIMEOUT   optional, max seconds per solve_captcha call (10-600, default 50)
  CAPTCHANO_MAX_SPEND_USD  optional, stop solving once this process has spent this much
  CAPTCHANO_MCP_HTTP_TOKEN optional, require "Authorization: Bearer <token>" in --http mode
  CAPTCHANO_LOG_LEVEL      optional, debug | info | warn | error | silent (stderr only)

Docs: https://captchano.com/agents/mcp`;

export interface CliArgs {
  http: boolean;
  port: number;
  host: string;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { http: false, port: 8080, host: "127.0.0.1", help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const next = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new ConfigError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--http":
        out.http = true;
        break;
      case "--stdio":
        out.http = false;
        break;
      case "--port": {
        const p = Number(next());
        if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ConfigError("--port must be an integer between 1 and 65535");
        out.port = p;
        break;
      }
      case "--host":
        out.host = next();
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      case "-v":
      case "--version":
        out.version = true;
        break;
      default:
        throw new ConfigError(`Unknown argument: ${a}. Run with --help for usage.`);
    }
  }
  return out;
}
