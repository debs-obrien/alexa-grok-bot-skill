import { loadConfig, type AppConfig } from "./config.js";
import { handleHttpRequest } from "./http-app.js";

/** Cloudflare Worker bindings (vars + secrets). */
export type WorkerEnv = {
  NODE_ENV?: string;
  DEV_SKIP_VERIFY?: string;
  MOCK_COS?: string;
  COS_WEBHOOK_URL?: string;
  COS_WEBHOOK_KEY?: string;
  COS_WEBHOOK_TIMEOUT_MS?: string;
  SKILL_APPLICATION_ID?: string;
  PORT?: string;
};

export function configFromWorkerEnv(env: WorkerEnv): AppConfig {
  return loadConfig({
    NODE_ENV: env.NODE_ENV ?? "production",
    DEV_SKIP_VERIFY: env.DEV_SKIP_VERIFY,
    MOCK_COS: env.MOCK_COS,
    COS_WEBHOOK_URL: env.COS_WEBHOOK_URL,
    COS_WEBHOOK_KEY: env.COS_WEBHOOK_KEY,
    COS_WEBHOOK_TIMEOUT_MS: env.COS_WEBHOOK_TIMEOUT_MS,
    SKILL_APPLICATION_ID: env.SKILL_APPLICATION_ID,
    PORT: env.PORT,
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const config = configFromWorkerEnv(env);
    return handleHttpRequest(request, config);
  },
};
