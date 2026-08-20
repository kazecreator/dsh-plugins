import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Config } from "./config.js";
import { cachedCatalog, fetchCatalog, readCatalogFetchedAt, resolveZhName } from "./codex-pets.js";
import { PetAppManager } from "./pet-app.js";
import { PET_PAGE } from "./pet-page.js";
import { PetStore } from "./pet-store.js";
import { PetsMonitor } from "./pets.js";

const name = "dsh-pets";
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
    for (const key of ["petsEnabled", "petSize", "petOpenMode", "activePet", "petMaxGoalRounds"]) {
      if (current[key] === undefined && old?.[key] !== undefined) { current[key] = old[key]; changed = true; }
    }
  } catch { /* no legacy runtime config */ }
  if (changed) save(current);
  for (const name of ["pets", "pet-app", "pet-app-state.json"]) {
    const source = join(legacy, name);
    const target = join(dir(), name);
    if (!existsSync(source) || existsSync(target)) continue;
    try { mkdirSync(dir(), { recursive: true }); cpSync(source, target, { recursive: true }); } catch { /* best effort */ }
  }
}
function sendJson(res, payload, statusCode = 200) { res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" }); res.end(JSON.stringify(payload)); }
function readJson(req, maxBytes = 1e6) { return new Promise((resolve, reject) => { let body = ""; req.on("data", (chunk) => { body += chunk; if (body.length > maxBytes) req.destroy(new Error("body too large")); }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } }); req.on("error", reject); }); }
function route(ctx, path, handler) { const webServer = ctx.get("webServer"); if (webServer?.register) webServer.register(typeof path === "string" ? { kind: "exact", path, handler } : { ...path, handler }); }
function allowGet(req, res) { if (req.method === "GET" || req.method === "HEAD") return true; sendJson(res, { error: "method not allowed" }, 405); return false; }

