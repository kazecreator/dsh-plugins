import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { markdownToPlainText, splitPlainText } from "./markdown.js";
import { t } from "./i18n.js";
import { clearRestartNotice, peekRestartNotice } from "./restart-notice.js";
import { imStoragePath } from "./im-storage.js";

const DEFAULT_COMMAND = "imsg";
const DEFAULT_DEBOUNCE = "250ms";
const IMESSAGE_TEXT_LIMIT = 6000;
const WATCH_RESTART_DELAY_MS = 5000;

function cursorPath() {
  return imStoragePath("imessage-cursor.json");
}

function loadCursor() {
  try {
    const id = Number(JSON.parse(readFileSync(cursorPath(), "utf8"))?.id);
    return Number.isInteger(id) && id >= 0 ? id : null;
  } catch {
    return null;
  }
}

function saveCursor(id) {
  try {
    mkdirSync(dirname(cursorPath()), { recursive: true });
    writeFileSync(cursorPath(), JSON.stringify({ id }) + "\n");
  } catch (error) {
    console.error("[dsh-im] failed to save imessage cursor:", error?.message ?? error);
  }
}

function commandFor(config) {
  const command = typeof config?.imessageCommand === "string" ? config.imessageCommand.trim() : "";
  return command || DEFAULT_COMMAND;
}

function dbArgs(config) {
  const db = typeof config?.imessageDbPath === "string" ? config.imessageDbPath.trim() : "";
  return db === "" ? [] : ["--db", db];
}

/** Build the long-lived imsg watch arguments. Exported for smoke/unit tests. */
export function buildWatchArgs(config = {}, sinceRowid = null) {
  const args = ["watch", "--json", "--debounce", config.imessageWatchDebounce || DEFAULT_DEBOUNCE];
  args.push(...dbArgs(config));
  if (Number.isInteger(sinceRowid) && sinceRowid >= 0) args.push("--since-rowid", String(sinceRowid));
  return args;
}

/** Build the catalog command used to distinguish iMessage chats from SMS chats. */
export function buildChatsArgs(config = {}) {
  return ["chats", "--json", "--limit", "10000", ...dbArgs(config)];
}

/** Build an imsg send command for one direct or group conversation. */
export function buildSendArgs(config = {}, route = {}, text = "") {
  const args = ["send", "--json", "--text", String(text)];
  if (Number.isInteger(route.chatId) && route.chatId > 0) {
    args.push("--chat-id", String(route.chatId));
  } else if (typeof route.chatGuid === "string" && route.chatGuid !== "") {
    args.push("--chat-guid", route.chatGuid);
  } else if (typeof route.chatIdentifier === "string" && route.chatIdentifier !== "") {
    args.push("--chat-identifier", route.chatIdentifier);
  } else if (typeof route.to === "string" && route.to !== "") {
    args.push("--to", route.to, "--service", "imessage");
  } else {
    throw new Error("iMessage route has no chat id, chat guid, chat identifier, or recipient");
  }
  args.push(...dbArgs(config));
  return args;
}

