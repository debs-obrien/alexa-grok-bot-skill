export type AppConfig = {
  port: number;
  nodeEnv: string;
  /** When true, skip Alexa request signature verification (local tests only). */
  skipVerify: boolean;
  /** Optional skill application ID to enforce. */
  skillApplicationId: string | undefined;
  /** CoS webhook URL. Unset → mock mode. */
  cosWebhookUrl: string | undefined;
  /** Bearer / X-Automation-Key for CoS webhook. */
  cosWebhookKey: string | undefined;
  /** Force mock wake even if URL is set. */
  mockCos: boolean;
  /** Wake POST timeout in ms. */
  cosWebhookTimeoutMs: number;
};

export type EnvMap = Record<string, string | undefined>;

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(env: EnvMap = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? "development";
  const skipVerify = truthy(env.DEV_SKIP_VERIFY);

  if (nodeEnv === "production" && skipVerify) {
    throw new Error(
      "DEV_SKIP_VERIFY must not be enabled in production (fail closed).",
    );
  }

  const timeoutRaw = env.COS_WEBHOOK_TIMEOUT_MS ?? "6000";
  const cosWebhookTimeoutMs = Number.parseInt(timeoutRaw, 10);
  if (!Number.isFinite(cosWebhookTimeoutMs) || cosWebhookTimeoutMs <= 0) {
    throw new Error(`Invalid COS_WEBHOOK_TIMEOUT_MS: ${timeoutRaw}`);
  }

  return {
    port: Number.parseInt(env.PORT ?? "43127", 10),
    nodeEnv,
    skipVerify,
    skillApplicationId: env.SKILL_APPLICATION_ID || undefined,
    cosWebhookUrl: env.COS_WEBHOOK_URL || undefined,
    cosWebhookKey: env.COS_WEBHOOK_KEY || undefined,
    mockCos: truthy(env.MOCK_COS) || !env.COS_WEBHOOK_URL,
    cosWebhookTimeoutMs,
  };
}
