/**
 * stderr-only logger. stdout is the MCP protocol channel in stdio mode, so
 * nothing here may ever write to it. Messages are scrubbed of anything that
 * looks like a CaptchaNo key (`cn-...`) or proxy credentials as a safety net.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = (process.env.CAPTCHANO_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "silent" || raw === "off") return Infinity;
  return ORDER[raw as Level] ?? ORDER.info;
}

export function redact(msg: string): string {
  return msg
    .replace(/\bcn-[A-Za-z0-9_-]{4,}/g, "cn-***")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1***")
    .replace(/(\b(?:https?|socks[45]):\/\/)[^\s:@/]+:[^\s@/]*@/gi, "$1***:***@");
}

function write(level: Level, msg: string): void {
  if (ORDER[level] < threshold()) return;
  process.stderr.write(`[captchano-mcp] ${level}: ${redact(msg)}\n`);
}

export const log = {
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  warn: (m: string) => write("warn", m),
  error: (m: string) => write("error", m),
};
