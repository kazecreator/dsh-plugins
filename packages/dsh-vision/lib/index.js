import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { contentHasImage } from "@deepseek-ai/dsh-llm";
import { Config } from "./config.js";
import { VisionService } from "./vision.js";

const name = "dsh-vision";
const inject = [];
const VISION_DONE = Symbol("dsh-vision:done");
const MODALITY_PATCHED = Symbol("dsh-vision:modality-patched");

function home() { return process.env.DSH_HOME ?? join(homedir(), ".dsh"); }
function dir() { return join(home(), "storages", name); }
function configPath() { return join(dir(), "config.json"); }
function runtime() { try { const v = JSON.parse(readFileSync(configPath(), "utf8")); return v && typeof v === "object" ? v : {}; } catch { return {}; } }
function save(value) { mkdirSync(dirname(configPath()), { recursive: true }); writeFileSync(configPath(), JSON.stringify(value, null, 2) + "\n"); }
function migrateLegacyStorage() {
  const legacyPath = join(home(), "storages", "dsh-settings-pro", "config.json");
  if (!existsSync(legacyPath)) return;
  const current = runtime();
  let changed = false;
  try {
    const old = JSON.parse(readFileSync(legacyPath, "utf8"));
    for (const key of ["visionEnabled", "visionBaseUrl", "visionModel", "visionApiKeyEnv", "visionMaxTokens", "visionTimeoutMs"]) {
      if (current[key] === undefined && old?.[key] !== undefined) { current[key] = old[key]; changed = true; }
    }
  } catch { /* no legacy runtime config */ }
  if (changed) save(current);
}
function sendJson(res, payload, statusCode = 200) { res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" }); res.end(JSON.stringify(payload)); }
function readJson(req, maxBytes = 1e6) { return new Promise((resolve, reject) => { let body = ""; req.on("data", (chunk) => { body += chunk; if (body.length > maxBytes) req.destroy(new Error("body too large")); }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } }); req.on("error", reject); }); }
function route(ctx, path, handler) { const webServer = ctx.get("webServer"); if (webServer?.register) webServer.register({ kind: "exact", path, handler }); }
async function describeBlock(attachments, vision, block) {
  try { const stored = await attachments.readImage(block.attachment); const text = String(await vision.describe(stored.data, { mediaType: stored.ref.mediaType, question: "" })).trim(); return text ? `[Image content] ${text}` : "[Image]"; }
  catch { return "[Image]"; }
}
async function describeMessages(attachments, vision, messages) {
  const output = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content) || !contentHasImage(message.content)) { output.push(message); continue; }
    const content = [];
    for (const block of message.content) {
      if (block?.type === "image") content.push({ type: "text", text: await describeBlock(attachments, vision, block) });
      else if (block?.type === "tool-result" && Array.isArray(block.content) && contentHasImage(block.content)) {
        const nested = [];
        for (const item of block.content) nested.push(item?.type === "image" ? { type: "text", text: await describeBlock(attachments, vision, item) } : item);
        content.push({ ...block, content: nested });
      } else content.push(block);
    }
    output.push({ ...message, content });
  }
  return output;
}

function apply(ctx, config) {
  const resolved = config ?? {};
  const start = () => {
    try {
      migrateLegacyStorage();
      const rc = runtime();
      const vision = new VisionService(ctx, { ...resolved, ...rc });
      ctx.on("llm/stream", (options, next) => {
        if (options[VISION_DONE] || !vision.enabled || !Array.isArray(options.messages) || !options.messages.some((m) => Array.isArray(m?.content) && contentHasImage(m.content))) return next();
        const attachments = ctx.get("attachments");
        const llm = ctx.get("llm");
        if (!attachments?.readImage || !llm?.stream) return next();
        return (async function* () { const messages = await describeMessages(attachments, vision, options.messages); yield* llm.stream({ ...options, messages, [VISION_DONE]: true }); })();
      }, { global: true, prepend: true });
      const llm = ctx.get("llm");
      if (llm?.resolveModelInfo && !llm[MODALITY_PATCHED]) {
        llm[MODALITY_PATCHED] = true;
        const original = llm.resolveModelInfo.bind(llm);
        llm.resolveModelInfo = async (provider, model, signal) => {
          const info = await original(provider, model, signal);
          if (!vision.enabled || !info || !Array.isArray(info.inputModalities) || info.inputModalities.includes("image")) return info;
          return { ...info, inputModalities: [...info.inputModalities, "image"] };
        };
      }
      route(ctx, "/vision/status", (req, res) => { if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405); sendJson(res, { enabled: vision.enabled, baseUrl: vision.baseUrl, model: vision.model, apiKeyEnv: vision.apiKeyEnv, maxTokens: vision.config.visionMaxTokens ?? 2048 }); });
      route(ctx, "/vision/describe", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req, 12 * 1024 * 1024).then((body) => { const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(String(body?.dataUrl ?? "")); if (!match) throw new Error("Missing dataUrl image data"); return vision.describe(Buffer.from(match[2], "base64"), { mediaType: match[1].toLowerCase(), question: body?.question ?? "", lang: body?.lang === "zh" ? "zh" : "en" }); }).then((description) => sendJson(res, { description })).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/vision/models", (req, res) => { if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405); let baseUrl; try { baseUrl = new URL(req.url ?? "", "http://localhost").searchParams.get("baseUrl") ?? undefined; } catch {} vision.listModels({ baseUrl }).then((models) => { const filtered = models.filter((id) => VisionService.isVisionModel(id)); sendJson(res, { models, vision: filtered.length ? filtered : models }); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/vision/providers", (req, res) => { if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405); vision.listVisionProviders().then((providers) => sendJson(res, { providers })).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/vision/config", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { const next = runtime(); for (const key of ["visionEnabled", "visionBaseUrl", "visionModel", "visionApiKeyEnv", "visionMaxTokens", "visionTimeoutMs"]) if (body[key] !== undefined) next[key] = body[key]; save(next); vision.config = { ...resolved, ...next }; sendJson(res, { enabled: vision.enabled, baseUrl: vision.baseUrl, model: vision.model, apiKeyEnv: vision.apiKeyEnv, maxTokens: next.visionMaxTokens ?? 2048 }); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      console.log(`[${name}] loaded (enabled=${String(vision.enabled)})`);
    } catch (error) { console.error(`[${name}] failed to start:`, error?.message ?? error); }
  };
  const loader = ctx.get("loader");
  if (loader?.await) loader.await().then(start).catch(start); else start();
}

export { Config, apply, inject, name };
export default { name, inject, Config, apply };
