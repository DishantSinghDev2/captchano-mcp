export const DEFAULT_API_BASE = "https://api.captchano.com";
export const DEFAULT_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 120;

export interface Config {
  /** CaptchaNo API key (starts with `cn-`). Never logged, never returned to the client. */
  apiKey: string;
  /** API base URL without trailing slash. */
  apiBase: string;
  /** Seconds the API should block on POST /v1/solve?wait=N (1-120). */
  waitSeconds: number;
  /** Optional per-process spend ceiling in USD. `undefined` means unlimited. */
  maxSpendUsd: number | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * Reads an optional variable. Blank values and unsubstituted client
 * placeholders such as "${user_config.max_spend_usd}" count as unset.
 */
function optional(env: Env, name: string): string {
  const v = (env[name] ?? "").trim();
  return v.startsWith("${") ? "" : v;
}

/**
 * Reads configuration from environment variables. Throws {@link ConfigError}
 * with a human-readable message (never containing the key) when invalid.
 */
export function loadConfig(env: Env = process.env): Config {
  const apiKey = (env.CAPTCHANO_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new ConfigError(
      "CAPTCHANO_API_KEY is not set. Create a key at https://captchano.com/dashboard and pass it as an environment variable."
    );
  }

  const rawBase = optional(env, "CAPTCHANO_API_BASE") || DEFAULT_API_BASE;
  let apiBase: string;
  try {
    const parsed = new URL(rawBase);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad scheme");
    apiBase = parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new ConfigError(`CAPTCHANO_API_BASE is not a valid http(s) URL: ${rawBase}`);
  }

  let waitSeconds = DEFAULT_WAIT_SECONDS;
  const rawWait = optional(env, "CAPTCHANO_WAIT");
  if (rawWait) {
    const n = Number(rawWait);
    if (!Number.isFinite(n) || n < 1) {
      throw new ConfigError(`CAPTCHANO_WAIT must be a number of seconds between 1 and ${MAX_WAIT_SECONDS}, got: ${rawWait}`);
    }
    waitSeconds = Math.min(Math.floor(n), MAX_WAIT_SECONDS);
  }

  let maxSpendUsd: number | undefined;
  const rawMax = optional(env, "CAPTCHANO_MAX_SPEND_USD");
  if (rawMax) {
    const n = Number(rawMax);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ConfigError(`CAPTCHANO_MAX_SPEND_USD must be a positive number of US dollars, got: ${rawMax}`);
    }
    maxSpendUsd = n;
  }

  return { apiKey, apiBase, waitSeconds, maxSpendUsd };
}
