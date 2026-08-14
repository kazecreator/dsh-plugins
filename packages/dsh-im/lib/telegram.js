import { markdownToPlainText, markdownToTelegramHtml, splitPlainText } from "./markdown.js";
import { t } from "./i18n.js";

const JSON_HEADERS = { "Content-Type": "application/json" };
/** Telegram `sendMessage` text limit (UTF-16 code units). */
const TELEGRAM_TEXT_LIMIT = 4096;

/**
 * Telegram Bot API channel via long polling (`getUpdates` + `sendMessage`).
 * Uses Node's global `fetch` (no heavy dependency); the DSH web seam only
 * supports GET so this channel owns its HTTP calls.
 */
export class TelegramChannel {
  #config;
  #bridge;
  #status;
  #getUiLang;
  #abort = new AbortController();
  #offset = 0;

  constructor(config, bridge, status, getUiLang) {
    this.#config = config;
    this.#bridge = bridge;
    this.#status = status;
    this.#getUiLang = getUiLang;
  }

  get token() {
    return (this.#config.telegramBotToken ?? "").trim();
  }

  get enabled() {
    return this.#config.telegramEnabled === true && this.token !== "";
  }

  #api(method) {
    const base = (this.#config.telegramApiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    return `${base}/bot${this.token}/${method}`;
  }

  async #call(method, body, signal) {
    const res = await fetch(this.#api(method), {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = void 0;
    }
    if (!res.ok || data?.ok !== true) {
      const detail = data?.description ?? (await res.text().catch(() => ""));
      throw new Error(`telegram ${method} failed (HTTP ${res.status}): ${detail}`);
    }
    return data.result;
  }

  start() {
    if (!this.enabled) return;
    console.log("[dsh-im] telegram channel starting (long polling)");
    this.#status?.setTelegram({ enabled: true, error: null });
    this.#getMe().then((bot) => {
      this.#status?.setTelegram({ connected: true, bot });
    }).catch((error) => {
      this.#status?.setTelegram({ connected: false, error: error?.message ?? String(error) });
    });
    this.#poll().catch((error) => {
      if (error?.name === "AbortError") return;
      console.error("[dsh-im] telegram poll stopped:", error);
      this.#status?.setTelegram({ connected: false, error: error?.message ?? String(error) });
    });
  }

  async #getMe() {
    const me = await this.#call("getMe", {});
    return me?.username ?? null;
  }

  async #poll() {
    while (!this.#abort.signal.aborted) {
      try {
        const updates = await this.#call("getUpdates", {
          offset: this.#offset,
          timeout: Math.max(1, this.#config.telegramPollingTimeout ?? 30),
          allowed_updates: ["message"],
        }, this.#abort.signal);
        this.#status?.setTelegram({ connected: true, error: null });
        for (const update of updates) {
          this.#offset = Math.max(this.#offset, update.update_id + 1);
          const message = update.message;
          if (message == null || message.chat == null) continue;
          if (typeof message.text !== "string") continue;
          this.#handleMessage(message);
        }
      } catch (error) {
        if (this.#abort.signal.aborted || error?.name === "AbortError") break;
        // Transient (network hiccup, a competing getUpdates such as a deploy or
        // a manual probe). Back off and retry rather than killing the channel.
        console.error("[dsh-im] telegram poll error (retrying):", error?.message ?? error);
        this.#status?.setTelegram({ connected: false, error: error?.message ?? String(error) });
        await this.#sleep(2000);
      }
    }
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.#abort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  #handleMessage(message) {
    const chatId = String(message.chat.id);
    const fromId = String(message.from?.id ?? "");
    const allowed = this.#config.telegramAllowedUserIds ?? [];
    if (allowed.length > 0 && !allowed.includes(fromId) && !allowed.includes(chatId)) {
      console.log(`[dsh-im] telegram: dropped message from ${fromId} (not in allowlist)`);
      return;
    }
    const text = message.text ?? "";
    if (text.trim() === "") return;
    console.log(`[dsh-im] telegram: message from ${fromId}: ${text.slice(0, 120)}`);

    // Show "typing…" while the agent works. Telegram clears it automatically
    // when the reply lands, and the action expires after ~5s, so keep it alive.
    const sendTyping = () => this.#call("sendChatAction", { chat_id: message.chat.id, action: "typing" }).catch(() => {});
    sendTyping();
    const typingTimer = setInterval(sendTyping, 4000);

    const streamer = new TelegramReplyStreamer(message.chat.id, (method, body) => this.#call(method, body), this.#getUiLang?.() ?? "en");

    this.#bridge.handleInbound({
      provider: "telegram",
      peerId: chatId,
      text,
      sink: streamer,
    }).then((replyText) => {
      console.log(`[dsh-im] telegram: replied to ${chatId}: ${replyText.slice(0, 120)}`);
    }).catch((error) => {
      console.error("[dsh-im] telegram reply failed:", error);
      return this.#call("sendMessage", {
        chat_id: message.chat.id,
        text: `⚠️ ${error?.message ?? String(error)}`,
      }).catch(() => {});
    }).finally(() => {
      clearInterval(typingTimer);
    });
  }

  stop() {
    this.#abort.abort();
  }
}

/**
 * Implements the bridge's streaming sink for Telegram: streams assistant text
 * into one message edited in place, and mirrors tool activity into a separate
 * status line. Falls back to plain text whenever HTML rendering/editing fails.
 */
class TelegramReplyStreamer {
  #chatId;
  #call;
  #lang;
  #buffer = "";
  #messageId = null;
  #statusId = null;
  #lastLabel = "";
  #editTimer = null;
  #opening = null;
  #activityChain = Promise.resolve();

