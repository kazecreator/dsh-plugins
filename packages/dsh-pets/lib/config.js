import z from "@deepseek-ai/schemastery";

const Config = z.object({
  petsEnabled: z.boolean().default(false),
  petsMaxGoalRounds: z.number().default(16),
});

export { Config };

