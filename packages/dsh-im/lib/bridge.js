import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { parseCommand } from "./commands.js";
import { parseAnswer, renderQuestion } from "./questions.js";

const DEFAULT_REPLY_TIMEOUT_MS = 120000;
const CANCEL_SETTLE_TIMEOUT_MS = 5000;

const TIMEOUT_FALLBACK = "⏳ The agent timed out, so I stopped the task. Send it again or let me retry another way.";

/** Human-friendly activity labels for common tools; anything else falls back to the raw name. */
const ACTIVITY_LABELS = {
  bash: "Running command",
  read: "Reading file",
  grep: "Searching code",
  glob: "Finding files",
  edit: "Editing file",
  write: "Writing file",
  web_search: "Searching the web",
  ask_user_question: "Awaiting confirmation",
  todo_write: "Updating task list",
};

function activityLabel(name) {
  return ACTIVITY_LABELS[name] ?? name;
}

/** Remove DSH's `<invoke>`/`<function_calls>` text fallback, which some models emit when tools are unavailable. */
function stripFakeToolCallMarkup(text) {
  if (!/<invoke\b/i.test(text) && !/<function_calls?\b/i.test(text)) return text;
  let cleaned = text.replace(/<\s*invoke\b[^>]*\/\s*>/gi, "");
  cleaned = cleaned.replace(/<\s*invoke\b[\s\S]*?<\/\s*invoke\s*>/gi, "");
  cleaned = cleaned.replace(/<\s*function_calls?\b[^>]*\/\s*>/gi, "");
  cleaned = cleaned.replace(/<\s*function_calls?\b[\s\S]*?<\/\s*function_calls?\s*>/gi, "");
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

/** Call an optional sink method, swallowing sync throws and logging async rejections. */
function emit(sink, method, arg) {
  const fn = sink?.[method];
  if (typeof fn !== "function") return;
  try {
    const result = fn.call(sink, arg);
    if (result != null && typeof result.then === "function") {
      result.catch((error) => console.error(`[dsh-im] sink.${method} failed:`, error?.message ?? error));
    }
  } catch (error) {
    console.error(`[dsh-im] sink.${method} failed:`, error?.message ?? error);
  }
}

/**
 * Idle watchdog: fires `onTimeout` after `timeoutMs` of *inactivity*. Every
 * `poke()` restarts the deadline, so a turn that keeps producing session events
 * (steps, tool calls, stream chunks) never trips it — only a genuinely silent,
 * stuck period (e.g. a hanging `ask_user_question`) does. `timeoutMs <= 0`
 * disables the watchdog entirely.
 */
function makeWatchdog(timeoutMs, onTimeout) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { poke() {}, disarm() {}, pause() {}, resume() {} };
  }
  let timer = null;
  let disarmed = false;
  let paused = false;
  const clear = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = () => {
    clear();
    timer = setTimeout(() => {
      timer = null;
      if (!disarmed && !paused) onTimeout();
    }, timeoutMs);
    timer.unref?.();
  };
  arm();
  return {
    poke() {
      if (!disarmed && !paused) arm();
    },
    pause() {
      paused = true;
      clear();
    },
    resume() {
      paused = false;
      arm();
    },
    disarm() {
      disarmed = true;
      clear();
    },
  };
}

/**
 * Routes inbound IM messages into per-peer DSH agent sessions and captures the
 * assistant reply to hand back to the originating chat.
 *
 * One live Agent is created per `provider:peerId` key and reused across
 * messages, so conversation history persists for the process lifetime. Turns
 * are serialized per peer with a promise chain: an agent drives one turn at a
 * time and a racing second message must not interleave its `whenIdle()` wait
 * with the first.
 *
 * Each turn streams into a channel-supplied `sink` object whose methods are
 * all optional:
 *   - `onChunk(delta)`     — visible assistant text delta (streaming).
 *   - `onActivity(label)`  — what the agent is doing now (tool call / thinking).
 *   - `onFinal(text)`      — the authoritative final reply (or fallback text).
 */
export class ImBridge {
  #ctx;
  #agents;
  #defaultModel;
  #llm;
  #sessions;
  #workspaceRegistry;
  #agentPresets;
  #agentPresetId;
  #replyTimeoutMs;
  #commandsEnabled;
  #restartEnabled;
  #agentsByPeer = new Map();
  #queuesByPeer = new Map();
  #handlersBySession = new Map();
  #modelOverridesByPeer = new Map();
  #holdersByPeer = new Map();
  #peerBySessionId = new Map();
  #turnsByPeer = new Map();
  #questionWaitersByPeer = new Map();
  #questionTimeoutMs;
  #upstreamQuestionProvider;