  constructor(chatId, call, lang) {
    this.#chatId = chatId;
    this.#call = call;
    this.#lang = lang ?? "en";
  }

  #render(md) {
    return markdownToTelegramHtml(md);
  }

  async #send(md) {
    const html = this.#render(md);
    if (html !== "") {
      if (html.length > TELEGRAM_TEXT_LIMIT) return null; // too long for one message
      try {
        const sent = await this.#call("sendMessage", { chat_id: this.#chatId, text: html, parse_mode: "HTML" });
        return sent?.message_id;
      } catch (error) {
        console.warn("[dsh-im] telegram HTML send failed, falling back to plain text:", error?.message ?? error);
      }
    }
    const plain = markdownToPlainText(md);
    if (plain.length > TELEGRAM_TEXT_LIMIT) return null;
    const sent = await this.#call("sendMessage", { chat_id: this.#chatId, text: plain });
    return sent?.message_id;
  }

  async #edit(messageId, md) {
    if (messageId == null) return;
    const html = this.#render(md);
    const body = html !== ""
      ? { chat_id: this.#chatId, message_id: messageId, text: html, parse_mode: "HTML" }
      : { chat_id: this.#chatId, message_id: messageId, text: markdownToPlainText(md) };
    try {
      await this.#call("editMessageText", body);
    } catch (error) {
      // "message is not modified" is benign (debounce re-sent identical text).
      if (/not modified/i.test(error?.message ?? "")) return;
      // HTML parse failure → retry as plain text.
      if (html !== "") {
        await this.#call("editMessageText", { chat_id: this.#chatId, message_id: messageId, text: markdownToPlainText(md) }).catch(() => {});
      }
    }
  }

  #scheduleEdit() {
    if (this.#editTimer != null) return;
    this.#editTimer = setTimeout(() => this.#flushEdit(), 150);
    this.#editTimer.unref?.();
  }

  async #flushEdit() {
    this.#editTimer = null;
    const md = this.#buffer;
    const overLimit = this.#render(md).length > TELEGRAM_TEXT_LIMIT || markdownToPlainText(md).length > TELEGRAM_TEXT_LIMIT;
    if (overLimit) return; // too long to stream in place; onFinal will split it
    if (this.#messageId != null) {
      await this.#edit(this.#messageId, md).catch(() => {});
      return;
    }
    // First render: send once; concurrent flushes await the same opening so a
    // burst of early chunks cannot spawn duplicate messages.
    if (this.#opening == null) {
      this.#opening = (async () => {
        this.#messageId = await this.#send(md);
      })().finally(() => { this.#opening = null; });
    }
    await this.#opening.catch(() => {});
  }

  onChunk(delta) {
    this.#buffer += delta;
    this.#scheduleEdit();
  }

  onActivity(label) {
    if (label === this.#lastLabel) return this.#activityChain;
    this.#lastLabel = label;
    // Serialize status writes so a burst of distinct tool calls cannot spawn
    // duplicate status messages or interleave edits.
    this.#activityChain = this.#activityChain.then(async () => {
      if (this.#statusId == null) {
        const sent = await this.#call("sendMessage", { chat_id: this.#chatId, text: `⏳ ${label}…` });
        this.#statusId = sent?.message_id;
      } else {
        await this.#call("editMessageText", { chat_id: this.#chatId, message_id: this.#statusId, text: `⏳ ${label}…` }).catch(() => {});
      }
    }).catch(() => {});
    return this.#activityChain;
  }

  /** Send a follow-up question as its own message (rendered via HTML when possible). */
  async onQuestion(text) {
    // Flush any streamed partial first so the question lands as a separate
    // message rather than interleaving with the reply edit.
    if (this.#editTimer != null) {
      clearTimeout(this.#editTimer);
      this.#editTimer = null;
    }
    if (this.#buffer !== "") {
      await this.#flushEdit().catch(() => {});
    }
    await this.#send(text).catch(() => {});
  }

  async onFinal(text) {
    // Flush any pending debounced edit and in-flight opening send, then settle
    // on the authoritative final text.
    if (this.#editTimer != null) {
      clearTimeout(this.#editTimer);
      this.#editTimer = null;
    }
    if (this.#opening != null) await this.#opening.catch(() => {});

    const overLimit = this.#render(text).length > TELEGRAM_TEXT_LIMIT || markdownToPlainText(text).length > TELEGRAM_TEXT_LIMIT;
    if (overLimit) {
      // Replace the partial streamed message with a split batch of plain-text
      // messages so a long reply is never silently dropped.
      if (this.#messageId != null) {
        await this.#call("deleteMessage", { chat_id: this.#chatId, message_id: this.#messageId }).catch(() => {});
        this.#messageId = null;
      }
      for (const chunk of splitPlainText(markdownToPlainText(text), TELEGRAM_TEXT_LIMIT)) {
        if (chunk === "") continue;
        await this.#call("sendMessage", { chat_id: this.#chatId, text: chunk }).catch(() => {});
      }
    } else if (this.#messageId != null) {
      await this.#edit(this.#messageId, text);
    } else {
      await this.#send(text);
    }
    // Settle the status line only after any in-flight activity update lands.
    await this.#activityChain.catch(() => {});
    if (this.#statusId != null) {
      await this.#call("editMessageText", { chat_id: this.#chatId, message_id: this.#statusId, text: t(this.#lang, "status.done") }).catch(() => {});
    }
  }
}
