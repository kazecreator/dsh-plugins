import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Config } from "./config.js";
import { ImBridge } from "./bridge.js";
import { ImStatus } from "./status.js";
import { TelegramChannel } from "./telegram.js";
import { WeChatChannel } from "./wechat.js";

/** Stable Cordis plugin name used by loader diagnostics. */
const name = "dsh-im";

/** Core services the bridge drives through (all provided by dsh-base). */
const inject = ["agents", "agentDefaultModel", "sessions", "llm"];

/** Path of the UI-written runtime overrides (survive restarts, override the patch layer). */
function runtimeConfigPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "storages", "dsh-im", "config.json");
}

/** Read a JSON request body (bounded). */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Runtime controller: owns the two channel instances, the shared status store,
 * and the UI-written overrides file. It can start/stop each channel live so the
 * web panel can connect Telegram (token) and start WeChat (scan) without a
 * profile restart.
 */
class ImController {
  #ctx;
  #bridge;
  #status;
  #patchConfig;
  #runtimeConfig;
  #configPath;
  #telegram = null;
  #wechat = null;

  constructor(ctx, patchConfig) {
    this.#ctx = ctx;
    this.#patchConfig = patchConfig;
    this.#configPath = runtimeConfigPath();
    this.#runtimeConfig = this.#loadRuntimeConfig();
    this.#status = new ImStatus();
    this.#bridge = new ImBridge(ctx, { ...this.#patchConfig, ...this.#runtimeConfig });
  }

  get available() {
    return this.#bridge.available;
  }

  effectiveConfig() {
    return { ...this.#patchConfig, ...this.#runtimeConfig };
  }

  #loadRuntimeConfig() {
    try {
      const parsed = JSON.parse(readFileSync(this.#configPath, "utf8"));
      return parsed != null && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #saveRuntimeConfig() {
    try {
      mkdirSync(dirname(this.#configPath), { recursive: true });
      writeFileSync(this.#configPath, JSON.stringify(this.#runtimeConfig, null, 2) + "\n");
    } catch (error) {
      console.error("[dsh-im] failed to save runtime config:", error);
    }
  }

  start() {
    this.#status.setTelegram({ enabled: this.effectiveConfig().telegramEnabled === true });
    this.#status.setWechat({ enabled: this.effectiveConfig().wechatEnabled === true });
    this.#startTelegram();
    this.#startWechat();
    this.#registerRoutes();
  }

  #startTelegram() {
    if (this.#telegram != null) this.#telegram.stop();
    const config = this.effectiveConfig();
    this.#telegram = new TelegramChannel(config, this.#bridge, this.#status);
    this.#telegram.start();
  }

  #startWechat() {
    if (this.#wechat != null) {
      this.#wechat.stop();
    }
    const config = this.effectiveConfig();
    this.#wechat = new WeChatChannel(config, this.#bridge, this.#status);
    this.#wechat.start().catch((error) => {
      console.error("[dsh-im] wechat start failed:", error);
      this.#status.setWechat({ error: error?.message ?? String(error) });
    });
  }

  setTelegramToken(token) {
    const value = (token ?? "").trim();
    this.#runtimeConfig.telegramEnabled = value !== "";
    if (value !== "") this.#runtimeConfig.telegramToken = value;
    else delete this.#runtimeConfig.telegramToken;
    this.#saveRuntimeConfig();
    this.#startTelegram();
  }

  startWeChat() {
    this.#runtimeConfig.wechatEnabled = true;
    this.#saveRuntimeConfig();
    this.#startWechat();
  }

  logoutWeChat() {
    this.#runtimeConfig.wechatEnabled = false;
    this.#saveRuntimeConfig();
    if (this.#wechat != null) this.#wechat.logout();
    this.#wechat = null;
  }

  statusPayload() {
    const config = this.effectiveConfig();
    const snapshot = this.#status.toJSON();
    return {
      ...snapshot,
      telegram: {
        ...snapshot.telegram,
        tokenConfigured: (config.telegramBotToken ?? "").trim() !== "",
        enabled: config.telegramEnabled === true,
      },
      wechat: {
        ...snapshot.wechat,
        enabled: config.wechatEnabled === true,
      },
    };
  }

  sendJson(res, payload, statusCode = 200) {
    res.writeHead(statusCode, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(JSON.stringify(payload));
  }

  #registerRoutes() {
    const webServer = this.#ctx.get("webServer");
    if (webServer == null || typeof webServer.register !== "function") return;

    webServer.register({
      kind: "exact",
      path: "/im/status",
      handler: (req, res) => {
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.writeHead(405);
          res.end();
          return;
        }
        this.sendJson(res, this.statusPayload());
      },
    });

    webServer.register({
      kind: "exact",
      path: "/im/telegram",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        try {
          const body = await readJson(req);
          this.setTelegramToken(body.token ?? "");
          this.sendJson(res, this.statusPayload());
        } catch (error) {
          this.sendJson(res, { error: error?.message ?? String(error) }, 400);
        }
      },
    });

    webServer.register({
      kind: "exact",
      path: "/im/wechat/start",
      handler: (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        this.startWeChat();
        this.sendJson(res, this.statusPayload());
      },
    });

    webServer.register({
      kind: "exact",
      path: "/im/wechat/logout",
      handler: (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }
        this.logoutWeChat();
        this.sendJson(res, this.statusPayload());
      },
    });

    console.log("[dsh-im] IM status/config endpoints registered");
  }

  dispose() {
    if (this.#telegram != null) this.#telegram.stop();
    if (this.#wechat != null) this.#wechat.stop();
  }
}

/**
 * Mount the IM bridge. Apply is synchronous (Cordis convention); the actual
 * startup waits for the loader to settle so `ctx.agents` has its loop factory,
 * mirroring the headless runner.
 */
function apply(ctx, config) {
  const resolved = config ?? {};
  const loader = ctx.get("loader");
  const start = () => {
    try {
      const controller = new ImController(ctx, resolved);
      if (!controller.available) {
        console.warn("[dsh-im] agent services unavailable in this profile; bridge disabled");
        return;
      }
      controller.start();
      ctx.on("dispose", () => controller.dispose());
    } catch (error) {
      console.error("[dsh-im] failed to start:", error);
    }
  };
  if (loader != null && typeof loader.await === "function") {
    loader.await().then(start).catch((error) => {
      console.error("[dsh-im] loader await failed:", error);
      start();
    });
  } else {
    start();
  }
}

export { Config, apply, inject, name };
export default { name, inject, Config, apply };