  constructor(ctx, config = {}) {
    this.#ctx = ctx;
    this.#agents = ctx.get("agents");
    this.#defaultModel = ctx.get("agentDefaultModel");
    this.#llm = ctx.get("llm");
    this.#sessions = ctx.get("sessions");
    this.#workspaceRegistry = ctx.get("workspaceRegistry");
    this.#agentPresets = ctx.get("agentPresets");
    this.#agentPresetId = typeof config.agentPreset === "string" && config.agentPreset.trim() !== ""
      ? config.agentPreset.trim()
      : void 0;
    this.#replyTimeoutMs = Number.isFinite(config.agentReplyTimeoutMs) && config.agentReplyTimeoutMs >= 0
      ? config.agentReplyTimeoutMs
      : DEFAULT_REPLY_TIMEOUT_MS;
    this.#commandsEnabled = config.commandsEnabled !== false;
    this.#restartEnabled = config.restartEnabled !== false;
    this.#questionTimeoutMs = Number.isFinite(config.questionTimeoutMs) && config.questionTimeoutMs > 0
      ? config.questionTimeoutMs
      : 0;

    // One process-wide subscription to the append feed; each turn registers a
    // per-session handler keyed by session id so live events drive streaming,
    // progress, and the idle watchdog.
    if (this.#ctx != null && typeof this.#ctx.on === "function") {
      this.#ctx.on("session/event", (session, event) => {
        const handler = this.#handlersBySession.get(session.id);
        if (handler != null) handler(event);
      });
    }

    // Relay `ask_user_question` follow-ups to the IM chat instead of the Web
    // provider (which the IM user cannot see or answer).
    this.#installQuestionProvider();
  }

  /** The bridge can only drive agents when the core agent services are present. */
  get available() {
    return this.#agents != null && this.#defaultModel != null;
  }

  #peerKey(provider, peerId) {
    return `${provider}:${peerId}`;
  }

  /** Resolve the IM peer that owns a live agent, or `undefined` for non-IM agents. */
  #peerForAgent(agent) {
    if (agent == null) return void 0;
    return this.#peerBySessionId.get(agent.id ?? agent.session?.id);
  }

  /**
   * Install the follow-up-question routing provider on `ctx.userQuestions`.
   *
   * The seam allows exactly one provider per context, and in Web profiles
   * `dsh-host-apiproxy` registers the browser provider first (bundle loads
   * before this patch's insert). Rather than throw `DUPLICATE_PROVIDER`, we wrap
   * that provider: IM-owned agents are relayed to the chat, everything else
   * delegates to the Web provider unchanged.
   */
  #installQuestionProvider() {
    const userQuestions = this.#ctx.get("userQuestions");
    if (userQuestions == null) {
      console.warn("[dsh-im] userQuestions service unavailable; follow-up questions will not be relayed");
      return;
    }
    const bridge = this;
    const router = {
      ask(request) {
        const peerKey = bridge.#peerForAgent(request?.agent);
        if (peerKey != null) return bridge.#askInIm(peerKey, request);
        const upstream = bridge.#upstreamQuestionProvider;
        if (upstream != null) return upstream.ask(request);
        return Promise.reject(new Error("no user-questions provider is available"));
      },
    };
    const upstream = userQuestions.provider;
    this.#upstreamQuestionProvider = upstream;
    if (upstream == null) {
      userQuestions.registerProvider(router);
    } else {
      userQuestions.provider = router;
    }
  }

  /** Relay one `ask_user_question` request to the IM chat, one question at a time. */
  async #askInIm(peerKey, request) {
    const turn = this.#turnsByPeer.get(peerKey);
    // A follow-up question is a legitimate wait for the human: hold the idle
    // watchdog so it does not cancel the turn while the user is answering.
    turn?.watchdog?.pause();
    try {
      const answers = [];
      for (const question of request.questions ?? []) {
        await this.#sendQuestion(turn, renderQuestion(question));
        const answerText = await this.#waitForAnswer(peerKey, request.signal);
        answers.push(parseAnswer(answerText, question));
      }
      return { answers };
    } finally {
      turn?.watchdog?.resume();
    }
  }

  /** Send a question through the active turn's sink (best-effort, awaited). */
  async #sendQuestion(turn, text) {
    const sink = turn?.sink;
    const onQuestion = sink?.onQuestion;
    if (typeof onQuestion === "function") {
      try {
        await onQuestion.call(sink, text);
      } catch (error) {
        console.error("[dsh-im] failed to send question:", error?.message ?? error);
      }
      return;
    }
    // Fallback for a sink that only knows how to stream assistant text.
    if (typeof sink?.onChunk === "function") {
      sink.onChunk(`\n\n${text}\n\n`);
    }
  }

  /** Wait for the peer's next message (the answer), honoring abort + timeout. */
  #waitForAnswer(peerKey, signal) {
    if (signal?.aborted) {
      return Promise.reject(new Error("ask_user_question was aborted before the user answered"));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const onAbort = () => finish(reject, new Error("ask_user_question was aborted before the user answered"));
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        this.#questionWaitersByPeer.delete(peerKey);
        if (timer != null) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn(value);
      };
      if (this.#questionTimeoutMs > 0) {
        timer = setTimeout(() => finish(reject, new Error("Timed out waiting for an answer; the question was cancelled")), this.#questionTimeoutMs);
        timer.unref?.();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#questionWaitersByPeer.set(peerKey, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
    });
  }

  #acquireAgent(peerKey) {
    const cached = this.#agentsByPeer.get(peerKey);
    if (cached) return cached;
    const creating = this.#createAgent(peerKey);
    this.#agentsByPeer.set(peerKey, creating);
    creating.catch(() => this.#agentsByPeer.delete(peerKey));
    return creating;
  }

  /**
   * One peer's mutable model-selection holder, mirroring the harness's own
   * per-session selection: a `current` getter/setter that `installModelSelection`
   * snapshots on each prompt assembly. When the peer has no explicit override,
   * `current` reads the live Agent default so the chat follows default changes.
   */
  #makeSelectionHolder() {
    const defaultModel = this.#defaultModel;
    let picked;
    return {
      get current() {
        if (picked !== undefined) return picked;
        return defaultModel?.currentSelection();
      },
      set current(next) {
        picked = next;
      },
      clear() {
        picked = undefined;
      },
      assembled: undefined,
    };
  }

  /** Dedicated workspace directory for IM sessions, so they group under one named workspace. */
  #imWorkspaceDir() {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    return join(home, "storages", "dsh-im", "im-workspace");
  }

  /** Create/reuse the "IM Bridge" workspace and attach a session to it (best-effort). */
  async #attachToImWorkspace(sessionId) {
    const registry = this.#workspaceRegistry;
    if (registry == null) return;
    const dir = this.#imWorkspaceDir();
    const existing = await registry.resolveByPath(dir).catch(() => undefined);
    const workspace = existing ?? await registry.create(dir, "IM Bridge");
    await workspace.attachSession(sessionId);
  }

  async #createAgent(peerKey) {
    const holder = this.#makeSelectionHolder();
    const override = this.#modelOverridesByPeer.get(peerKey);
    if (override !== undefined) holder.current = override;
    const selection = holder.current;
    const cwd = this.#imWorkspaceDir();
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      // Workspace creation is best-effort; the session still works without it.
    }
    let presetId = this.#agentPresetId;
    if (this.#agentPresets?.resolveMountable != null) {
      const preset = await this.#agentPresets.resolveMountable(presetId);
      presetId = preset.id;
    }
    const { agent, dispose } = await this.#agents.create({
      sessionId: SessionId(`session-${randomUUID()}`),
      meta: {
        cwd,
        ...presetId === void 0 ? {} : { agentPreset: presetId },
      },
      agentOptions: {
        provider: selection.provider,
        model: selection.model,
      },
      setup: async (agentCtx) => {
        installModelSelection(agentCtx, holder);
        // Web profiles keep model-facing tools inside agent presets. Join the
        // active/default preset so this IM agent gets the same coding tools as a
        // Web session instead of an empty global tool layer. On profiles without
        // a preset roster the tools remain global and this is a no-op.
        if (this.#agentPresets?.mount != null) {
          await this.#agentPresets.mount(agentCtx, presetId);
        }
      },
    });
    await agent.whenIdle();
    this.#peerBySessionId.set(agent.session.id, peerKey);
    try {
      await this.#attachToImWorkspace(agent.session.id);
    } catch (error) {
      console.error("[dsh-im] failed to attach session to IM workspace:", error?.message ?? error);
    }
    this.#holdersByPeer.set(peerKey, holder);
    return { agent, dispose };
  }

  /** Classify one live session event into sink calls (streaming text + activity). */
  #routeEvent(event, sink, streamState) {
    switch (event.type) {
      case "assistant/chunk": {
        const chunk = event.data.chunk;
        if (chunk?.type === "text-delta" && typeof chunk.text === "string" && chunk.text !== "") {
          streamState.streamed = true;
          streamState.thinkingShown = false;
          emit(sink, "onChunk", chunk.text);
        } else if (chunk?.type === "reasoning-delta" && !streamState.thinkingShown) {
          streamState.thinkingShown = true;
          emit(sink, "onActivity", "Thinking…");
        }
        break;
      }
      case "tool/call": {
        streamState.thinkingShown = false;
        emit(sink, "onActivity", activityLabel(event.data.name));
        break;
      }
      default:
        break;
    }
  }

  async #handleTurn(peerKey, agent, text, sink) {
    const firstSeq = agent.session.seq;
    let timedOut = false;
    const streamState = { streamed: false, thinkingShown: false };

    // Post-cancel settle bound: resolves only after the watchdog cancels and the
    // turn still has not converged, so a tool ignoring its abort signal cannot
    // wedge this peer's message queue forever.
    let forceSettle = () => {};
    const settleBound = new Promise((resolve) => { forceSettle = resolve; });
    let settleTimer = null;

    const watchdog = makeWatchdog(this.#replyTimeoutMs, () => {
      timedOut = true;
      console.warn("[dsh-im] agent idle timeout; cancelling the active turn");
      try {
        agent.cancel({ kind: "hook", reason: "dsh-im idle timeout" });
      } catch (error) {
        console.error("[dsh-im] failed to cancel timed-out agent:", error?.message ?? error);
      }
      settleTimer = setTimeout(forceSettle, CANCEL_SETTLE_TIMEOUT_MS);
      settleTimer.unref?.();
    });

    const handler = (event) => {
      watchdog.poke();
      this.#routeEvent(event, sink, streamState);
    };
    this.#handlersBySession.set(agent.session.id, handler);
    // Publish the active turn so the follow-up-question provider can pause the
    // watchdog and reach this peer's sink while the agent waits for the human.
    this.#turnsByPeer.set(peerKey, { sink, watchdog });

    try {
      agent.followup(createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      }));
      await Promise.race([agent.whenIdle(), settleBound]);
    } finally {
      this.#turnsByPeer.delete(peerKey);
      if (settleTimer != null) clearTimeout(settleTimer);
      watchdog.disarm();
      this.#handlersBySession.delete(agent.session.id);
    }

    if (this.#sessions != null) await this.#sessions.flush(agent.session).catch(() => {});
    const outcome = summarizeTurn(agent.session.events, firstSeq);
    let replyText = outcome.text;
    if (timedOut && replyText === "") replyText = TIMEOUT_FALLBACK;
    if (replyText === "") replyText = fallbackForTurnReason(outcome.reason);
    if (replyText !== "") emit(sink, "onFinal", replyText);
    return replyText;
  }

  /**
   * Handle one inbound message: serialize on the peer, feed the agent, stream
   * progress, and reply with the final assistant text.
   *
   * @param {{provider: string, peerId: string, text: string, sink?: object, reply?: (text: string) => Promise<unknown>}} input
   * @returns {Promise<string>} the assistant reply text.
   */
  handleInbound({ provider, peerId, text, sink, reply }) {
    const peerKey = this.#peerKey(provider, peerId);
    const resolvedSink = normalizeSink(sink, reply);
    const command = this.#commandsEnabled ? parseCommand(text) : null;

    // A follow-up question is awaiting this peer's next message. Answer it
    // directly rather than queueing a turn behind the (blocked) asking turn.
    const waiter = this.#questionWaitersByPeer.get(peerKey);
    if (waiter != null) {
      if (command != null) {
        // A slash command while a question is pending is an escape hatch: cancel
        // the question so the turn settles, then run the command below.
        waiter.reject(new Error("Received a command while waiting for an answer; cancelled the question"));
      } else {
        waiter.resolve(text);
        return Promise.resolve(text);
      }
    }

    const previous = this.#queuesByPeer.get(peerKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (command != null) {
        const replyText = await this.#runCommand(peerKey, command);
        if (replyText !== "") await this.#replyNow(resolvedSink, replyText);
        if (command.name === "restart" && this.#restartEnabled) this.#restartProcess();
        return replyText;
      }
      const { agent } = await this.#acquireAgent(peerKey);
      return await this.#handleTurn(peerKey, agent, text, resolvedSink);
    });
    // Keep the chain alive on failure so the peer queue never wedges.
    this.#queuesByPeer.set(peerKey, next.catch(() => {}));
    return next;
  }

  // --- slash commands -------------------------------------------------------

  /** Dispatch one parsed command and return the plain-text reply. */
  async #runCommand(peerKey, { name, args }) {
    switch (name) {
      case "help":
        return this.#helpText();
      case "model":
        return await this.#modelCommand(peerKey, args);
      case "new":
      case "reset":
        return await this.#resetCommand(peerKey);
      case "restart":
        return this.#restartReply();
      default:
        return `Unknown command /${name}. Send /help to see available commands.`;
    }
  }

  #helpText() {
    return [
      "IM Bridge commands:",
      "/help — show this help",
      "/model — show the current model and available models",
      "/model <provider>/<model> — switch this chat's model (e.g. /model deepseek-official/deepseek-v4-flash)",
      "/model reset — restore the default model",
      "/new (or /reset) — clear this chat and start a new conversation",
      "/restart — restart the dsh web process (continue chatting after it's back)",
    ].join("\n");
  }

  #restartReply() {
    if (!this.#restartEnabled) return "The restart command is disabled (restartEnabled: false).";
    return "Restarting dsh web… give it a moment, then continue chatting.";
  }

  /** Send a command reply through the sink and await its delivery. */
  async #replyNow(sink, text) {
    const onFinal = sink?.onFinal;
    if (typeof onFinal !== "function") return;
    try {
      await onFinal.call(sink, text);
    } catch (error) {
      console.error("[dsh-im] failed to send command reply:", error?.message ?? error);
    }
  }

  /**
   * Relaunch this dsh process (self re-exec) and exit. The reply above has
   * already been delivered, so a channel reply lands before the restart. We
   * only exit after the child reports a successful `spawn`, so a failed launch
   * leaves the bridge running instead of silently going down.
   */
  #restartProcess() {
    const args = process.argv.slice(1);
    console.log("[dsh-im] restarting dsh web process:", process.execPath, ...args);
    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: process.cwd(),
        detached: true,
        stdio: "inherit",
        env: process.env,
      });
    } catch (error) {
      console.error("[dsh-im] failed to launch restart child:", error?.message ?? error);
      return;
    }
    child.on("spawn", () => {
      console.log("[dsh-im] restart child launched; exiting");
      setTimeout(() => process.exit(0), 250);
    });
    child.on("error", (error) => {
      console.error("[dsh-im] restart child failed to launch; staying up:", error?.message ?? error);
    });
    child.unref();
  }

  /** Load the provider→models catalog through the `llm` service (best-effort). */
  async #loadCatalog() {
    if (this.#llm == null) return [];
    const groups = [];
    for (const provider of this.#llm.listProviders() ?? []) {
      try {
        const models = await this.#llm.listModels(provider.id);
        groups.push({ provider, models });
      } catch (error) {
        groups.push({ provider, models: [], error: error?.message ?? String(error) });
      }
    }
    return groups;
  }

  /** Current selection for one peer: live holder, then override, then default. */
  #currentSelection(peerKey) {
    const holder = this.#holdersByPeer.get(peerKey);
    if (holder != null) return holder.current;
    return this.#modelOverridesByPeer.get(peerKey) ?? this.#defaultModel?.currentSelection();
  }

  async #modelCommand(peerKey, args) {
    const arg = (args ?? "").trim();
    if (arg === "reset" || arg === "default") {
      this.#modelOverridesByPeer.delete(peerKey);
      this.#holdersByPeer.get(peerKey)?.clear();
      return await this.#modelStatus(peerKey);
    }
    if (arg === "") return await this.#modelStatus(peerKey);
    return await this.#switchModel(peerKey, arg);
  }

  async #modelStatus(peerKey) {
    const current = this.#currentSelection(peerKey);
    const groups = await this.#loadCatalog();
    const lines = [];
    lines.push(`Current model: ${current?.provider ?? "?"}/${current?.model ?? "?"}`);
    lines.push("");
    lines.push("Available models:");
    if (groups.length === 0) {
      lines.push("(model service unavailable; cannot list models)");
    }
    for (const { provider, models, error } of groups) {
      if (models.length === 0) {
        lines.push(`• ${provider.name} (${provider.id})${error ? `: ${error}` : ": no models available"}`);
        continue;
      }
      lines.push(`• ${provider.name} (${provider.id})`);
      for (const model of models) {
        const mark = current?.provider === provider.id && current?.model === model.id ? " ✓" : "";
        lines.push(`    - ${model.id}${mark}`);
      }
    }
    lines.push("");
    lines.push("Switch: /model <provider>/<model> or /model <model>");
    lines.push("Reset: /model reset");
    return lines.join("\n");
  }

  async #switchModel(peerKey, arg) {
    if (this.#llm == null) return "Model service unavailable; cannot switch.";
    let provider;
    let model;
    if (arg.includes("/")) {
      const [head, ...rest] = arg.split("/");
      provider = head.trim();
      model = rest.join("/").trim();
    } else {
      model = arg;
      provider = await this.#findProviderForModel(model);
      if (provider === undefined) {
        return `Model "${model}" not found. Send /model to see available models.`;
      }
    }
    if (provider === "" || model === "") return `Usage: /model <provider>/<model> (e.g. /model deepseek-official/deepseek-v4-pro).`;
    try {
      const { config } = await this.#llm.resolveCallConfig({ provider, model });
      const selected = {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      };
      this.#modelOverridesByPeer.set(peerKey, selected);
      const holder = this.#holdersByPeer.get(peerKey);
      if (holder != null) holder.current = selected;
      return `Switched to ${selected.provider}/${selected.model}. Applies to this chat only.`;
    } catch (error) {
      return `Switch failed: ${error?.message ?? String(error)}`;
    }
  }

  /** Resolve a bare model id to a unique provider; undefined when not found. */
  async #findProviderForModel(model) {
    const groups = await this.#loadCatalog();
    const matches = groups
      .filter(({ models }) => models.some((entry) => entry.id === model))
      .map(({ provider }) => provider.id);
    if (matches.length === 1) return matches[0];
    return undefined;
  }

  async #resetCommand(peerKey) {
    await this.#resetPeer(peerKey);
    return "Started a new conversation; history cleared.";
  }

  /** Drop the peer's live agent (and its model holder) so the next message mints a fresh one. */
  async #resetPeer(peerKey) {
    const pending = this.#agentsByPeer.get(peerKey);
    this.#agentsByPeer.delete(peerKey);
    this.#holdersByPeer.delete(peerKey);
    // Cancel a pending follow-up question and drop turn state so a stale answer
    // cannot misroute or wedge the reset.
    this.#questionWaitersByPeer.get(peerKey)?.reject(new Error("Conversation reset"));
    this.#turnsByPeer.delete(peerKey);
    if (pending == null) return;
    try {
      const handle = await pending;
      this.#peerBySessionId.delete(handle.agent.session.id);
      await handle.dispose();
    } catch (error) {
      console.error("[dsh-im] failed to dispose agent on reset:", error?.message ?? error);
    }
  }
}

