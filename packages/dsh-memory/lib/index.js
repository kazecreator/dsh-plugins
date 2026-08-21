import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { Config } from "./config.js";
import { MemoryStore } from "./memory-store.js";

const name = "dsh-memory";
const inject = [];
function home() { return process.env.DSH_HOME ?? join(homedir(), ".dsh"); }
function dir() { return join(home(), "storages", name); }
function configPath() { return join(dir(), "config.json"); }
function runtime() { try { const v = JSON.parse(readFileSync(configPath(), "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
function save(value) { mkdirSync(dirname(configPath()), { recursive: true }); writeFileSync(configPath(), JSON.stringify(value, null, 2) + "\n"); }
function migrateLegacyStorage() {
  const legacy = join(home(), "storages", "dsh-settings-pro");
  if (!existsSync(legacy)) return;
  const current = runtime();
  let changed = false;
  try {
    const old = JSON.parse(readFileSync(join(legacy, "config.json"), "utf8"));
    if (current.memoryEnabled === undefined && old?.memoryEnabled !== undefined) { current.memoryEnabled = old.memoryEnabled; changed = true; }
  } catch { /* no legacy runtime config */ }
  if (changed) save(current);
  for (const name of ["memory", "memory.json", "memory.json.bak"]) {
    const source = join(legacy, name);
    const target = join(dir(), name);
    if (!existsSync(source) || existsSync(target)) continue;
    try { mkdirSync(dir(), { recursive: true }); cpSync(source, target, { recursive: true }); } catch { /* best effort */ }
  }
}
function sendJson(res, payload, statusCode = 200) { res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" }); res.end(JSON.stringify(payload)); }
function readJson(req) { return new Promise((resolve, reject) => { let body = ""; req.on("data", (chunk) => { body += chunk; if (body.length > 1e6) req.destroy(new Error("body too large")); }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } }); req.on("error", reject); }); }
function route(ctx, path, handler) { const webServer = ctx.get("webServer"); if (webServer?.register) webServer.register({ kind: "exact", path, handler }); }
function registerTools(ctx, memory, enabled) {
  const tools = ctx.get("tools");
  if (!tools?.register) return;
  tools.register(defineTool({ name: "read_memory", description: "Read cross-restart persistent project memory.", parameters: {}, output: { schema: { type: "string" }, render: (_a, value) => [{ type: "text", text: value }] }, async execute() { return enabled.value ? memory.summaryText() || "(no memory yet)" : "Memory is disabled. Enable dsh-memory first."; } }));
  tools.register(defineTool({ name: "write_memory", description: "Write a persistent project memory entry.", parameters: { text: { type: "string", required: true }, summary: { type: "string" } }, output: { schema: { type: "string" }, render: (_a, value) => [{ type: "text", text: value }] }, async execute(args) { if (!enabled.value) return "Memory is disabled. Enable dsh-memory first."; if (typeof args.summary === "string" && args.summary.trim()) memory.setSummary(args.summary); memory.addNote(args.text); return "Memory saved"; } }));
}
function extractText(content) { return Array.isArray(content) ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim() : ""; }

function apply(ctx, config) {
  const resolved = config ?? {};
  const start = () => {
    try {
      migrateLegacyStorage();
      const rc = runtime();
      const enabled = { value: rc.memoryEnabled ?? (resolved.memoryEnabled === true) };
      const memory = new MemoryStore(dir());
      registerTools(ctx, memory, enabled);
      const systemPrompt = ctx.get("systemPrompt");
      if (systemPrompt?.context) systemPrompt.context({ name: "dsh-memory", order: 50, text: () => enabled.value ? memory.getSummary() : "" });
      ctx.on("session/event", (session, event) => { if (enabled.value && event.type === "user/message" && event.data?.source?.kind === "user") { const text = extractText(event.data?.content); if (text) memory.addNote(text, { sessionId: session.id }); } });
      route(ctx, "/settings-pro/memory", (req, res) => { if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405); sendJson(res, enabled.value ? { enabled: true, ...memory.exportJson() } : { disabled: true, enabled: false }); });
      route(ctx, "/settings-pro/memory/toggle", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { const next = runtime(); next.memoryEnabled = body.enabled === true; save(next); enabled.value = next.memoryEnabled; sendJson(res, { enabled: enabled.value, ...(enabled.value ? memory.exportJson() : {}) }); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/settings-pro/memory/export.md", (req, res) => { if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405); const q = new URL(req.url ?? "", "http://localhost").searchParams; const from = q.get("from") ?? ""; const to = q.get("to") ?? ""; res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="memory-${from || "all"}.md"` }); res.end(memory.exportMarkdown({ from, to })); });
      route(ctx, "/settings-pro/memory/clear", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); memory.clear(); sendJson(res, memory.exportJson()); });
      console.log(`[${name}] loaded (enabled=${String(enabled.value)})`);
    } catch (error) { console.error(`[${name}] failed to start:`, error?.message ?? error); }
  };
  const loader = ctx.get("loader");
  if (loader?.await) loader.await().then(start).catch(start); else start();
}

export { Config, apply, inject, name };
export default { name, inject, Config, apply };
