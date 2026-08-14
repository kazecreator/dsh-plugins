# @kaze/dsh-im

DeepSeek Harness **IM bridge plugin**: route inbound **Telegram** and **WeChat**
messages into per-peer agent sessions and send the agent's reply back to the
originating chat. Each `provider:peerId` pair gets its own live DSH Agent, so
conversation history persists for the process lifetime.

- **Telegram** — official Bot API over long polling (`getUpdates`/`sendMessage`),
  no heavy dependencies (uses Node's global `fetch`).
- **WeChat** — the official Tencent OpenClaw Weixin `ilink` protocol: QR
  *connects* the AI bot to WeChat (not a device login), then long-polls
  `getupdates` and replies via `sendmessage`. No heavy dependency.

## Install & enable

The plugin is a plain Cordis plugin (not a bundle), so enablement is two steps:
install it into the profile, then insert a patch row.

```sh
# 1. install into a profile (copies the package into the profile's node_modules)
cd /path/to/kaze-ds-plugins
dsh plugin --profile web add file:./dsh-im

# 2. edit $DSH_HOME/profiles/web/cordis.patch.yml (see example.cordis.patch.yml)
```

> Use `file:` (copy), not `link:`: the profile resolves a plugin's
> `@deepseek-ai/*` peers through `$DSH_HOME/profiles/node_modules` (the flat
> fallback), and a `link:` symlink would re-anchor resolution at the checkout
> directory where those peers are absent.

Minimal patch (Telegram only; both channels off by default so the bridge is
inert until you opt in):

```yaml
- insert:
    - id: dsh-im
      name: '@kaze/dsh-im'
      config:
        telegramEnabled: true
        telegramBotToken: '123456:ABC-...'
        # telegramAllowedUserIds: ['123456789']   # optional allowlist; empty = allow all
        wechatEnabled: false
```

Restart the profile for the change to take effect.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `agentPreset` | `""` | Agent preset id to join (empty = the profile's default preset). In Web profiles this gives the IM agent the same tools/prompt as a normal Web session. |
| `agentReplyTimeoutMs` | `120000` | Idle-silence timeout (ms): if the agent produces no session events (steps, tool calls, chunks) for this long, the turn is cancelled and a fallback reply is sent. Long research/code tasks that keep emitting progress are **not** cut off. Set `0` to disable. |
| `questionTimeoutMs` | `0` | How long (ms) to wait for an answer to a follow-up question (`ask_user_question`) before giving up and cancelling the question. `0` (default) waits indefinitely — the user is now in the loop, and `/new`/`/restart` remain the escape hatches. |
| `commandsEnabled` | `true` | Enable inline slash commands (`/help`, `/model`, `/new`). Set `false` to forward every message (including `/…`) to the agent unchanged. |
| `restartEnabled` | `true` | Allow `/restart` to relaunch the dsh web process in place. Set `false` to keep the command but refuse to restart. |
| `telegramEnabled` | `false` | Enable the Telegram channel. |
| `telegramBotToken` | `""` | Telegram bot token from `@BotFather`. |
| `telegramAllowedUserIds` | `[]` | Optional allowlist of sender user/chat ids; empty = allow all. |
| `telegramPollingTimeout` | `30` | `getUpdates` long-poll timeout (seconds). |
| `telegramApiBase` | `https://api.telegram.org` | API base (e.g. a self-hosted Bot API). |
| `wechatEnabled` | `false` | Enable the WeChat channel. |

## WeChat

WeChat uses the **official Tencent OpenClaw Weixin protocol** (`ilink`), the
same backend as `@tencent-weixin/openclaw-weixin`. Scanning the QR *connects
this AI bot to WeChat* through `liteapp.weixin.qq.com` — it is not a device
login, so it does not trip WeChat's new-device security warning (wechaty's
web-protocol QR does, which is why wechaty is not used).

Flow: `ilink/bot/get_bot_qrcode` → show QR → poll `ilink/bot/get_qrcode_status`
→ on `confirmed` hold a bot token → long-poll `ilink/bot/getupdates` and reply
via `ilink/bot/sendmessage`. Credentials persist to
`$DSH_HOME/storages/dsh-im/wechat.json`, so the bot reconnects without
rescanning. No extra dependency is required (plain HTTPS + the bundled
`qrcode` package).

## Web UI panel

The package is dual-face: the host half serves a small HTTP API, and the client
half (`./client`) injects an **IM Bridge** section into the Web Settings page
(via the `settings.section` slot, `order: 100`). Opening Settings shows a panel
with two named channel sections:

- **Telegram** — status + a token input. Enter a `@BotFather` token and hit
  Save/Connect to connect live; leave it empty to disconnect.
- **WeChat** — status + a Scan to connect button. When waiting for a scan, the login
  QR renders directly in the panel for scanning.

Colors use DSH theme tokens (`--dsw-alias-*`), so the panel follows light/dark.

Host HTTP surface (all under the web server origin):

| Route | Method | Purpose |
|---|---|---|
| `/im/status` | GET | Live status + effective config. |
| `/im/telegram` | POST `{token}` | Set Telegram token, restart the channel. |
| `/im/wechat/start` | POST | Enable WeChat and start the scan. |
| `/im/wechat/logout` | POST | Log WeChat out and disable it. |

UI writes persist to `$DSH_HOME/storages/dsh-im/config.json` and override the
patch layer; the panel polls `/im/status` every 3 s.

- `dsh.client` in `package.json` + `exports["./client"]` is how the web bundle
  discovers and serves the client half.
- The client bundle is a hand-written `window.__ModuleLoader__.load(...)`
  module (no build step); it needs no client-side dependencies beyond React.

Client-plugin discovery is restart-only (the host module table scans on boot),
so restart the profile after installing the package for the section to appear.

## Slash commands

Messages that *start* with `/` are handled by the bridge locally (they never
reach the model, so they cost no credits and need no tools). Anything else —
including a `/` that is not the first character — is sent to the agent as a
normal prompt.

| Command | Effect |
|---|---|
| `/help` | List the available commands. |
| `/model` | Show the current model and the provider/model catalog. |
| `/model <provider>/<model>` | Switch **this chat's** model (e.g. `/model deepseek-official/deepseek-v4-pro`). A bare model id also works when unambiguous (e.g. `/model deepseek-v4-flash`). |
| `/model reset` | Revert to the profile's default model for this chat. |
| `/new` (alias `/reset`) | Drop this chat's in-memory agent and start a fresh conversation. |
| `/restart` | Relaunch the dsh web process in place; channels reconnect automatically afterwards. |

Model switches are **per peer** (per chat) and survive `/new`: the selection is
kept in a per-peer override and re-applied when the next agent is created. They
do **not** rewrite the profile-wide default model. The catalog is read live
through the `llm` service, so it reflects whatever providers/adapters the
profile currently has registered.

`/restart` re-executes the current process (`process.argv`) as a detached child
and exits, so it works however dsh was launched (`dsh web`, `npm exec`, `npx`).
The reply is delivered **before** the process exits; the child only triggers the
parent's exit after it reports a successful spawn, so a failed relaunch leaves
the bridge running. Because a restart drops the in-memory agent state and takes
a few seconds, it is a DoS surface: keep Telegram's `telegramAllowedUserIds`
allowlist tight, and note that WeChat has no allowlist today.

## Notes / limitations

- The bridge is **in-memory**: agents (and history) live for the process
  lifetime. On restart a peer gets a fresh session. Session-id persistence +
  `agents.resume` is a planned follow-up.
- **Telegram replies stream live**: assistant text is edited into one message
  in place as it is generated, and tool activity is mirrored into a separate
  status line (e.g. `⏳ Searching code…`).
- **WeChat shows a "typing…" indicator** (`ilink/bot/sendtyping`) while the
  agent works, then sends a single coalesced progress summary (e.g.
  `⏳ Searching code → Editing file`) followed by the final answer. iLink has no
  incremental delivery (no in-place edit), so per-token streaming is not
  possible; progress is coalesced to respect the ~7 msgs / 5 min outbound rate
  limit.
- In Web profiles the bridge joins the active/default agent preset so code
  search and other tools behave like a normal Web session. The `agentReplyTimeoutMs`
  above is an **idle** watchdog (reset on every new event), so it keeps a stuck
  tool call from permanently blocking that chat while letting genuinely
  long-running research/code tasks finish.
- **Follow-up questions work interactively.** When the agent calls
  `ask_user_question`, the bridge relays the question (with its numbered
  options) to the chat and pauses the idle watchdog until you reply. Your next
  message answers it — reply with the option number, the option label, or free
  text — and the agent continues. Multiple questions are asked one at a time.
  Sending a slash command (e.g. `/new`) while a question is pending cancels the
  question instead of answering it. `questionTimeoutMs` bounds the wait if you
  prefer a timeout over waiting indefinitely.
- Non-text messages are ignored by both channels.
- The plugin never restarts its channels on its own; disable/enable via the
  profile patch and a restart.
