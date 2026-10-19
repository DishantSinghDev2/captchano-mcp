export const CAPTCHA_TYPES = [
  "recaptcha_v2",
  "recaptcha_v3",
  "recaptcha_enterprise",
  "turnstile",
  "datadome",
  "image",
] as const;

export type CaptchaType = (typeof CAPTCHA_TYPES)[number];

/** Every field `solve_captcha` accepts besides `type`. */
export type SolveField =
  | "url"
  | "sitekey"
  | "action"
  | "minScore"
  | "invisible"
  | "cData"
  | "pageData"
  | "challengeUrl"
  | "body"
  | "userAgent"
  | "proxy";

export interface CaptchaTypeInfo {
  type: CaptchaType;
  name: string;
  required: SolveField[];
  optional: SolveField[];
  solutionField: "token" | "cookie" | "text";
  sitekeyHint: string;
  usageHint: string;
}

export const CATALOG: readonly CaptchaTypeInfo[] = [
  {
    type: "recaptcha_v2",
    name: "Google reCAPTCHA v2 (checkbox or invisible)",
    required: ["url", "sitekey"],
    optional: ["invisible", "userAgent", "proxy"],
    solutionField: "token",
    sitekeyHint:
      "Use the data-sitekey attribute of the .g-recaptcha element, or the k= parameter of the recaptcha/api2/anchor iframe src.",
    usageHint:
      "Put the token into the hidden textarea #g-recaptcha-response (or pass it to the page's data-callback function), then submit the form.",
  },
  {
    type: "recaptcha_v3",
    name: "Google reCAPTCHA v3 (score based, no widget)",
    required: ["url", "sitekey"],
    optional: ["action", "minScore", "userAgent", "proxy"],
    solutionField: "token",
    sitekeyHint:
      "Use the render= parameter of the recaptcha/api.js script src, or the first argument of grecaptcha.execute(sitekey, { action }); copy that action too.",
    usageHint:
      "Send the token wherever the page sends the result of grecaptcha.execute (usually a g-recaptcha-response form field or a JSON body field).",
  },
  {
    type: "recaptcha_enterprise",
    name: "Google reCAPTCHA Enterprise",
    required: ["url", "sitekey"],
    optional: ["action", "invisible", "userAgent", "proxy"],
    solutionField: "token",
    sitekeyHint:
      "The page loads recaptcha/enterprise.js; use its render= parameter, the k= parameter of the enterprise anchor iframe, or the first argument of grecaptcha.enterprise.execute.",
    usageHint: "Submit the token the same way the page submits grecaptcha.enterprise.execute output.",
  },
  {
    type: "turnstile",
    name: "Cloudflare Turnstile (widget or challenge page)",
    required: ["url", "sitekey"],
    optional: ["action", "cData", "pageData", "userAgent", "proxy"],
    solutionField: "token",
    sitekeyHint:
      "Use the data-sitekey attribute of the .cf-turnstile element or the sitekey option passed to turnstile.render(); Turnstile sitekeys usually start with 0x. Copy data-action and data-cdata too if present.",
    usageHint:
      "Put the token into the hidden cf-turnstile-response input (or the widget callback). If solution.userAgent is returned, send requests with that exact User-Agent.",
  },
  {
    type: "datadome",
    name: "DataDome slider/captcha",
    required: ["url", "challengeUrl", "proxy"],
    optional: ["userAgent"],
    solutionField: "cookie",
    sitekeyHint:
      "No sitekey. challengeUrl is the full captcha URL from the blocked response (the iframe src or redirect on geo.captcha-delivery.com, including its query string).",
    usageHint:
      "Set the returned datadome cookie on the target domain and retry the blocked request through the SAME proxy and User-Agent.",
  },
  {
    type: "image",
    name: "Image / text captcha (OCR)",
    required: ["body"],
    optional: ["url"],
    solutionField: "text",
    sitekeyHint:
      "No sitekey. Screenshot or download the captcha image and pass it base64-encoded in body (a data:image/...;base64, prefix is accepted and stripped).",
    usageHint: "Type solution.text into the captcha input field.",
  },
];

export function catalogEntry(type: CaptchaType): CaptchaTypeInfo {
  const entry = CATALOG.find((c) => c.type === type);
  if (!entry) throw new Error(`Unknown captcha type: ${type}`);
  return entry;
}

export interface ProxyObject {
  scheme: "http" | "socks4" | "socks5";
  host: string;
  port: number;
  username?: string | undefined;
  password?: string | undefined;
}

