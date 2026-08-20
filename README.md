# dsh-plugins

Independent plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

The former `@kazecreator/dsh-settings-pro` package bundled unrelated features into one plugin. They now live here as separate packages, so a profile only needs to install what it uses:

| Package | Capability |
| --- | --- |
| [`@kazecreator/dsh-im`](./packages/dsh-im) | Telegram, WeChat, and iMessage agent bridge |
| [`@kazecreator/dsh-usage`](./packages/dsh-usage) | DeepSeek balance and official billed usage |
| [`@kazecreator/dsh-memory`](./packages/dsh-memory) | Cross-restart project memory and tools |
| [`@kazecreator/dsh-pets`](./packages/dsh-pets) | Desktop pet, catalog, and activity monitor |
| [`@kazecreator/dsh-vision`](./packages/dsh-vision) | Image-to-text bridge for text-only models |

Each package has its own Cordis entrypoint, configuration schema, web routes, settings section, and `storages/dsh-*` runtime directory. Install the packages independently or together; their routes and state are deliberately namespaced so they can coexist.

## Install

```sh
dsh plugin --profile web add @kazecreator/dsh-memory
dsh plugin --profile web add @kazecreator/dsh-pets
```

Add each package's `example.cordis.patch.yml` entry to the profile patch and restart DSH. The package README documents its config and setup details.

For local development, install a package path with `file:` rather than `link:` so DSH resolves its `@deepseek-ai/*` peers from the profile:

```sh
dsh plugin --profile web add file:/path/to/dsh-plugins/packages/dsh-memory
```

## Development

```sh
pnpm install
pnpm -r exec node --check lib/index.js
```

## License

[MIT](./LICENSE) © 2026 kazeCreator
