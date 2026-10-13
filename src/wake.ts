export type WakePayload = {
  query: string;
  source: "alexa";
  requestId: string;
  timestamp: string;
};

export const VOICE_MODE = "read-only" as const;
export const VOICE_POLICY =
  "Voice request via Alexa: speaker is not verified. Only look things up, summarise and answer in chat. Anything that sends, deletes, buys, accepts or changes something needs the owner's explicit confirm in chat first.";

/** Body actually POSTed to CoS: always carries the read-only voice policy. */
export type WakeBody = WakePayload & {
  mode: typeof VOICE_MODE;
  policy: string;
  message: string;
};

export function buildWakeBody(payload: WakePayload): WakeBody {
  return {
    ...payload,
    mode: VOICE_MODE,
    policy: VOICE_POLICY,
    message: `${VOICE_POLICY}\n\nRequest: ${payload.query}`,
  };
}

export type WakeResult =
  | { ok: true; mocked: boolean; status?: number }
  | { ok: false; mocked: boolean; error: string };

export type WakeCosOptions = {
  url: string | undefined;
  key: string | undefined;
  mock: boolean;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  log?: (message: string, data?: unknown) => void;
};

/**
 * Fire-and-forget wake of the CoS Grok Bot webhook.
 * 200 means the routine *woke*, not that the bot finished.
 * Never wait for agent completion — there is no sync reply path.
 */
export async function wakeCos(
  payload: WakePayload,
  options: WakeCosOptions,
): Promise<WakeResult> {
  const log = options.log ?? (() => undefined);
  const body = buildWakeBody(payload);

  if (options.mock || !options.url) {
    log("MOCK_COS wake (no real POST)", body);
    return { ok: true, mocked: true };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (options.key) {
    headers.Authorization = `Bearer ${options.key}`;
    headers["X-Automation-Key"] = options.key;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      log("CoS webhook non-OK", { status: response.status, bodyText });
      return {
        ok: false,
        mocked: false,
        error: `webhook status ${response.status}`,
      };
    }

    log("CoS webhook woke", { status: response.status });
    return { ok: true, mocked: false, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("CoS webhook failed", { error: message });
    return { ok: false, mocked: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}
