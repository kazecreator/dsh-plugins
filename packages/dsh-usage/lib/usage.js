import { join } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { dateInTz, isPeakTime, loadPricing, rateFor } from "./pricing.js";
import { UsageStore } from "./usage-store.js";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_PROVIDER_ID = "deepseek-official";

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

function addBucket(target, source) {
  target.inputTokens += count(source?.inputTokens);
  target.outputTokens += count(source?.outputTokens);
  target.cacheReadTokens += count(source?.cacheReadTokens);
  target.cacheWriteTokens += count(source?.cacheWriteTokens);
}

function bucketCost(model, band, date, bucket, pricing) {
  const rates = rateFor(model, band, date, pricing);
  return (
    count(bucket?.inputTokens) * Number(rates?.inputCacheMiss || 0) +
    count(bucket?.cacheWriteTokens) * Number(rates?.inputCacheMiss || 0) +
    count(bucket?.cacheReadTokens) * Number(rates?.inputCacheHit || 0) +
    count(bucket?.outputTokens) * Number(rates?.output || 0)
  ) / 1_000_000;
}

/**
 * Usage service for one DSH profile.
 *
 * Token usage comes from the durable `assistant/message` session events, so
 * this service does not need a platform.deepseek.com login or userToken. The
 * API key is only used by `refreshBalance()` against the documented balance
 * endpoint.
 */
export class UsageService {
  #enabled = false;

  constructor(ctx, config, dir) {
    this.ctx = ctx;
    this.config = config ?? {};
    this.dir = dir;
    this.pricingPath = join(dir, "pricing.json");
    this.pricing = loadPricing(this.pricingPath);
    this.store = new UsageStore(dir, this.pricing.timezone);
    this.providerId = String(this.config.providerId ?? DEFAULT_PROVIDER_ID).trim() || DEFAULT_PROVIDER_ID;
    this.balance = null;
    this.balanceError = null;
    this.timer = null;
    this.#enabled = this.config.usageEnabled === true;

    if (typeof ctx?.on === "function") {
      ctx.on("session/event", (_session, event) => this.#recordEvent(event));
    }
  }

  get enabled() {
    return this.#enabled;
  }

  /** Toggle live from the settings panel: start/stop the balance poll. */
  setEnabled(value) {
    const on = value === true;
    if (on === this.#enabled) return;
    this.#enabled = on;
    if (on) this.#startTimers();
    else this.#stopTimers();
  }

  #recordEvent(event) {
    if (!this.#enabled || event?.type !== "assistant/message") return;

    const data = event.data;
    const message = data?.message;
    const source = message?.source;
    if (source?.kind !== "model" || source.provider !== this.providerId || data?.usage == null) return;

    const model = String(source.model ?? "").trim();
    const time = Number(event.time);
    if (!model || !Number.isFinite(time)) return;

    const usage = {
      inputTokens: count(data.usage.inputTokens),
      outputTokens: count(data.usage.outputTokens),
      cacheReadTokens: count(data.usage.cacheReadTokens),
      cacheWriteTokens: count(data.usage.cacheWriteTokens),
    };
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0) return;

    const date = dateInTz(new Date(time), this.pricing.timezone);
    this.store.record(date, model, usage, isPeakTime(new Date(time), this.pricing));
  }

  async #apiKey() {
    const credentials = this.ctx?.get?.("credentials");
    if (credentials && typeof credentials.resolve === "function") {
      const hit = await credentials.resolve(credentialRef("DEEPSEEK_API_KEY"));
      if (hit && hit.value) return String(hit.value).trim();
    }
    return String(process.env.DEEPSEEK_API_KEY ?? "").trim();
  }

  async refreshBalance() {
    const key = await this.#apiKey();
    if (!key) {
      this.balanceError = "DEEPSEEK_API_KEY is not configured";
      return null;
    }
    try {
      const res = await fetch(BALANCE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.balance = await res.json();
      this.balanceError = null;
      return this.balance;
    } catch (error) {
      this.balanceError = error?.message ?? String(error);
      return null;
    }
  }

  async getBalance(force = false) {
    if (force || this.balance == null) await this.refreshBalance();
    return this.balance;
  }

  /**
   * Aggregate the locally recorded usage into daily values. Costs are
   * estimates based on the runtime pricing file; DeepSeek's account balance
   * remains the authoritative amount charged to the account.
   */
  dailyUsage() {
    const days = [];
    for (const date of this.store.listDays()) {
      const stored = this.store.load(date);
      const totals = emptyBucket();
      const models = {};
      let cost = 0;

      for (const [model, modelData] of Object.entries(stored.models ?? {})) {
        const modelBuckets = {};
        for (const band of ["peak", "offpeak"]) {
          const bucket = emptyBucket();
          addBucket(bucket, modelData?.[band]);
          if (bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens <= 0) continue;
          modelBuckets[band] = bucket;
          addBucket(totals, bucket);
          cost += bucketCost(model, band, date, bucket, this.pricing);
        }
        if (Object.keys(modelBuckets).length > 0) models[model] = modelBuckets;
      }

      if (totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens <= 0) continue;
      days.push({
        date,
        cost,
        cacheHit: totals.cacheReadTokens,
        cacheMiss: totals.inputTokens,
        cacheWrite: totals.cacheWriteTokens,
        response: totals.outputTokens,
        models,
      });
    }
    return days;
  }

  async payload(forceBalance = false) {
    const daily = this.dailyUsage();
    return {
      balance: await this.getBalance(forceBalance),
      balanceError: this.balanceError,
      today: this.store.today(),
      daily,
      lifetimeCost: daily.reduce((sum, day) => sum + (day.cost || 0), 0),
      backfilled: daily.length > 0,
      usageSource: "session-events",
      providerId: this.providerId,
    };
  }

  start() {
    if (this.#enabled) this.#startTimers();
  }

  #startTimers() {
    if (this.timer) return;
    this.refreshBalance();
    const intervalMs = Number.isFinite(this.config.balanceRefreshMs)
      ? this.config.balanceRefreshMs
      : DEFAULT_REFRESH_MS;
    this.timer = setInterval(() => this.refreshBalance(), intervalMs);
    this.timer.unref?.();
  }

  #stopTimers() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose() {
    this.#stopTimers();
  }
}

export { DEFAULT_PROVIDER_ID };
