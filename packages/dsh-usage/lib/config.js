import z from "@deepseek-ai/schemastery";

const Config = z.object({
  usageEnabled: z.boolean().default(false),
  balanceRefreshMs: z.number().default(60000),
  providerId: z.string().default("deepseek-official"),
});

export { Config };
