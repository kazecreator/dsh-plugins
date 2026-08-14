# dsh-plugins

Monorepo of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`dsh`) plugins by [kazeCreator](https://github.com/kazecreator). Each plugin is
an independent package under [`packages/`](./packages), sharing one repo, one
license, and the public [`dsh-plugin`](https://github.com/topics/dsh-plugin)
GitHub topic so the whole collection is discoverable in the DSH ecosystem.

> DeepSeek Harness is currently in _developer preview_ and iterates rapidly.
> Plugins here track the `@deepseek-ai/*` peer dependencies listed per package;
> expect compatibility updates as the harness evolves.

## Plugins

| Plugin | Package | Description |
|---|---|---|
| [dsh-im](./packages/dsh-im) | `@kaze/dsh-im` | Route Telegram & WeChat messages into per-peer agent sessions and reply back (with Web UI panel + interactive follow-up questions). |

## Install a plugin

Each plugin has its own `README.md` with the exact install and config steps. In
short, for a plugin at `packages/<name>`:

```sh
cd packages/<name>
dsh plugin --profile <profile> add file:.
```

Then merge that plugin's `example.cordis.patch.yml` into
`$DSH_HOME/profiles/<profile>/cordis.patch.yml` and restart the profile.

> Use `file:` (copy), not `link:`: a profile resolves a plugin's
> `@deepseek-ai/*` peers through `$DSH_HOME/profiles/node_modules`, and a
> `link:` symlink would re-anchor resolution at the source checkout where those
> peers are absent.

## Adding a new plugin

Every plugin follows the same package structure under `packages/<name>/`:

```
packages/<name>/
  package.json              # name @kaze/<name>; keywords include "dsh-plugin"
  lib/index.js              # Cordis plugin: export { apply, inject, name }
  lib/...                   # plugin modules
  README.md                 # install + config docs
  example.cordis.patch.yml  # patch snippet to merge into cordis.patch.yml
  LICENSE                   # MIT
```

Checklist for a new plugin:

1. **`package.json`** — set `name` (`@kaze/<name>`), `license: "MIT"`, the
   `@deepseek-ai/*` `peerDependencies` your plugin imports, and `keywords`
   including `dsh-plugin`. If the plugin ships a Web UI panel, add a
   `dsh.client` block and an `exports["./client"]` entry (see `dsh-im` for a
   working example).
2. **`lib/index.js`** — a Cordis plugin exporting `apply`, `inject`, and `name`.
3. **`example.cordis.patch.yml`** — a copy-paste patch row so users can enable
   the plugin without reading the code.
4. **`README.md`** — document install, config keys (with defaults), and any
   runtime endpoints/state.
5. **Keep credentials out of the repo.** Runtime secrets (tokens, login state)
   belong in `$DSH_HOME/storages/…`, never in the package.

## Repository layout

```
.
├── packages/            # one directory per plugin (npm/pnpm workspace)
│   └── dsh-im/
├── package.json         # private root; workspaces = packages/*
├── pnpm-workspace.yaml
├── LICENSE              # MIT (applies to the whole collection)
└── README.md
```

The repo is tagged with the `dsh-plugin` GitHub topic so it appears at
[`github.com/topics/dsh-plugin`](https://github.com/topics/dsh-plugin) and is
picked up by DSH ecosystem catalogs.

## License

[MIT](./LICENSE) © 2026 kazeCreator.
