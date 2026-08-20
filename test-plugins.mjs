import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const previousHome = process.env.DSH_HOME;
const testHome = mkdtempSync(join(tmpdir(), "dsh-plugins-"));
process.env.DSH_HOME = testHome;

const legacyRoot = join(testHome, "storages", "dsh-settings-pro");
mkdirSync(join(legacyRoot, "usage"), { recursive: true });
mkdirSync(join(legacyRoot, "memory"), { recursive: true });
mkdirSync(join(legacyRoot, "pets", "user", "legacy"), { recursive: true });
writeFileSync(join(legacyRoot, "config.json"), JSON.stringify({ usageEnabled: false, memoryEnabled: false, petsEnabled: false, visionEnabled: false }) + "\n");
writeFileSync(join(legacyRoot, "cost-history.json"), "{}\n");
writeFileSync(join(legacyRoot, "usage", "2026-08-20.json"), "{}\n");
writeFileSync(join(legacyRoot, "memory", "summary.json"), JSON.stringify({ summary: "legacy" }) + "\n");
writeFileSync(join(legacyRoot, "pets", "user", "legacy", "manifest.json"), JSON.stringify({ name: "Legacy" }) + "\n");

const cases = [
  ["dsh-im", { telegramEnabled: false, wechatEnabled: false, imessageEnabled: false }, "/im/status", 6],
  ["dsh-usage", { usageEnabled: false }, "/settings-pro/usage", 3],
  ["dsh-memory", { memoryEnabled: false }, "/settings-pro/memory", 4],
  ["dsh-pets", { petsEnabled: false }, "/settings-pro/pets", 22],
  ["dsh-vision", { visionEnabled: false }, "/vision/status", 5],
];

try {
  for (const [pkg, config, expectedPath, minimumRoutes] of cases) {
    const routes = [];
    const events = {};
    const ctx = {
      get(key) {
        if (key === "webServer") return { register(route) { routes.push(route); } };
        if (key === "tools") return { register() {} };
        if (key === "systemPrompt") return { context() {} };
        if (key === "agents" || key === "agentDefaultModel" || key === "sessions" || key === "llm" || key === "workspaceRegistry") return {};
        return undefined;
      },
      on(name, handler) { (events[name] ??= []).push(handler); },
    };
    const plugin = await import(`./packages/${pkg}/lib/index.js`);
    if (plugin.default?.name !== pkg || typeof plugin.apply !== "function" || plugin.Config == null) throw new Error(`${pkg}: invalid exports`);
    plugin.apply(ctx, config);
    if (!routes.some((route) => route.path === expectedPath)) throw new Error(`${pkg}: missing route ${expectedPath}`);
    if (routes.length < minimumRoutes) throw new Error(`${pkg}: expected at least ${minimumRoutes} routes, got ${routes.length}`);
    const client = readFileSync(`packages/${pkg}/lib/client.js`, "utf8");
    if (!client.includes(`id: "@kazecreator/${pkg}"`)) throw new Error(`${pkg}: client module id is not package-specific`);
    if (pkg === "dsh-pets") {
      const desktopMain = readFileSync("packages/dsh-pets/pet-desktop/main.js", "utf8");
      if (!desktopMain.includes('"context-menu"') || !desktopMain.includes("关闭宠物") || !desktopMain.includes("petWindow.close()")) {
        throw new Error("dsh-pets: desktop context menu close action is missing");
      }
      const petPage = readFileSync("packages/dsh-pets/lib/pet-page.js", "utf8");
      if (!petPage.includes("e.button !== 0")) throw new Error("dsh-pets: right-click must not start dragging");
    }
    const migrated = {
      "dsh-usage": join(testHome, "storages", "dsh-usage", "usage", "2026-08-20.json"),
      "dsh-memory": join(testHome, "storages", "dsh-memory", "memory", "summary.json"),
      "dsh-pets": join(testHome, "storages", "dsh-pets", "pets", "user", "legacy", "manifest.json"),
    }[pkg];
    if (migrated && !existsSync(migrated)) throw new Error(`${pkg}: legacy storage was not migrated`);
    console.log(`${pkg}: OK (${routes.length} routes, ${Object.keys(events).length} event groups)`);
  }

  const imessage = await import("./packages/dsh-im/lib/imessage.js");
  const incoming = imessage.parseImessageLine(JSON.stringify({
    id: 42,
    chat_id: 7,
    sender: "+15551234567",
    text: "hello",
    is_from_me: false,
  }));
  if (incoming?.id !== 42 || imessage.imessagePeerId(incoming) !== "7") throw new Error("dsh-im: iMessage NDJSON parsing failed");
  const sendArgs = imessage.buildSendArgs({ imessageDbPath: "/tmp/chat.db" }, { chatId: 7 }, "hello");
  if (!sendArgs.includes("--chat-id") || !sendArgs.includes("7") || !sendArgs.includes("--db")) throw new Error("dsh-im: iMessage chat routing args failed");
  if (imessage.buildChatsArgs({ imessageDbPath: "/tmp/chat.db" }).join(" ") !== "chats --json --limit 10000 --db /tmp/chat.db") throw new Error("dsh-im: iMessage catalog args failed");
  if (!imessage.isAllowedImessageMessage(incoming, { imessageAllowedHandles: ["+15551234567"] })) throw new Error("dsh-im: iMessage handle allowlist failed");
  if (imessage.isAllowedImessageMessage(incoming, { imessageAllowedHandles: ["+15550000000"] })) throw new Error("dsh-im: iMessage handle allowlist leaked");
  console.log("dsh-im: iMessage helpers OK");
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  rmSync(testHome, { recursive: true, force: true });
}
