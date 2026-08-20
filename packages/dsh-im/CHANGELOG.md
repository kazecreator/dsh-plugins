# Changelog

## 0.4.0 — 2026-08-20

- Add an optional macOS iMessage channel through the `imsg` CLI.
- Persist the iMessage watch rowid and route replies to the originating private or group chat.
- Add iMessage sender/chat allowlists, runtime connect/disconnect controls, and status-panel reporting.

## 0.2.4 — 2026-08-17

- Fix `/model` switch failure (`Cannot read properties of undefined (reading 'provider')`):
  `llm.resolveCallConfig` returns the resolved call config directly, not a `{ config }`
  wrapper, so destructuring `{ config }` left `config` undefined. Read the result as-is.

## 0.2.3 — 2026-08-15

- Fix WeChat cross-wiring: key each agent/session by CONVERSATION (`from_user_id:context_token`)
  instead of by sender alone, so one user's private chat and group chat no longer collapse
  into a single agent (the "另一个对话串了" bug).
- Add `/stop` command to interrupt the peer's active turn immediately (bypasses the per-peer
  message queue; cancels with `{ kind: "user" }`).
- Add `/effort` command to show or set the chat's reasoning effort (`off` / `high` / `max`),
  scoped to the current conversation only.
- Telegram: delete the transient progress line on completion instead of editing it to a
  permanent "✅ Done" above every reply.
- Telegram: serialize streaming edits through an edit chain so a slow partial edit can no
  longer overwrite the authoritative final reply (fixes truncated replies).

## 0.2.2 — 2026-08-14

- Fix Telegram long-reply loss: when a reply exceeds the 4096-char limit, keep
  the first chunk in the already-streamed message (edit in place) and send the
  rest as follow-ups, instead of deleting the streamed message and re-sending
  everything (which could drop the whole body if a follow-up send failed).
- Retry Telegram API calls on HTTP 429 (rate limiting) with backoff, honoring
  `retry_after`, and log send/edit failures instead of swallowing them silently.
- Handle the `getUpdates` HTTP 409 "terminated by other getUpdates request"
  conflict gracefully: detect it specifically and back off with exponential,
  jittered delays instead of a fixed 2 s retry loop, so two pollers stop
  terminating each other's long-poll in lockstep and a lone poller recovers
  once the competing instance goes away.
- Add a per-agent system-prompt section (`app:dsh-im`) that nudges the model
  toward short plain-text replies that survive the channel length limit; scoped
  to IM-bridge agents only, so web-GUI sessions are unaffected.
- Harden `summarizeTurn` and `#routeEvent` reads so a harness event-shape change
  degrades to a fallback reply instead of throwing.

## 0.2.1 — 2026-08-14

- `/restart` now sends exactly one acknowledgement in the conversation's language
  and a proactive "restart complete" message once the requesting peer's channel
  reconnects. The Telegram `getUpdates` offset and the WeChat `get_updates_buf`
  cursor are persisted so a relaunch no longer re-delivers (and re-runs) already
  processed messages, which previously produced a duplicate restart notice in
  the wrong language.

## 0.2.0 — 2026-08-14

- Persist each peer's session id and resume the session on boot, so IM
  conversation history survives process restarts (`/restart`, redeploys) instead
  of minting a fresh session per peer. The peer → session mapping is written to
  `$DSH_HOME/storages/dsh-im/peers.json`; sessions are flushed to the
  session-persistence backend after each turn and reloaded via `agents.resume`.
  A failed resume falls back to a fresh session and re-records the new id.
- Split long replies before sending: Telegram replies are split at the 4096-char
  text limit and WeChat replies at a byte limit, so long answers are delivered in
  parts instead of being silently dropped.
- Render GFM tables in Telegram as per-row `header: value` lines (records divided
  by a visible "———" line) instead of an aligned monospace table, which wraps
  unreadably when a cell holds long prose.

## 0.1.1 — 2026-08-14

Documentation release.

- Add npm and license badges to the package README
- Add this changelog
- Link the package to its npm page from the repo README

## 0.1.0 — 2026-08-14

First npm release of `@kazecreator/dsh-im`.

- Telegram and WeChat channels, each with its own per-peer agent session
- Web UI panel (a settings section) to connect both channels live
- Interactive `ask_user_question` follow-ups relayed to the chat as plain text
- Markdown rendered per channel: Telegram HTML, WeChat plain text
- Localized built-in messages (zh/en): chat messages follow the conversation
  language, panel/scan/status follow the DSH web UI language
- Slash commands: `/help`, `/model`, `/new`, `/restart`
