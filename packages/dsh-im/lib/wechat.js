import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import QRCode from "qrcode";

/**
 * WeChat channel over the official Tencent OpenClaw Weixin protocol
 * (`@tencent-weixin/openclaw-weixin`, ilink). Scanning the QR *connects this
 * AI bot to the user's WeChat* (an authorized bot session) — it is NOT a
 * device login, which is why wechaty's web-protocol QR triggered WeChat's
 * security warning and this one does not.
 *
 * Flow: `get_bot_qrcode` → show QR → poll `get_qrcode_status` → on `confirmed`
 * we hold a bot token and long-poll `getupdates` / reply via `sendmessage`.
 * Credentials persist to `$DSH_HOME/storages/dsh-im/wechat.json` so the bot
 * reconnects without rescanning.
 */

const BASE_URL = "https://ilinkai.weixin.qq.com";
const BOT_TYPE = "3";
const APP_ID = "bot";                       // the openclaw-weixin ilink app id
const CLIENT_VERSION = "132102";            // uint32 for channel version 2.4.6
const CHANNEL_VERSION = "2.4.6";

function credentialsPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "storages", "dsh-im", "wechat.json");
}

function loadCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveCredentials(creds) {
  try {
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2) + "\n");
  } catch (error) {
    console.error("[dsh-im] failed to save wechat credentials:", error);
  }
}

