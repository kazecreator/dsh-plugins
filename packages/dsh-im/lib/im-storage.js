import { existsSync, mkdirSync, readdirSync, renameSync, copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEGACY_STORAGE_DIR = "dsh-im";

function home() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

export function imStorageDir() {
  return join(home(), "storages", "dsh-im");
}

export function imStoragePath(...parts) {
  return join(imStorageDir(), ...parts);
}

export function imWorkspaceDir() {
  return join(imStorageDir(), "im-workspace");
}

/** Migrate state from the previous monolithic settings-pro package once. */
export function migrateSettingsProImStorage() {
  const source = join(home(), "storages", "dsh-settings-pro", "im");
  if (!existsSync(source)) return;
  mkdirSync(imStorageDir(), { recursive: true });
  for (const file of ["config.json", "restart-notice.json", "wechat.json", "wechat-cursor.json", "peers.json", "telegram-offset.json", "imessage-cursor.json"]) {
    const src = join(source, file);
    const dst = imStoragePath(file);
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      renameSync(src, dst);
    } catch {
      try {
        copyFileSync(src, dst);
        rmSync(src, { force: true });
      } catch {
        // Best effort: a later startup can retry the migration.
      }
    }
  }
  try {
    if (readdirSync(source).length === 0) rmSync(source, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
}
