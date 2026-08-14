# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

## Plugins

### [dsh-im](./packages/dsh-im) — Telegram & WeChat IM bridge

Chat with your dsh agent straight from **Telegram** or **WeChat** instead of the
web UI. Each chat runs its own agent session, replies stream back live, and when
the agent needs to ask you something it sends the question (with numbered
options) as a normal message you can answer.

Published on npm as [`@kazecreator/dsh-im`](https://www.npmjs.com/package/@kazecreator/dsh-im).

[Install & configure →](./packages/dsh-im/README.md)

## Install a plugin

Plugins are published to npm under the `@kazecreator` scope:

```sh
dsh plugin --profile <profile> add @kazecreator/dsh-im
```

Then merge the plugin's `example.cordis.patch.yml` into
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` and restart the profile.

Every plugin documents its own setup — required config, defaults, and usage —
in its `README.md`, so follow the link above for the full steps.

## License

[MIT](./LICENSE) © 2026 kazeCreator
