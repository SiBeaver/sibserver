export const config = {
  port: parseInt(process.env.PORT || "7430", 10),
  authToken: process.env.AUTH_TOKEN || "",
  sibsUrl: process.env.SIBS_URL || "http://localhost:7420",
  sibsToken: process.env.SIBS_TOKEN || "",
  sibsProject: process.env.SIBS_PROJECT || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
  llmApiKey: process.env.LLM_API_KEY || "",
  llmModel: process.env.LLM_MODEL || "gpt-4o",
  llmFlashModel: process.env.LLM_FLASH_MODEL || "deepseek-v4-flash",
  pollInterval: parseInt(process.env.POLL_INTERVAL || "10000", 10),
};
