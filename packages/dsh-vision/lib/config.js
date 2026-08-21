import z from "@deepseek-ai/schemastery";

const Config = z.object({
  visionEnabled: z.boolean().default(false),
  visionBaseUrl: z.string().default(""),
  visionModel: z.string().default(""),
  visionApiKeyEnv: z.string().default(""),
  visionMaxTokens: z.number().default(2048),
  visionTimeoutMs: z.number().default(60000),
});

export { Config };