export interface SolveArgs {
  type: CaptchaType;
  url?: string | undefined;
  sitekey?: string | undefined;
  action?: string | undefined;
  minScore?: number | undefined;
  invisible?: boolean | undefined;
  cData?: string | undefined;
  pageData?: string | undefined;
  challengeUrl?: string | undefined;
  body?: string | undefined;
  userAgent?: string | undefined;
  proxy?: string | ProxyObject | undefined;
}

const PROXY_STRING_RE = /^(http|socks4|socks5):\/\/(?:[^\s:@/]+(?::[^\s@/]*)?@)?[^\s:@/]+:\d{1,5}\/?$/i;
const DATA_URL_RE = /^data:[^;,]+;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
}

/**
 * Cross-field validation the JSON schema cannot express (per-type required
 * fields, URL/proxy/base64 formats). Returns a list of problems; empty means valid.
 * Messages never include proxy credentials.
 */
export function validateSolveArgs(args: SolveArgs): string[] {
  const errors: string[] = [];
  const info = CATALOG.find((c) => c.type === args.type);
  if (!info) return [`type must be one of: ${CAPTCHA_TYPES.join(", ")}`];

  for (const field of info.required) {
    if (!present(args[field])) errors.push(`${field} is required for type ${args.type}`);
  }

  const allowed = new Set<SolveField>([...info.required, ...info.optional]);
  const fields: SolveField[] = ["url", "sitekey", "action", "minScore", "invisible", "cData", "pageData", "challengeUrl", "body", "userAgent", "proxy"];
  for (const field of fields) {
    if (present(args[field]) && !allowed.has(field)) {
      errors.push(`${field} is not used by type ${args.type} (allowed: ${[...allowed].join(", ")})`);
    }
  }

  if (present(args.url) && !isHttpUrl(args.url as string)) errors.push("url must be an absolute http(s) URL of the page showing the captcha");
  if (present(args.challengeUrl) && !isHttpUrl(args.challengeUrl as string)) errors.push("challengeUrl must be an absolute http(s) URL");
  if (args.minScore !== undefined && (args.minScore < 0.1 || args.minScore > 0.9)) errors.push("minScore must be between 0.1 and 0.9");

  if (typeof args.proxy === "string" && present(args.proxy) && !PROXY_STRING_RE.test(args.proxy.trim())) {
    errors.push('proxy must look like "http://user:pass@host:port" (schemes: http, socks4, socks5); use the object form { scheme, host, port, username, password } if the password contains special characters');
  }
  if (typeof args.proxy === "object" && args.proxy !== null) {
    const p = args.proxy;
    if (!present(p.host)) errors.push("proxy.host is required");
    if (!Number.isInteger(p.port) || p.port < 1 || p.port > 65535) errors.push("proxy.port must be an integer between 1 and 65535");
    if (present(p.password) && !present(p.username)) errors.push("proxy.username is required when proxy.password is set");
  }

  if (present(args.body)) {
    const b = normalizeImageBody(args.body as string);
    if (!b || !BASE64_RE.test(b)) errors.push("body must be a base64-encoded image (optionally prefixed with data:image/...;base64,)");
  }

  return errors;
}

/** Strips a data-URL prefix and whitespace from a base64 image. */
export function normalizeImageBody(body: string): string {
  return body.trim().replace(DATA_URL_RE, "").replace(/\s+/g, "");
}

/** Builds the JSON body for POST /v1/solve from validated args (drops empty fields). */
export function buildSolveRequest(args: SolveArgs): Record<string, unknown> {
  const out: Record<string, unknown> = { type: args.type };
  const copy: SolveField[] = ["url", "sitekey", "action", "minScore", "invisible", "cData", "pageData", "challengeUrl", "userAgent"];
  for (const field of copy) {
    const v = args[field];
    if (present(v)) out[field] = typeof v === "string" ? v.trim() : v;
  }
  if (present(args.body)) out.body = normalizeImageBody(args.body as string);
  if (typeof args.proxy === "string" && present(args.proxy)) out.proxy = args.proxy.trim();
  else if (typeof args.proxy === "object" && args.proxy !== null) {
    const p: Record<string, unknown> = { scheme: args.proxy.scheme, host: args.proxy.host.trim(), port: args.proxy.port };
    if (present(args.proxy.username)) p.username = args.proxy.username;
    if (present(args.proxy.password)) p.password = args.proxy.password;
    out.proxy = p;
  }
  return out;
}