/** Parse one NDJSON line emitted by `imsg watch --json`. */
export function parseImessageLine(line) {
  if (typeof line !== "string" || line.trim() === "") return null;
  try {
    const value = JSON.parse(line);
    return value != null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Prefer the stable local chat row id so private and group conversations stay separate. */
export function imessagePeerId(message) {
  if (Number.isInteger(message?.chat_id) && message.chat_id > 0) return String(message.chat_id);
  for (const value of [message?.chat_guid, message?.chat_identifier, message?.sender]) {
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return "unknown";
}

function stringList(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

/** Apply optional sender/chat allowlists without restricting the default setup. */
export function isAllowedImessageMessage(message, config = {}) {
  const handles = stringList(config.imessageAllowedHandles);
  const chats = stringList(config.imessageAllowedChatIds);
  if (handles.length === 0 && chats.length === 0) return true;
  const sender = typeof message?.sender === "string" ? message.sender.trim() : "";
  const participants = Array.isArray(message?.participants) ? message.participants.map(String) : [];
  const chatIds = [message?.chat_id, message?.chat_guid, message?.chat_identifier]
    .filter((value) => value !== undefined && value !== null)
    .map(String);
  return handles.some((handle) => handle === sender || participants.includes(handle))
    || chats.some((chat) => chatIds.includes(chat));
}

function spawnError(command, args, stderr, stdout, code, signal) {
  const detail = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit ${code}`);
  return new Error(`${command} ${args[0] ?? "command"} failed: ${detail}`);
}

export class ImessageChannel {
  #config;
  #bridge;
  #status;
  #getUiLang;
  #cursor = loadCursor();
  #watch = null;
  #watchBuffer = "";
  #messageQueue = Promise.resolve();
  #imessageChatIds = new Set();
  #chatRefreshTimer = null;
  #restartTimer = null;
  #children = new Set();
  #stopping = false;

  constructor(config, bridge, status, getUiLang) {
    this.#config = config;
    this.#bridge = bridge;
    this.#status = status;
    this.#getUiLang = getUiLang;
  }

  get enabled() {
    return this.#config.imessageEnabled === true;
  }

  start() {
    if (!this.enabled) return;
    this.#stopping = false;
    this.#status?.setImessage({ enabled: true, connected: false, error: null });
    if (process.platform !== "darwin") {
      this.#status?.setImessage({ error: "iMessage channel requires macOS" });
      return;
    }
    this.#refreshChatCatalog().finally(() => {
      if (this.#stopping) return;
      this.#startWatch();
      this.#chatRefreshTimer = setInterval(() => this.#refreshChatCatalog(), 60000);
      this.#chatRefreshTimer.unref?.();
      this.#sendRestartNotice().catch((error) => {
        console.error("[dsh-im] failed to send imessage restart notice:", error?.message ?? error);
      });
    });
  }

  #refreshChatCatalog() {
    const command = commandFor(this.#config);
    const args = buildChatsArgs(this.#config);
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        console.warn("[dsh-im] imessage chat catalog unavailable:", error?.message ?? error);
        resolve();
        return;
      }
      this.#children.add(child);
      let buffer = "";
      let stderr = "";
      const ids = new Set();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const chat = parseImessageLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (chat?.service === "iMessage" && Number.isInteger(chat.id) && chat.id > 0) ids.add(String(chat.id));
        }
      });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        this.#children.delete(child);
        console.warn("[dsh-im] imessage chat catalog unavailable:", error?.message ?? error);
        resolve();
      });
      child.once("close", (code) => {
        this.#children.delete(child);
        if (buffer.trim() !== "") {
          const chat = parseImessageLine(buffer);
          if (chat?.service === "iMessage" && Number.isInteger(chat.id) && chat.id > 0) ids.add(String(chat.id));
        }
        if (code === 0) this.#imessageChatIds = ids;
        else console.warn("[dsh-im] imessage chat catalog unavailable:", stderr.trim() || `exit ${code}`);
        resolve();
      });
    });
  }

  #startWatch() {
    if (this.#stopping || this.#watch != null) return;
    const command = commandFor(this.#config);
    const args = buildWatchArgs(this.#config, this.#cursor);
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      this.#handleWatchFailure(error);
      return;
    }
    this.#watch = child;
    this.#children.add(child);
    this.#status?.setImessage({ connected: true, error: null });
    console.log(`[dsh-im] imessage channel starting (${command} ${args.join(" ")})`);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consumeWatchOutput(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text !== "") console.error(`[dsh-im] imsg: ${text}`);
    });
    child.once("error", (error) => {
      if (this.#watch === child) this.#handleWatchFailure(error);
    });
    child.once("close", (code, signal) => {
      this.#children.delete(child);
      if (this.#watch !== child) return;
      this.#watch = null;
      this.#consumeWatchOutput("\n");
      if (this.#stopping) return;
      this.#handleWatchFailure(spawnError(command, args, "", "", code, signal));
    });
  }

  #consumeWatchOutput(chunk) {
    this.#watchBuffer += String(chunk);
    for (;;) {
      const newline = this.#watchBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#watchBuffer.slice(0, newline).replace(/\r$/, "");
      this.#watchBuffer = this.#watchBuffer.slice(newline + 1);
      const message = parseImessageLine(line);
      if (message == null) continue;
      const id = Number(message.id);
      if (Number.isInteger(id) && id > 0) {
        if (this.#cursor != null && id <= this.#cursor) continue;
        this.#cursor = id;
      }
      this.#messageQueue = this.#messageQueue
        .then(() => this.#handleMessage(message))
        .then(() => {
          if (Number.isInteger(id) && id > 0) saveCursor(id);
        })
        .catch((error) => console.error("[dsh-im] imessage message processing failed:", error?.message ?? error));
    }
  }

  #handleWatchFailure(error) {
    if (this.#stopping) return;
    const message = error?.message ?? String(error);
    console.error("[dsh-im] imessage watch stopped:", message);
    this.#status?.setImessage({ connected: false, error: message });
    if (this.#restartTimer == null) {
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null;
        this.#startWatch();
      }, WATCH_RESTART_DELAY_MS);
      this.#restartTimer.unref?.();
    }
  }

  #handleMessage(message) {
    if (message.is_from_me === true || message.is_reaction === true) return;
    if (!this.#imessageChatIds.has(String(message.chat_id))) return;
    if (!isAllowedImessageMessage(message, this.#config)) {
      console.log(`[dsh-im] imessage: dropped message from ${message.sender ?? "unknown"} (not in allowlist)`);
      return;
    }
    const text = typeof message.text === "string" ? message.text : "";
    if (text.trim() === "") return;
    const peerId = imessagePeerId(message);
    const route = {
      chatId: Number.isInteger(message.chat_id) && message.chat_id > 0 ? message.chat_id : undefined,
      chatGuid: message.chat_guid,
      chatIdentifier: message.chat_identifier,
      to: message.sender,
    };
    console.log(`[dsh-im] imessage: message in ${peerId}: ${text.slice(0, 120)}`);
    const streamer = new ImessageReplyStreamer((reply) => this.#send(route, reply), "en");
    return this.#bridge.handleInbound({
      provider: "imessage",
      peerId,
      text,
      sink: streamer,
      route,
    }).then((reply) => {
      console.log(`[dsh-im] imessage: replied to ${peerId}: ${String(reply ?? "").slice(0, 120)}`);
    }).catch((error) => {
      console.error("[dsh-im] imessage reply failed:", error);
      this.#send(route, `⚠️ ${error?.message ?? String(error)}`).catch(() => {});
    });
  }

  async #sendRestartNotice() {
    const notice = peekRestartNotice("imessage");
    if (notice == null) return;
    await this.#send(notice.route ?? { to: notice.peerId }, t(notice.lang ?? "en", "restart.done"));
    clearRestartNotice("imessage");
  }

  #send(route, text) {
    const plain = markdownToPlainText(text);
    if (plain === "") return Promise.resolve();
    return (async () => {
      for (const chunk of splitPlainText(plain, IMESSAGE_TEXT_LIMIT)) {
        if (chunk !== "") await this.#sendOne(route, chunk);
      }
    })();
  }

  #sendOne(route, text) {
    const command = commandFor(this.#config);
    const args = buildSendArgs(this.#config, route, text);
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let child;
      try {
        child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      this.#children.add(child);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      child.once("error", fail);
      child.once("close", (code, signal) => {
        this.#children.delete(child);
        if (settled) return;
        settled = true;
        if (code === 0) {
          this.#status?.setImessage({ error: null, connected: true });
          resolve(stdout.trim());
        } else {
          const error = spawnError(command, args, stderr, stdout, code, signal);
          this.#status?.setImessage({ error: error.message });
          reject(error);
        }
      });
    });
  }

  stop() {
    this.#stopping = true;
    if (this.#restartTimer != null) clearTimeout(this.#restartTimer);
    if (this.#chatRefreshTimer != null) clearInterval(this.#chatRefreshTimer);
    this.#restartTimer = null;
    this.#chatRefreshTimer = null;
    for (const child of this.#children) {
      try { child.kill(); } catch { /* already exited */ }
    }
    this.#children.clear();
    this.#watch = null;
    this.#status?.setImessage({ connected: false });
  }
}

/** iMessage has no edit-in-place or typing API in the public imsg surface. */
class ImessageReplyStreamer {
  #sendText;
  #lang;
  #labels = [];

  constructor(sendText, lang) {
    this.#sendText = sendText;
    this.#lang = lang ?? "en";
  }

  setLang(lang) {
    this.#lang = lang === "zh" ? "zh" : "en";
  }

  onChunk() {}

  onActivity(label) {
    if (label === t(this.#lang, "activity.thinking")) return;
    if (this.#labels.length < 10 && !this.#labels.includes(label)) this.#labels.push(label);
  }

  async onQuestion(text) {
    await this.#sendText(text);
  }

  async onFinal(text) {
    if (this.#labels.length > 0) await this.#sendText(`⏳ ${this.#labels.join(" → ")}`);
    await this.#sendText(text);
  }
}
