# @kazecreator/dsh-pets

Desktop pets for DSH: conversation activity monitoring, built-in/user/Codex pet materials, a `/pet` browser window, and optional Electron desktop app installation.

```sh
dsh plugin --profile web add @kazecreator/dsh-pets
```

Use [`example.cordis.patch.yml`](./example.cordis.patch.yml) and restart. The monitor is opt-in with `petsEnabled: false`; pet data and app state live under `$DSH_HOME/storages/dsh-pets/`. In the desktop window, right-click the pet and choose `关闭宠物` to close it; start it again from the Pets settings tab.
