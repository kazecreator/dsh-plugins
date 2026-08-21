import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Config } from "./config.js";
import { UsageService } from "./usage.js";

const name = "dsh-usage";
const inject = [];

function home() { return process.env.DSH_HOME ?? join(homedir(), ".dsh"); }
function storageDir() { return join(home(), "storages", name); }
function configPath() { return join(storageDir(), "config.json"); }
function loadRuntime() {
  try { const value = JSON.parse(readFileSync(configPath(), "utf8")); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
}
function saveRuntime(value) {
  mkdirSync(dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(value, null, 2) + "\n");
}
function migrateLegacyStorage() {
  const legacy = join(home(), "storages", "dsh-settings-pro");
  if (!existsSync(legacy)) return;
  const current = loadRuntime();
  let changed = false;
  try {
    const old = JSON.parse(readFileSync(join(legacy, "config.json"), "utf8"));
    for (const key of ["usageEnabled", "balanceRefreshMs", "providerId"]) {
      if (current[key] === undefined && old?.[key] !== undefined) { current[key] = old[key]; changed = true; }
    }
  } catch { /* no legacy runtime config */ }
  if (changed) saveRuntime(current);
  for (const name of ["pricing.json"]) {
    const source = join(legacy, name);
    const target = join(storageDir(), name);
    if (!existsSync(source) || existsSync(target)) continue;
    try { mkdirSync(storageDir(), { recursive: true }); cpSync(source, target); } catch { /* best effort */ }
  }
  const source = join(legacy, "usage");
  const target = join(storageDir(), "usage");
  if (existsSync(source) && !existsSync(target)) {
    try { mkdirSync(storageDir(), { recursive: true }); cpSync(source, target, { recursive: true }); } catch { /* best effort */ }
  }
}
function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
  res.end(JSON.stringify(payload));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(new Error("body too large")); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    req.on("error", reject);
  });
}
function route(ctx, path, handler) {
  const webServer = ctx.get("webServer");
  if (webServer?.register) webServer.register({ kind: "exact", path, handler });
}
function usageText(payload) {
  const lines = [];
  for (const b of payload?.balance?.balance_infos ?? []) lines.push(`Balance (${b.currency}): total ${b.total_balance}, granted ${b.granted_balance}, topped up ${b.topped_up_balance}`);
  if (payload?.balanceError) lines.push(`Balance query failed: ${payload.balanceError}`);
  const today = (payload?.daily ?? []).find((d) => d.date === payload.today);
  lines.push(today ? `Today's usage estimate: input cache-hit ${today.cacheHit || 0} / miss ${today.cacheMiss || 0} / output ${today.response || 0} tokens, cost ¥${Number(today.cost || 0).toFixed(2)}` : "No local DeepSeek usage recorded yet");
  return lines.join("\n");
}
function registerTool(ctx, usage) {
  const tools = ctx.get("tools");
  if (!tools?.register) return;
  tools.register(defineTool({
    name: "get_usage",
    description: "Query DeepSeek API balance and locally recorded daily usage.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
    async execute() { return usage.enabled ? usageText(await usage.payload(true)) : "Usage is disabled. Enable dsh-usage first."; },
  }));
}

function apply(ctx, config) {
  const resolved = config ?? {};
  const start = () => {
    try {
      migrateLegacyStorage();
      const runtime = loadRuntime();
      const enabled = { value: runtime.usageEnabled ?? (resolved.usageEnabled === true) };
      const usage = new UsageService(ctx, { ...resolved, ...runtime, usageEnabled: enabled.value }, storageDir());
      usage.start();
      registerTool(ctx, usage);
      route(ctx, "/settings-pro/usage", async (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405);
        if (!usage.enabled) return sendJson(res, { disabled: true, enabled: false });
        try { sendJson(res, { enabled: true, ...(await usage.payload(false)) }); }
        catch (error) { sendJson(res, { error: error?.message ?? String(error) }, 500); }
      });
      route(ctx, "/settings-pro/usage/toggle", (req, res) => {
        if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405);
        readJson(req).then((body) => {
          const next = loadRuntime();
          next.usageEnabled = body.enabled === true;
          saveRuntime(next);
          enabled.value = next.usageEnabled;
          usage.setEnabled(enabled.value);
          sendJson(res, { enabled: usage.enabled });
        }).catch((error) => sendJson(res, { error: error?.message ?? String(error) }, 400));
      });
      route(ctx, "/settings-pro/usage/backfill", (req, res) => {
        if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405);
        readJson(req).then(async () => {
          // Keep this route as a compatibility alias for older clients. It no
          // longer accepts or discovers a platform token; usage is collected
          // from local session events and only the API-key balance is refreshed.
          await usage.refreshBalance();
          sendJson(res, { costs: usage.dailyUsage(), source: "session-events" });
        }).catch((error) => sendJson(res, { error: error?.message ?? String(error) }, 400));
      });
      ctx.on("dispose", () => usage.dispose());
      console.log(`[${name}] loaded (enabled=${String(enabled.value)})`);
    } catch (error) { console.error(`[${name}] failed to start:`, error?.message ?? error); }
  };
  const loader = ctx.get("loader");
  if (loader?.await) loader.await().then(start).catch(start); else start();
}

export { Config, apply, inject, name };
export default { name, inject, Config, apply };
