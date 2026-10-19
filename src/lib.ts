/** Programmatic entry point (no side effects). The CLI lives in index.ts. */
export { createServer, createDeps, handleSolve, handleGetTask, handleGetBalance, handleListTypes, type ServerDeps } from "./server.js";
export { CaptchaNoClient, type Task, type TaskSolution, type Balance, type ClientOptions } from "./client.js";
export { loadConfig, ConfigError, type Config } from "./config.js";
export { Budget } from "./budget.js";
export { CATALOG, CAPTCHA_TYPES, type CaptchaType, type SolveArgs } from "./catalog.js";
export { CaptchaNoError, API_ERROR_CODES, hintFor } from "./errors.js";
export { startHttpServer } from "./http.js";
export { VERSION } from "./version.js";
