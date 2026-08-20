# @kazecreator/dsh-im

Telegram, WeChat, and iMessage bridge for DeepSeek Harness. Each `provider:peerId` gets its own agent session, with session history, model selection, follow-up questions, `/new`, `/stop`, and `/restart` support.

## Install

```sh
dsh plugin --profile web add @kazecreator/dsh-im
```

Merge [`example.cordis.patch.yml`](./example.cordis.patch.yml) into the profile patch and restart. All channels are off by default.

The Web settings section exposes Telegram token configuration, WeChat QR login, and an iMessage connect toggle. State is stored under `$DSH_HOME/storages/dsh-im/`. State left by the old bundled Settings Pro IM bridge is migrated on first start.

## iMessage setup

iMessage runs locally through the [`imsg`](https://github.com/openclaw/imsg) CLI and the macOS Messages app. Install it with Homebrew:

```sh
brew install steipete/tap/imsg
imsg --version
```

Grant the process running dsh Full Disk Access so `imsg` can read the Messages database, and Automation access to Messages so it can send replies. Enable the channel from the Web settings panel or set `imessageEnabled: true` in the profile patch. The first start begins watching at the newest message; later starts resume from `$DSH_HOME/storages/dsh-im/imessage-cursor.json`.

Inbound private and group conversations are keyed by their local `chat_id`, so they do not share agent history. Use `imessageAllowedHandles` and/or `imessageAllowedChatIds` when the watcher should not respond to every conversation.

The Web panel uses these runtime endpoints:

| Route | Method | Purpose |
| --- | --- | --- |
| `/im/status` | GET | Read live channel status. |
| `/im/imessage/start` | POST | Enable iMessage and start the local watcher. |
| `/im/imessage/stop` | POST | Disable iMessage and stop the local watcher. |

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `agentPreset` | `""` | Agent preset used for IM sessions; empty uses the profile default. |
| `agentReplyTimeoutMs` | `120000` | Idle-silence timeout for an agent turn; `0` disables it. |
| `questionTimeoutMs` | `0` | Follow-up question timeout; `0` waits indefinitely. |
| `commandsEnabled` | `true` | Handle slash commands locally. |
| `restartEnabled` | `true` | Allow `/restart`. |
| `telegramEnabled` | `false` | Enable Telegram polling. |
| `telegramBotToken` | `""` | Bot token from BotFather. |
| `telegramAllowedUserIds` | `[]` | Optional sender allowlist. |
| `telegramPollingTimeout` | `30` | Telegram long-poll timeout in seconds. |
| `telegramApiBase` | `https://api.telegram.org` | Telegram API base URL. |
| `wechatEnabled` | `false` | Enable the WeChat iLink bridge. |
| `imessageEnabled` | `false` | Enable the local macOS iMessage bridge. |
| `imessageCommand` | `imsg` | `imsg` executable or absolute path. |
| `imessageDbPath` | `""` | Optional Messages `chat.db` path; empty uses the macOS default. |
| `imessageWatchDebounce` | `250ms` | Debounce passed to `imsg watch`. |
| `imessageAllowedHandles` | `[]` | Optional exact sender handles or participant handles; empty = allow all. |
| `imessageAllowedChatIds` | `[]` | Optional local `chat_id`/chat GUID/identifier allowlist; empty = allow all. |

iMessage does not use a bot token. It ignores messages sent from the local Mac, only responds to chats identified by `imsg` as iMessage (not SMS), and sends back through the same `chat_id`.
