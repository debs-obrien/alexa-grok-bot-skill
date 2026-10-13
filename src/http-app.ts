import type { AppConfig } from "./config.js";
import { SPEECH } from "./speech.js";
import { AlexaVerifyError, verifyAlexaRequest } from "./verify.js";
import { wakeCos, type WakePayload } from "./wake.js";

export type EnvLike = Record<string, string | undefined>;

type AlexaSlot = {
  name?: string;
  value?: string;
  confirmationStatus?: string;
};

type AlexaEnvelope = {
  session?: {
    application?: { applicationId?: string };
  };
  context?: {
    System?: {
      application?: { applicationId?: string };
    };
  };
  request?: {
    type?: string;
    requestId?: string;
    timestamp?: string;
    intent?: {
      name?: string;
      slots?: Record<string, AlexaSlot | undefined>;
    };
  };
};

function alexaSpeech(
  text: string,
  options: { endSession?: boolean; reprompt?: string } = {},
) {
  const endSession = options.endSession ?? true;
  const response: Record<string, unknown> = {
    outputSpeech: {
      type: "PlainText",
      text,
    },
    shouldEndSession: endSession,
  };
  if (options.reprompt) {
    response.reprompt = {
      outputSpeech: {
        type: "PlainText",
        text: options.reprompt,
      },
    };
  }
  return {
    version: "1.0",
    response,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  if (typeof text !== "string") {
    const fallback = JSON.stringify({
      version: "1.0",
      response: {
        outputSpeech: {
          type: "PlainText",
          text: SPEECH.ackWakeFailed,
        },
        shouldEndSession: true,
      },
    });
    return new Response(fallback, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(new TextEncoder().encode(fallback).length),
      },
    });
  }
  const bytes = new TextEncoder().encode(text);
  return new Response(bytes, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(bytes.length),
    },
  });
}

function healthBody(config: AppConfig) {
  return {
    ok: true,
    mockCos: config.mockCos,
    skipVerify: config.skipVerify,
    nodeEnv: config.nodeEnv,
    skillIdEnforced: Boolean(config.skillApplicationId),
  };
}

/** applicationId from context.System (preferred) or session (fallback). */
export function envelopeApplicationId(envelope: AlexaEnvelope): string | undefined {
  return (
    envelope.context?.System?.application?.applicationId ??
    envelope.session?.application?.applicationId ??
    undefined
  );
}

/**
 * True when production is missing SKILL_APPLICATION_ID — fail closed and
 * reject every /alexa request until it is configured.
 */
function skillIdMisconfigured(config: AppConfig): boolean {
  return config.nodeEnv === "production" && !config.skillApplicationId;
}

/**
 * Skill ID check. When an ID is configured it is always enforced; outside
 * production with no ID configured, local fixtures are allowed through.
 */
function applicationIdAllowed(
  config: AppConfig,
  envelope: AlexaEnvelope,
): boolean {
  if (!config.skillApplicationId) {
    return config.nodeEnv !== "production";
  }
  return envelopeApplicationId(envelope) === config.skillApplicationId;
}

function slotValue(
  slots: Record<string, AlexaSlot | undefined> | undefined,
  name: string,
): string {
  const raw = slots?.[name]?.value ?? slots?.SearchQuery?.value ?? "";
  return raw.trim();
}

/**
 * Manual Alexa request dispatcher (no SDK dependency).
 * Always returns schema-valid Alexa JSON Alexa can speak.
 */
