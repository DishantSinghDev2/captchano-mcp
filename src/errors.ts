/** Error codes returned by the CaptchaNo API. */
export const API_ERROR_CODES = [
  "invalid_api_key",
  "insufficient_balance",
  "unsupported_type",
  "invalid_sitekey",
  "proxy_required",
  "proxy_unreachable",
  "score_not_met",
  "unsolvable",
  "capacity_unavailable",
  "rate_limited",
  "task_not_found",
  "upstream_error",
] as const;

/** Error codes produced locally by this MCP server (never sent by the API). */
export const LOCAL_ERROR_CODES = [
  "invalid_arguments",
  "budget_exhausted",
  "network_error",
  "timeout",
  "http_error",
  "cancelled",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
export type LocalErrorCode = (typeof LOCAL_ERROR_CODES)[number];
export type ErrorCode = ApiErrorCode | LocalErrorCode | (string & {});

const HINTS: Record<string, string> = {
  invalid_api_key:
    "The CAPTCHANO_API_KEY configured for this MCP server was rejected. Keys start with `cn-`; create or copy one at https://captchano.com/dashboard and restart the server. Do not retry until the key is fixed.",
  insufficient_balance:
    "The CaptchaNo account has no balance left. Ask the user to top up at https://captchano.com/dashboard/topup, then retry. Failed solves are never billed.",
  unsupported_type:
    "This captcha type is not supported. Call list_captcha_types to see the supported types and their fields.",
  invalid_sitekey:
    "The sitekey does not match this page. Re-read it from the page HTML (data-sitekey attribute, or the k= / sitekey= parameter in the captcha iframe or api.js URL) and make sure `url` is the page that shows the captcha.",
  proxy_required:
    "This captcha type needs a proxy. DataDome always requires one: pass `proxy` as \"http://user:pass@host:port\" (http, socks4 or socks5) or as an object, ideally the same proxy your browser/HTTP client uses.",
  proxy_unreachable:
    "The proxy could not be reached from the solving infrastructure. Check host, port, credentials and that it accepts external connections, or try another proxy.",
  score_not_met:
    "The reCAPTCHA v3 token did not reach the requested minScore. Retry, or lower `minScore` (0.3 is a common threshold). Failed solves are not billed.",
  unsolvable:
    "This captcha could not be solved. Verify url/sitekey/action (and pageData/cData for Turnstile), then retry once. Failed solves are not billed.",
  capacity_unavailable:
    "Solving capacity for this type is temporarily unavailable. Wait 10-30 seconds and retry.",
  rate_limited:
    "Too many requests for this API key. Wait a few seconds before retrying and avoid parallel bursts.",
  task_not_found:
    "No task with this id exists for this API key, or it expired (solutions are kept for 10 minutes). Submit a new solve_captcha call.",
  upstream_error:
    "A temporary error occurred while solving. Retry once; if it keeps happening, contact support@captchano.com with the task id.",
  invalid_arguments:
    "Fix the arguments listed above and call the tool again. Call list_captcha_types for the required fields of each type.",
  budget_exhausted:
    "This MCP server's spend limit (CAPTCHANO_MAX_SPEND_USD) has been reached for this session. Tell the user; they can raise the limit and restart the server.",
  network_error:
    "Could not reach the CaptchaNo API. Check network connectivity and CAPTCHANO_API_BASE, then retry.",
  timeout:
    "The request to the CaptchaNo API timed out. Retry; if a task id was returned earlier, call get_task with it instead of solving again.",
  cancelled: "The client cancelled the call. If a task id was returned, get_task can still fetch the result for 10 minutes.",
  http_error:
    "The CaptchaNo API returned an unexpected response. Retry once; if it persists, contact support@captchano.com.",
};

export function hintFor(code: string): string {
  return HINTS[code] ?? "Retry once; if the problem persists, contact support@captchano.com.";
}

/** An error reported by the API or by this server, carrying a stable code. */
export class CaptchaNoError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | undefined;
  readonly taskId: string | undefined;

  constructor(code: ErrorCode, message: string, opts: { httpStatus?: number; taskId?: string } = {}) {
    super(message);
    this.name = "CaptchaNoError";
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.taskId = opts.taskId;
  }

  get hint(): string {
    return hintFor(this.code);
  }
}

/** Best-effort mapping of an HTTP status to an error code when the body has none. */
export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
    case 403:
      return "invalid_api_key";
    case 402:
      return "insufficient_balance";
    case 404:
      return "task_not_found";
    case 429:
      return "rate_limited";
    case 503:
      return "capacity_unavailable";
    default:
      return status >= 500 ? "upstream_error" : "http_error";
  }
}
