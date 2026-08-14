import z from "@deepseek-ai/schemastery";

/**
 * Flat plugin config. Kept flat (prefixed keys) because the loader resolves
 * top-level scalars with `.default()` deterministically; nested objects would
 * need extra default plumbing. All keys are optional at the patch layer.
 */
const Config = z.object({
  // Agent
  agentPreset: z.string().default(""),
  agentReplyTimeoutMs: z.number().default(120000),
  questionTimeoutMs: z.number().default(0),
  commandsEnabled: z.boolean().default(true),
  restartEnabled: z.boolean().default(true),

  // Telegram
  telegramEnabled: z.boolean().default(false),
  telegramBotToken: z.string().default(""),
  telegramAllowedUserIds: z.array(z.string()).default([]),
  telegramPollingTimeout: z.number().default(30),
  telegramApiBase: z.string().default("https://api.telegram.org"),

  // WeChat
  wechatEnabled: z.boolean().default(false),
});

export { Config };
