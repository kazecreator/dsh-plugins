import z from "@deepseek-ai/schemastery";

const Config = z.object({
  agentPreset: z.string().default(""),
  agentReplyTimeoutMs: z.number().default(120000),
  questionTimeoutMs: z.number().default(0),
  commandsEnabled: z.boolean().default(true),
  restartEnabled: z.boolean().default(true),
  telegramEnabled: z.boolean().default(false),
  telegramBotToken: z.string().default(""),
  telegramAllowedUserIds: z.array(z.string()).default([]),
  telegramPollingTimeout: z.number().default(30),
  telegramApiBase: z.string().default("https://api.telegram.org"),
  wechatEnabled: z.boolean().default(false),
  imessageEnabled: z.boolean().default(false),
  imessageCommand: z.string().default("imsg"),
  imessageDbPath: z.string().default(""),
  imessageWatchDebounce: z.string().default("250ms"),
  imessageAllowedHandles: z.array(z.string()).default([]),
  imessageAllowedChatIds: z.array(z.string()).default([]),
});

export { Config };
