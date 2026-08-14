# Contributing

How to add a plugin to this monorepo.

## Repository layout

```
.
├── packages/            # one directory per plugin (npm/pnpm workspace)
│   └── dsh-im/
├── package.json         # private root; workspaces = packages/*
├── pnpm-workspace.yaml
├── LICENSE              # MIT (applies to the whole collection)
└── README.md            # user-facing: what the plugins are + how to use them
```

The repo is tagged with the [`dsh-plugin`](https://github.com/topics/dsh-plugin)
GitHub topic so the collection is discoverable in the DSH ecosystem.

## Adding a new plugin

Every plugin follows the same package structure under `packages/<name>/`:

```
packages/<name>/
  package.json              # name @kazecreator/<name>; keywords include "dsh-plugin"
  lib/index.js              # Cordis plugin: export { apply, inject, name }
  lib/...                   # plugin modules
  README.md                 # install + config docs
  example.cordis.patch.yml  # patch snippet to merge into cordis.patch.yml
  LICENSE                   # MIT
```

Checklist:

1. **`package.json`** — set `name` (`@kazecreator/<name>`), `license: "MIT"`, the
   `@deepseek-ai/*` `peerDependencies` your plugin imports, and `keywords`
   including `dsh-plugin`. If the plugin ships a Web UI panel, add a
   `dsh.client` block and an `exports["./client"]` entry (see `dsh-im` for a
   working example). Point `repository` at this repo with
   `"directory": "packages/<name>"`.
2. **`lib/index.js`** — a Cordis plugin exporting `apply`, `inject`, and `name`.
3. **`example.cordis.patch.yml`** — a copy-paste patch row so users can enable
   the plugin without reading the code.
4. **`README.md`** — document install, config keys (with defaults), and any
   runtime endpoints/state.
5. **Keep credentials out of the repo.** Runtime secrets (tokens, login state)
   belong in `$DSH_HOME/storages/…`, never in the package.

## Install conventions

Use `file:` (copy), not `link:`: a profile resolves a plugin's
`@deepseek-ai/*` peers through `$DSH_HOME/profiles/node_modules`, and a `link:`
symlink would re-anchor resolution at the source checkout where those peers are
absent.