function clearCredentials() {
  try {
    if (existsSync(credentialsPath())) writeFileSync(credentialsPath(), "");
  } catch {
    /* ignore */
  }
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function commonHeaders() {
  return {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
  };
}

function authHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function baseInfo() {
  return { channel_version: CHANNEL_VERSION, bot_agent: "OpenClaw" };
}

async function postJson(base, endpoint, body, token, timeoutMs, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 15000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/${endpoint}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`weixin ${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function getJson(base, endpoint, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? 35000);
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/${endpoint}`, {
      method: "GET",
      headers: commonHeaders(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`weixin ${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function extractText(message) {
  const items = message.item_list ?? [];
  const parts = [];
  for (const item of items) {
    if (item.type === 1 && item.text_item && typeof item.text_item.text === "string") {
      parts.push(item.text_item.text);
    }
  }
  return parts.join("");
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export class WeChatChannel {
  #config;
  #bridge;
  #status;
  #abort = new AbortController();
  #creds = null;
  #getUpdatesBuf = "";
  #polling = false;
  #typingTickets = new Map();
  #typingTimers = new Set();

  constructor(config, bridge, status) {
    this.#config = config;
    this.#bridge = bridge;
    this.#status = status;
  }

  get enabled() {
    return this.#config.wechatEnabled === true;
  }

  async start() {
    if (!this.enabled) return;
    this.#status.setWechat({ enabled: true, error: null });
    this.#creds = loadCredentials();
    if (this.#creds && this.#creds.botToken) {
      this.#status.setWechat({ loggedIn: true, userName: this.#creds.botId ?? this.#creds.userId ?? null });
      this.#startPolling();
    } else {
      this.#startLogin().catch((error) => {
        console.error("[dsh-im] weixin login failed:", error);
        this.#status.setWechat({ scanning: false, qrcode: null, error: error?.message ?? String(error) });
      });
    }
  }

  async #startLogin() {
    console.log("[dsh-im] weixin: fetching bot QR code...");
    const res = await postJson(BASE_URL, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, {
      local_token_list: [],
    }, null, 15000);
    console.log("[dsh-im] weixin: QR response received, rendering...");
    const qrcode = res.qrcode;
    const imgContent = res.qrcode_img_content || qrcode;
    if (!imgContent) throw new Error("weixin did not return a QR code");
    const dataUrl = await QRCode.toDataURL(imgContent, { width: 280, margin: 1, errorCorrectionLevel: "M" });
    this.#status.setWechat({ scanning: true, qrStatus: "wait", qrcode: dataUrl });
    console.log("[dsh-im] weixin: QR ready, waiting for scan");
    await this.#pollLogin(qrcode);
  }

  async #pollLogin(qrcode) {
    while (!this.#abort.signal.aborted) {
      let st;
      try {
        st = await getJson(BASE_URL, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, 35000);
      } catch (error) {
        // Long-poll timeout is normal; keep waiting.
        await sleep(500, this.#abort.signal);
        continue;
      }
      console.log(`[dsh-im] weixin: QR status = ${st.status ?? "wait"}`);
      this.#status.setWechat({ qrStatus: st.status ?? "wait" });
      switch (st.status) {
        case "confirmed": {
          if (!st.bot_token) {
            this.#status.setWechat({ scanning: false, qrcode: null, error: "server did not return bot_token" });
            return;
          }
          this.#creds = {
            botToken: st.bot_token,
            botId: st.ilink_bot_id,
            userId: st.ilink_user_id,
            baseUrl: st.baseurl || BASE_URL,
          };
          saveCredentials(this.#creds);
          this.#status.setWechat({ loggedIn: true, scanning: false, qrcode: null, qrStatus: null, userName: st.ilink_bot_id ?? st.ilink_user_id ?? null });
          this.#startPolling();
          return;
        }
        case "expired":
        case "binded_redirect":
        case "verify_code_blocked": {
          this.#status.setWechat({ scanning: false, qrcode: null, error: `Connection not completed (${st.status}); please scan again` });
          return;
        }
        case "need_verifycode": {
          this.#status.setWechat({ error: "WeChat requires a pairing verification code, which is not supported in the panel yet; please try again later" });
          break;
        }
        case "scaned":
        case "scaned_but_redirect":
        case "wait":
        default:
          break;
      }
      await sleep(1000, this.#abort.signal);
    }
  }

  #startPolling() {
    if (this.#polling) return;
    this.#polling = true;
    this.#poll().catch((error) => {
      console.error("[dsh-im] weixin poll stopped:", error);
      this.#status.setWechat({ error: error?.message ?? String(error) });
      this.#polling = false;
    });
  }

  async #poll() {
    while (!this.#abort.signal.aborted) {
      try {
        const resp = await postJson(this.#creds.baseUrl ?? BASE_URL, "ilink/bot/getupdates", {
          get_updates_buf: this.#getUpdatesBuf,
          base_info: baseInfo(),
        }, this.#creds.botToken, 45000, this.#abort.signal);
        if (typeof resp.get_updates_buf === "string") this.#getUpdatesBuf = resp.get_updates_buf;
        for (const message of resp.msgs ?? []) {
          this.#handleMessage(message);
        }
      } catch (error) {
        // Only a channel stop aborts the loop. A client-side long-poll timeout
        // (AbortError from the 45s backstop) or a transient network error just
        // means "no news yet" — retry, never exit.
        if (this.#abort.signal.aborted) break;
        if (error?.name !== "AbortError") {
          console.error("[dsh-im] weixin getUpdates error (retrying):", error?.message ?? error);
        }
        await sleep(2000, this.#abort.signal);
      }
    }
  }

  #handleMessage(message) {
    if (message.message_type === 2) return; // our own bot echo
    const text = extractText(message);
    if (text === "") return;
    const fromId = String(message.from_user_id ?? "unknown");
    const contextToken = message.context_token;
    console.log(`[dsh-im] weixin: message from ${fromId}: ${text.slice(0, 120)}`);

    // Show a "typing…" indicator while the agent works (WeChat iLink has no streaming).
    const typing = this.#beginTyping(fromId, contextToken);
    const streamer = new WeChatReplyStreamer(
      (t) => this.#send(fromId, contextToken, t),
      typing,
    );

    this.#bridge.handleInbound({
      provider: "wechat",
      peerId: fromId,
      text,
      sink: streamer,
    }).catch((error) => {
      console.error("[dsh-im] weixin reply failed:", error);
      typing.stop();
      return this.#send(fromId, contextToken, `⚠️ ${error?.message ?? String(error)}`).catch(() => {});
    }).finally(() => {
      typing.stop();
    });
  }

  async #send(toUserId, contextToken, text) {
    await postJson(this.#creds.baseUrl ?? BASE_URL, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `dsh-im:${Date.now()}-${randomBytes(4).toString("hex")}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken ?? undefined,
      },
      base_info: baseInfo(),
    }, this.#creds.botToken, 15000);
  }

  async #getTypingTicket(userId, contextToken) {
    const now = Date.now();
    const cached = this.#typingTickets.get(userId);
    if (cached != null && now < cached.nextFetchAt) return cached.ticket;
    try {
      const data = await postJson(this.#creds.baseUrl ?? BASE_URL, "ilink/bot/getconfig", {
        ilink_user_id: userId,
        context_token: contextToken ?? null,
        base_info: baseInfo(),
      }, this.#creds.botToken, 15000);
      const ticket = typeof data?.typing_ticket === "string" ? data.typing_ticket : "";
      this.#typingTickets.set(userId, { ticket, nextFetchAt: now + 24 * 60 * 60 * 1000 });
      return ticket;
    } catch (error) {
      console.warn("[dsh-im] weixin getconfig failed:", error?.message ?? error);
      this.#typingTickets.set(userId, { ticket: "", nextFetchAt: now + 60 * 1000 });
      return "";
    }
  }

  async #sendTyping(userId, ticket, status) {
    if (!ticket) return;
    await postJson(this.#creds.baseUrl ?? BASE_URL, "ilink/bot/sendtyping", {
      ilink_user_id: userId,
      typing_ticket: ticket,
      status,
      base_info: baseInfo(),
    }, this.#creds.botToken, 15000);
  }

  /** Start a "typing…" indicator (+ keepalive) for one inbound turn; returns { stop }. */
  #beginTyping(userId, contextToken) {
    let ticket = "";
    let timer = null;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer != null) {
        clearInterval(timer);
        this.#typingTimers.delete(timer);
        timer = null;
      }
      if (ticket) this.#sendTyping(userId, ticket, 2).catch(() => {});
    };

    (async () => {
      try {
        ticket = await this.#getTypingTicket(userId, contextToken);
        if (stopped || !ticket) return;
        await this.#sendTyping(userId, ticket, 1);
        if (stopped) return;
        timer = setInterval(() => {
          if (!stopped) this.#sendTyping(userId, ticket, 1).catch(() => {});
        }, 5000);
        timer.unref?.();
        this.#typingTimers.add(timer);
      } catch (error) {
        console.warn("[dsh-im] weixin typing failed:", error?.message ?? error);
      }
    })();

    return { stop };
  }

  logout() {
    this.#abort.abort();
    this.#clearTypingTimers();
    clearCredentials();
    this.#status.setWechat({ enabled: false, loggedIn: false, scanning: false, qrcode: null, qrStatus: null, userName: null, error: null });
  }

  stop() {
    this.#abort.abort();
    this.#clearTypingTimers();
  }

  #clearTypingTimers() {
    for (const timer of this.#typingTimers) clearInterval(timer);
    this.#typingTimers.clear();
  }
}

