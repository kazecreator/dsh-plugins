import { Config } from "./config.js";
import { migrateSettingsProImStorage } from "./im-storage.js";
import { startIm } from "./im.js";

const name = "dsh-im";
const inject = [];

function apply(ctx, config) {
  const start = () => {
    try {
      migrateSettingsProImStorage();
      startIm(ctx, config ?? {});
      console.log(`[${name}] loaded`);
    } catch (error) {
      console.error(`[${name}] failed to start:`, error?.message ?? error);
    }
  };
  const loader = ctx.get("loader");
  if (loader && typeof loader.await === "function") loader.await().then(start).catch(start);
  else start();
}

export { Config, apply, inject, name };
export default { name, inject, Config, apply };
