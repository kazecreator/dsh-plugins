# Changelog

## Unreleased

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
