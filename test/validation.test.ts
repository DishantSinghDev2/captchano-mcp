import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildSolveRequest, normalizeImageBody, validateSolveArgs, type SolveArgs } from "../src/catalog.js";
import { parseArgs } from "../src/cli.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { solveInputSchema } from "../src/server.js";
import { VERSION } from "../src/version.js";

const ok = (a: SolveArgs) => assert.deepEqual(validateSolveArgs(a), []);
const bad = (a: SolveArgs, re: RegExp) => {
  const errs = validateSolveArgs(a);
  assert.ok(errs.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errs)}`);
};

test("valid argument sets pass", () => {
  ok({ type: "recaptcha_v2", url: "https://a.example/x", sitekey: "k", invisible: true });
  ok({ type: "recaptcha_v3", url: "https://a.example/x", sitekey: "k", action: "login", minScore: 0.7 });
  ok({ type: "recaptcha_enterprise", url: "https://a.example/x", sitekey: "k", action: "submit" });
  ok({ type: "turnstile", url: "https://a.example/x", sitekey: "0x4AAA", cData: "c", pageData: "p", action: "a" });
  ok({ type: "datadome", url: "https://a.example/x", challengeUrl: "https://geo.captcha-delivery.com/captcha/?initialCid=x", proxy: "http://u:p@1.2.3.4:8080" });
  ok({ type: "datadome", url: "https://a.example/x", challengeUrl: "https://c.example/?x", proxy: { scheme: "socks5", host: "1.2.3.4", port: 1080 } });
  ok({ type: "image", body: "iVBORw0KGgo=" });
  ok({ type: "image", body: "data:image/png;base64,iVBORw0KGgo=" });
});

test("per-type required fields are enforced", () => {
  bad({ type: "recaptcha_v2", url: "https://a.example" }, /sitekey is required/);
  bad({ type: "turnstile", sitekey: "0x4" }, /url is required/);
  bad({ type: "datadome", url: "https://a.example", challengeUrl: "https://c.example" }, /proxy is required/);
  bad({ type: "datadome", url: "https://a.example", proxy: "http://h:1" }, /challengeUrl is required/);
  bad({ type: "image" }, /body is required/);
  bad({ type: "recaptcha_v2", url: "https://a.example", sitekey: "   " }, /sitekey is required/);
});

test("fields that do not apply to a type are rejected", () => {
  bad({ type: "turnstile", url: "https://a.example", sitekey: "k", minScore: 0.5 }, /minScore is not used by type turnstile/);
  bad({ type: "recaptcha_v2", url: "https://a.example", sitekey: "k", cData: "x" }, /cData is not used/);
  bad({ type: "image", body: "aGk=", proxy: "http://h:1" }, /proxy is not used/);
});

test("formats are checked", () => {
  bad({ type: "recaptcha_v2", url: "example.com", sitekey: "k" }, /url must be an absolute/);
  bad({ type: "recaptcha_v2", url: "javascript:alert(1)", sitekey: "k" }, /url must be an absolute/);
  bad({ type: "datadome", url: "https://a.example", challengeUrl: "https://c.example", proxy: "ftp://h:21" }, /proxy must look like/);
  bad({ type: "datadome", url: "https://a.example", challengeUrl: "https://c.example", proxy: "http://hostonly" }, /proxy must look like/);
  bad({ type: "datadome", url: "https://a.example", challengeUrl: "https://c.example", proxy: { scheme: "http", host: "h", port: 70000 } }, /proxy.port/);
  bad({ type: "image", body: "not base64!!" }, /body must be a base64/);
  bad({ type: "recaptcha_v3", url: "https://a.example", sitekey: "k", minScore: 0.95 }, /minScore must be between/);
});

test("proxy credentials never appear in validation messages", () => {
  const errs = validateSolveArgs({ type: "datadome", url: "https://a.example", challengeUrl: "https://c.example", proxy: "ftp://secretuser:secretpass@h:21" });
  assert.ok(errs.length > 0);
  assert.ok(!errs.join(" ").includes("secretpass"));
});

test("zod input schema rejects unknown types and out-of-range scores", () => {
  assert.equal(solveInputSchema.safeParse({ type: "hcaptcha", url: "https://a.example" }).success, false);
  assert.equal(solveInputSchema.safeParse({ type: "recaptcha_v3", minScore: 1.5 }).success, false);
  assert.equal(solveInputSchema.safeParse({ type: "recaptcha_v2", url: "https://a.example", sitekey: "k" }).success, true);
  assert.equal(solveInputSchema.safeParse({ type: "datadome", proxy: { scheme: "https", host: "h", port: 1 } }).success, false);
});

test("buildSolveRequest trims, drops empties and strips data URL prefixes", () => {
  assert.deepEqual(buildSolveRequest({ type: "recaptcha_v2", url: " https://a.example ", sitekey: "k", action: "", userAgent: undefined }), {
    type: "recaptcha_v2",
    url: "https://a.example",
    sitekey: "k",
  });
  assert.deepEqual(buildSolveRequest({ type: "image", body: "data:image/png;base64,aGVs\nbG8=" }), { type: "image", body: "aGVsbG8=" });
  assert.deepEqual(
    buildSolveRequest({ type: "datadome", url: "https://a", challengeUrl: "https://c", proxy: { scheme: "http", host: " h ", port: 8080, username: "", password: undefined } }),
    { type: "datadome", url: "https://a", challengeUrl: "https://c", proxy: { scheme: "http", host: "h", port: 8080 } }
  );
  assert.equal(normalizeImageBody("  data:image/jpeg;base64,AAAA  "), "AAAA");
});

test("loadConfig: key required, defaults, caps and validation", () => {
  assert.throws(() => loadConfig({}), ConfigError);
  assert.throws(() => loadConfig({ CAPTCHANO_API_KEY: "  " }), /CAPTCHANO_API_KEY is not set/);
  const c = loadConfig({ CAPTCHANO_API_KEY: "cn-abc" });
  assert.equal(c.apiBase, "https://api.captchano.com");
  assert.equal(c.waitSeconds, 45);
  assert.equal(c.toolTimeoutSeconds, 50);
  assert.equal(c.maxSpendUsd, undefined);
  // wait is capped by the API max and then by the tool budget
  assert.equal(loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_WAIT: "500" }).waitSeconds, 50);
  assert.equal(loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_WAIT: "500", CAPTCHANO_TOOL_TIMEOUT: "300" }).waitSeconds, 120);
  assert.equal(loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_TOOL_TIMEOUT: "9999" }).toolTimeoutSeconds, 600);
  assert.throws(() => loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_TOOL_TIMEOUT: "5" }), ConfigError);
  assert.equal(loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_API_BASE: "https://x.example/" }).apiBase, "https://x.example");
  assert.equal(loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_MAX_SPEND_USD: "2.5" }).maxSpendUsd, 2.5);
  assert.equal(loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_MAX_SPEND_USD: "${user_config.max_spend_usd}" }).maxSpendUsd, undefined);
  assert.throws(() => loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_MAX_SPEND_USD: "-1" }), ConfigError);
  assert.throws(() => loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_WAIT: "abc" }), ConfigError);
  assert.throws(() => loadConfig({ CAPTCHANO_API_KEY: "cn-abc", CAPTCHANO_API_BASE: "ftp://x" }), ConfigError);
  try {
    loadConfig({ CAPTCHANO_API_KEY: "cn-supersecret", CAPTCHANO_WAIT: "x" });
  } catch (e) {
    assert.ok(!(e as Error).message.includes("supersecret"));
  }
});

test("CLI flags", () => {
  assert.deepEqual(parseArgs([]), { http: false, port: 8080, host: "127.0.0.1", help: false, version: false });
  assert.equal(parseArgs(["--http", "--port", "9000"]).port, 9000);
  assert.equal(parseArgs(["--http", "--port=9001", "--host=0.0.0.0"]).host, "0.0.0.0");
  assert.throws(() => parseArgs(["--port", "nope"]), ConfigError);
  assert.throws(() => parseArgs(["--api-key", "cn-x"]), /Unknown argument/);
});

test("VERSION matches package.json, server.json and manifest.json", () => {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../../${f}`, import.meta.url), "utf8"));
  const pkg = read("package.json") as { version: string; mcpName: string };
  const server = read("server.json") as { name: string; version: string; packages: Array<{ identifier: string; version: string }> };
  const manifest = read("manifest.json") as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0]?.version, pkg.version);
  assert.equal(server.packages[0]?.identifier, "captchano-mcp");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(manifest.version, pkg.version);
});