function apply(ctx, config) {
  const resolved = config ?? {};
  const start = () => {
    try {
      migrateLegacyStorage();
      const root = dir();
      const rc = runtime();
      const enabled = { value: rc.petsEnabled ?? (resolved.petsEnabled === true) };
      const pets = new PetsMonitor(ctx, { ...resolved, ...rc, petsEnabled: enabled.value });
      pets.start();
      const store = new PetStore(root);
      const app = new PetAppManager(root);
      const clients = new Set();
      const installs = new Map();
      const broadcast = (payload) => { const data = `data: ${JSON.stringify(payload)}\n\n`; for (const client of clients) { try { client.write(data); } catch { clients.delete(client); } } };
      const statusPayload = () => ({ ...pets.status(), petSize: Number(runtime().petSize) || 84, petOpenMode: String(runtime().petOpenMode || "browser") });
      const listPayload = () => ({ active: store.active(), pets: store.list() });
      pets.onStatusChange = () => broadcast({ type: "pet-status", status: statusPayload() });
      app.onStateChange = (state) => broadcast({ type: "pet-app-status", state });

      route(ctx, "/settings-pro/pets", (req, res) => { if (allowGet(req, res)) sendJson(res, statusPayload()); });
      route(ctx, "/settings-pro/pets/toggle", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { const next = runtime(); next.petsEnabled = body.enabled === true; save(next); enabled.value = next.petsEnabled; pets.setEnabled(enabled.value); broadcast({ type: "pet-status", status: statusPayload() }); sendJson(res, statusPayload()); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/settings-pro/pets/size", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { const next = runtime(); next.petSize = Math.max(40, Math.min(200, Number(body?.size) || 84)); save(next); broadcast({ type: "pet-size-changed", petSize: next.petSize }); sendJson(res, { petSize: next.petSize }); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/settings-pro/pets/open-mode", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { const next = runtime(); next.petOpenMode = body?.mode === "app" ? "app" : "browser"; save(next); broadcast({ type: "pet-status", status: statusPayload() }); sendJson(res, { petOpenMode: next.petOpenMode }); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/settings-pro/pets/clear-goals", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); pets.clearLegacyGoals(); sendJson(res, { ok: true, status: statusPayload() }); });
      route(ctx, "/pet", (req, res) => { if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); res.end(PET_PAGE); });
      route(ctx, "/pets/events", (req, res) => { if (!allowGet(req, res)) return; res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" }); res.write(`data: ${JSON.stringify({ type: "hello", status: statusPayload() })}\n\n`); clients.add(res); req.on("close", () => clients.delete(res)); });
      route(ctx, "/pets/list", (req, res) => { if (allowGet(req, res)) sendJson(res, listPayload()); });
      route(ctx, "/pets/active", (req, res) => { if (allowGet(req, res)) sendJson(res, store.get(store.active()) ?? store.list()[0] ?? null); });
      route(ctx, "/pets/select", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { store.setActive(body?.id); broadcast({ type: "pet-changed" }); sendJson(res, listPayload()); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/pets/add", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req, 24 * 1024 * 1024).then((body) => { const pet = body?.zip ? store.addFromZip(Buffer.from(body.zip, "base64")) : store.addFromSteps(body ?? {}); store.setActive(pet.id); broadcast({ type: "pet-changed" }); sendJson(res, listPayload()); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/pets/remove", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then((body) => { store.remove(body?.id); broadcast({ type: "pet-changed" }); sendJson(res, listPayload()); }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });
      route(ctx, "/pets/installs", (req, res) => { if (allowGet(req, res)) sendJson(res, Object.fromEntries(installs)); });

      const catalogPayload = (items) => { const installed = new Set(store.listCodex().map((pet) => pet.id)); return { fetchedAt: readCatalogFetchedAt(root), pets: items.map((entry) => ({ id: entry.slug, name: entry.localized_names?.en ?? entry.name ?? entry.slug ?? "", nameZh: resolveZhName(entry.slug, entry.name, entry.localized_names), author: entry.author ?? "", category: entry.primary_category ?? "", license: entry.license ?? "", description: entry.description ?? "", installed: installed.has(entry.slug) })) }; };
      route(ctx, "/pets/catalog", async (req, res) => { if (!allowGet(req, res)) return; try { let items = cachedCatalog(root); if (!items || Date.now() - readCatalogFetchedAt(root) > 7 * 24 * 60 * 60 * 1000) { try { items = await fetchCatalog(root); } catch (error) { if (!items) throw error; } } sendJson(res, catalogPayload(items ?? [])); } catch (e) { sendJson(res, { error: e?.message ?? String(e) }, 500); } });
      route(ctx, "/pets/catalog/refresh", async (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); try { sendJson(res, catalogPayload(await fetchCatalog(root))); } catch (e) { sendJson(res, { error: e?.message ?? String(e) }, 500); } });
      route(ctx, "/pets/install-codex", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); readJson(req).then(async (body) => { const id = String(body?.id ?? ""); const report = (phase, percent, error) => { installs.set(id, { phase, percent, error }); broadcast({ type: "install-progress", petId: id, phase, percent, error }); }; report("fetching", 0); try { const pet = await store.installCodex(id, (p) => report(p?.phase ?? "downloading", p?.total ? Math.round((Number(p.loaded) / Number(p.total)) * 100) : 0)); store.setActive(pet.id); report("done", 100); installs.delete(id); broadcast({ type: "pet-changed" }); sendJson(res, listPayload()); } catch (e) { installs.delete(id); report("error", 0, e?.message ?? String(e)); sendJson(res, { error: e?.message ?? String(e) }, 400); } }).catch((e) => sendJson(res, { error: e?.message ?? String(e) }, 400)); });

      route(ctx, "/pets/app/status", (req, res) => { if (allowGet(req, res)) sendJson(res, app.status()); });
      route(ctx, "/pets/app/install", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); app.install().catch(() => {}); sendJson(res, app.status()); });
      route(ctx, "/pets/app/launch", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); try { sendJson(res, app.launch()); } catch (e) { sendJson(res, { ...app.status(), error: e?.message ?? String(e) }, 400); } });
      route(ctx, "/pets/app/stop", (req, res) => { if (req.method !== "POST") return sendJson(res, { error: "method not allowed" }, 405); sendJson(res, app.stop()); });
      route(ctx, { kind: "prefix", path: "/pets/codex" }, (req, res) => servePetFile(req, res, root, "codex"));
      route(ctx, { kind: "prefix", path: "/pets/user" }, (req, res) => servePetFile(req, res, root, "user"));
      console.log(`[${name}] loaded (enabled=${String(enabled.value)})`);
    } catch (error) { console.error(`[${name}] failed to start:`, error?.message ?? error); }
  };
  const loader = ctx.get("loader");
  if (loader?.await) loader.await().then(start).catch(start); else start();
}

function servePetFile(req, res, root, kind) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, { error: "method not allowed" }, 405);
  try {
    const rel = decodeURIComponent((req.url ?? "").replace(new RegExp(`^/pets/${kind}/?`), "").split("?")[0]);
    if (rel.includes("..") || rel.split("/").some((part) => !/^[a-zA-Z0-9._-]+$/.test(part))) return sendJson(res, { error: "invalid path" }, 400);
    const file = join(root, "pets", kind, rel);
    const body = readFileSync(file);
    const ext = file.split(".").pop()?.toLowerCase();
    const type = ext === "webp" ? "image/webp" : ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
}

export { Config, apply, inject, name };
export default { name, inject, Config, apply };
