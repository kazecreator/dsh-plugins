# @kazecreator/dsh-memory

Cross-restart project memory shared by the Web, Telegram, and WeChat experiences. It provides `read_memory` and `write_memory`, captures direct user prompts, injects the rolling summary into new prompts, and supports Markdown export from Settings.

```sh
dsh plugin --profile web add @kazecreator/dsh-memory
```

Use [`example.cordis.patch.yml`](./example.cordis.patch.yml) and restart. The feature is opt-in with `memoryEnabled: false`; data lives under `$DSH_HOME/storages/dsh-memory/`.