async function handleAlexaEnvelope(
  config: AppConfig,
  envelope: AlexaEnvelope,
): Promise<ReturnType<typeof alexaSpeech>> {
  const request = envelope.request;
  const type = request?.type ?? "";
  const intentName = request?.intent?.name ?? "";

  if (type === "LaunchRequest") {
    return alexaSpeech(SPEECH.welcome, {
      endSession: false,
      reprompt: SPEECH.help,
    });
  }

  if (type === "SessionEndedRequest") {
    return { version: "1.0", response: { shouldEndSession: true } };
  }

  if (type === "IntentRequest") {
    if (intentName === "AskIntent" || intentName === "AMAZON.SearchQuery") {
      const query = slotValue(request?.intent?.slots, "query");
      if (!query) {
        return alexaSpeech(SPEECH.ackEmptyQuery, {
          endSession: false,
          reprompt: SPEECH.ackEmptyQuery,
        });
      }

      const payload: WakePayload = {
        query,
        source: "alexa",
        requestId: request?.requestId ?? "unknown",
        timestamp: request?.timestamp ?? new Date().toISOString(),
      };

      // Production must never pretend a mock wake succeeded.
      const allowMock = config.mockCos && config.nodeEnv !== "production";
      if (config.nodeEnv === "production" && !config.cosWebhookUrl) {
        console.error("[wake] COS_WEBHOOK_URL missing in production");
        return alexaSpeech(SPEECH.ackWakeFailed, { endSession: true });
      }

      const result = await wakeCos(payload, {
        url: config.cosWebhookUrl,
        key: config.cosWebhookKey,
        mock: allowMock,
        timeoutMs: config.cosWebhookTimeoutMs,
        log: (message, data) => {
          console.log(`[wake] ${message}`, data ?? "");
        },
      });

      console.log("[wake] result", {
        ok: result.ok,
        mocked: result.mocked,
        status: "status" in result ? result.status : undefined,
        error: "error" in result ? result.error : undefined,
      });

      return alexaSpeech(result.ok ? SPEECH.ackSuccess : SPEECH.ackWakeFailed, {
        endSession: true,
      });
    }

    if (intentName === "AMAZON.HelpIntent") {
      return alexaSpeech(SPEECH.help, {
        endSession: false,
        reprompt: SPEECH.help,
      });
    }

    if (
      intentName === "AMAZON.StopIntent" ||
      intentName === "AMAZON.CancelIntent"
    ) {
      return alexaSpeech(SPEECH.goodbye, { endSession: true });
    }

    if (intentName === "AMAZON.FallbackIntent") {
      return alexaSpeech(SPEECH.fallback, {
        endSession: false,
        reprompt: SPEECH.help,
      });
    }

    if (intentName === "AMAZON.NavigateHomeIntent") {
      return alexaSpeech(SPEECH.welcome, {
        endSession: false,
        reprompt: SPEECH.help,
      });
    }

    return alexaSpeech(SPEECH.fallback, {
      endSession: false,
      reprompt: SPEECH.help,
    });
  }

  return alexaSpeech(SPEECH.fallback, {
    endSession: false,
    reprompt: SPEECH.help,
  });
}

/**
 * Framework-agnostic HTTP handler shared by Cloudflare Worker and Express.
 *
 * Alexa skill endpoint: POST /alexa
 * Health: GET /health (and /healthz alias)
 */
export async function handleHttpRequest(
  request: Request,
  config: AppConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  console.log("[req]", {
    method: request.method,
    url: request.url,
    path,
    hasSignature256: Boolean(
      request.headers.get("signature-256") ??
        request.headers.get("Signature-256"),
    ),
    hasSignatureCertChainUrl: Boolean(
      request.headers.get("signaturecertchainurl") ??
        request.headers.get("SignatureCertChainUrl"),
    ),
    contentType: request.headers.get("content-type"),
    userAgent: request.headers.get("user-agent"),
    cfRay: request.headers.get("cf-ray"),
  });

  if (request.method === "GET" && (path === "/health" || path === "/healthz")) {
    return jsonResponse(200, healthBody(config));
  }

  if (request.method === "POST" && (path === "/alexa" || path === "/")) {
    if (skillIdMisconfigured(config)) {
      console.error(
        "[config] SKILL_APPLICATION_ID missing in production; rejecting all /alexa requests (fail closed)",
      );
      return jsonResponse(400, { error: "skill_id_not_configured" });
    }

    try {
      const rawBody = await request.text();
      console.log("[alexa] POST body", {
        bodyLength: rawBody.length,
        path,
      });

      if (!config.skipVerify) {
        await verifyAlexaRequest(rawBody, request.headers);
      }

      let envelope: AlexaEnvelope;
      try {
        envelope = JSON.parse(rawBody) as AlexaEnvelope;
      } catch {
        return jsonResponse(400, { error: "invalid_json" });
      }

      if (!applicationIdAllowed(config, envelope)) {
        const got = envelopeApplicationId(envelope);
        console.warn("[skill-id] rejected", {
          hasApplicationId: Boolean(got),
          requestType: envelope.request?.type ?? null,
        });
        return jsonResponse(400, { error: "invalid_application_id" });
      }

      const out = await handleAlexaEnvelope(config, envelope);
      const serialized = JSON.stringify(out);
      console.log("[alexa] response", {
        requestType: envelope.request?.type,
        intentName: envelope.request?.intent?.name,
        query: slotValue(envelope.request?.intent?.slots, "query") || null,
        bodyLength: serialized.length,
        speech:
          (out.response as { outputSpeech?: { text?: string } })?.outputSpeech
            ?.text ?? null,
      });
      return jsonResponse(200, out);
    } catch (err) {
      if (err instanceof AlexaVerifyError) {
        console.error("[verify] rejected", err.message);
        return jsonResponse(400, { error: "invalid_alexa_signature" });
      }
      console.error("[alexa] handler error", err);
      // Still return valid Alexa JSON so Test doesn't show INVALID_RESPONSE
      // when our code throws after verify.
      return jsonResponse(200, alexaSpeech(SPEECH.ackWakeFailed));
    }
  }

  return jsonResponse(404, { error: "not_found" });
}
