import z from "@deepseek-ai/schemastery";

const Config = z.object({ memoryEnabled: z.boolean().default(false) });

export { Config };