/**
 * Implements the bridge's sink for WeChat. iLink has no incremental message
 * delivery (no edit-in-place), so there is no per-token streaming: assistant
 * text deltas are ignored and the authoritative final answer is sent whole by
 * `onFinal`. Tool activity is coalesced into one progress summary message so we
 * never burn WeChat's outbound rate limit (~7 msgs / 5 min) with per-tool spam.
 */
class WeChatReplyStreamer {
  #sendText;
  #typing;
  #labels = [];
  #lastLabel = "";

  constructor(sendText, typing) {
    this.#sendText = sendText;
    this.#typing = typing; // { stop(): void }
  }

  onChunk() {
    // No-op: WeChat buffers deltas server-side; onFinal carries the full text.
  }

  onActivity(label) {
    if (label === this.#lastLabel || label === "Thinking…") return;
    this.#lastLabel = label;
    if (this.#labels.length < 10 && !this.#labels.includes(label)) {
      this.#labels.push(label);
    }
  }

  /** Send a follow-up question as its own message (iLink has no streaming). */
  async onQuestion(text) {
    await this.#sendText(text).catch(() => {});
  }

  async onFinal(text) {
    this.#typing?.stop();
    if (this.#labels.length > 0) {
      await this.#sendText(`⏳ ${this.#labels.join(" → ")}`).catch(() => {});
    }
    await this.#sendText(text).catch(() => {});
  }
}