/** Normalize the channel-supplied sink: prefer `sink`, else wrap a legacy `reply(text)` function. */
function normalizeSink(sink, reply) {
  if (sink != null && typeof sink === "object") return sink;
  if (typeof reply === "function") {
    return {
      onFinal: (text) => reply(text),
    };
  }
  return {};
}

/** Aggregate the last assistant text and turn outcome after `firstSeq`. */
function summarizeTurn(events, firstSeq) {
  let started = false;
  let text = "";
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === "turn/start") {
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      const cleaned = stripFakeToolCallMarkup(joined);
      if (cleaned !== "") text = cleaned;
    }
    if (event.type === "turn/end") reason = event.data.reason;
  }
  return { text, reason };
}

/** Turn a non-text turn ending into a human-readable IM fallback reply. */
function fallbackForTurnReason(reason) {
  switch (reason?.kind) {
    case "error": {
      const detail = reason.error?.message ?? "unknown error";
      return `⚠️ Failed: ${detail}`;
    }
    case "aborted":
      return "⚠️ The reply was cancelled. Please send it again.";
    case "interrupted":
      return "⚠️ The reply was interrupted. Please send it again.";
    case "blocked":
      return "⚠️ The reply was blocked. Please rephrase or try again later.";
    case "max-tokens":
      return "⚠️ The reply exceeded the length limit. Please narrow the scope and retry.";
    case "completed":
    default:
      return "I finished, but no sendable reply was produced this time. Please ask again or rephrase.";
  }
}
