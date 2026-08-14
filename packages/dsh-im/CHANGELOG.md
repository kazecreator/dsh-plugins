# Changelog

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
