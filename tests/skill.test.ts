import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config.js";
import { SPEECH } from "../src/speech.js";
import { wakeCos, VOICE_MODE, VOICE_POLICY } from "../src/wake.js";
import { createApp } from "../src/server.js";
import { handleHttpRequest } from "../src/http-app.js";
import {
  validateCertificateUrl,
  verifyAlexaRequest,
  verifyTimestamp,
  AlexaVerifyError,
} from "../src/verify.js";
import worker, { configFromWorkerEnv } from "../src/worker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, name), "utf8"));
}

/** POST a raw Alexa envelope through the real Worker/Express handler. */
async function handleAlexaRequest(
  config: ReturnType<typeof loadConfig>,
  envelope: unknown,
): Promise<{ version: string; response: { outputSpeech?: { text?: string; ssml?: string; type?: string }; shouldEndSession?: boolean } }> {
  const res = await handleHttpRequest(
    new Request("http://localhost/alexa", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }),
    config,
  );
  return res.json() as never;
}

function testConfig(overrides: Record<string, string | undefined> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DEV_SKIP_VERIFY: "1",
    MOCK_COS: "1",
    PORT: "43127",
    ...overrides,
  });
}

function speechText(result: {
  response: { outputSpeech?: { text?: string; ssml?: string; type?: string } };
}) {
  const speech = result.response.outputSpeech;
  if (!speech) return undefined;
  if (speech.text) return speech.text;
  if (speech.ssml) {
    return speech.ssml.replace(/^<speak>/i, "").replace(/<\/speak>$/i, "");
  }
  return undefined;
}

describe("loadConfig", () => {
  it("enables mock mode when COS_WEBHOOK_URL is unset", () => {
    const config = testConfig({ MOCK_COS: undefined, COS_WEBHOOK_URL: undefined });
    expect(config.mockCos).toBe(true);
    expect(config.skipVerify).toBe(true);
  });

  it("fails closed if DEV_SKIP_VERIFY is set in production", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DEV_SKIP_VERIFY: "1",
      }),
    ).toThrow(/DEV_SKIP_VERIFY/);
  });

  it("allows verify in production when skip flag is off", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      COS_WEBHOOK_URL: "https://example.com/hook",
      COS_WEBHOOK_KEY: "secret",
    });
    expect(config.skipVerify).toBe(false);
    expect(config.mockCos).toBe(false);
  });
});

describe("Alexa request → response shape", () => {
  it("LaunchRequest returns welcome speech and keeps session open", async () => {
    const result = await handleAlexaRequest(testConfig(), loadFixture("launch.json"));
    expect(result.version).toBe("1.0");
    expect(speechText(result)).toBe(SPEECH.welcome);
    expect(result.response.shouldEndSession).toBe(false);
  });

  it("AskIntent mock-wakes CoS and returns ack speech", async () => {
    const result = await handleAlexaRequest(
      testConfig(),
      loadFixture("ask-intent.json"),
    );
    expect(result.version).toBe("1.0");
    expect(speechText(result)).toBe(SPEECH.ackSuccess);
    expect(result.response.shouldEndSession).toBe(true);
  });

  it("AskIntent with empty query asks for clarification", async () => {
    const envelope = loadFixture("ask-intent.json") as {
      request: { intent: { slots: { query: { value?: string } } } };
    };
    envelope.request.intent.slots.query.value = "";
    const result = await handleAlexaRequest(testConfig(), envelope);
    expect(speechText(result)).toBe(SPEECH.ackEmptyQuery);
    expect(result.response.shouldEndSession).toBe(false);
  });

  it("HelpIntent returns help speech", async () => {
    const result = await handleAlexaRequest(testConfig(), loadFixture("help.json"));
    expect(speechText(result)).toBe(SPEECH.help);
  });

  it("AskIntent speaks wake-failed ack when webhook errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const config = testConfig({
      MOCK_COS: "0",
      COS_WEBHOOK_URL: "https://example.com/hook",
      COS_WEBHOOK_KEY: "test-key",
    });

    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await handleAlexaRequest(config, loadFixture("ask-intent.json"));
      expect(speechText(result)).toBe(SPEECH.ackWakeFailed);
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [, init] = fetchImpl.mock.calls[0]!;
      expect((init as RequestInit).method).toBe("POST");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-key");
      expect(headers["X-Automation-Key"]).toBe("test-key");
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body).toMatchObject({
        query: "what's on my calendar tomorrow",
        source: "alexa",
        requestId: "amzn1.echo-api.request.test-ask",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("voice read-only policy", () => {
  it("handleAlexaRequest AskIntent POSTs mode read-only + policy", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const result = await handleAlexaRequest(
        testConfig({ MOCK_COS: "0", COS_WEBHOOK_URL: "https://example.com/hook", COS_WEBHOOK_KEY: "k" }),
        loadFixture("ask-intent.json"),
      );
      expect(speechText(result)).toBe(SPEECH.ackSuccess);
      const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
      expect(body).toMatchObject({ mode: "read-only", policy: VOICE_POLICY, source: "alexa" });
      expect(body.message.startsWith(VOICE_POLICY)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("wakeCos always adds the policy even if caller omits it", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await wakeCos(
      { query: "send an email", source: "alexa", requestId: "r", timestamp: "t" },
      { url: "https://example.com/hook", key: undefined, mock: false, timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const body = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(body.mode).toBe(VOICE_MODE);
    expect(body.policy).toContain("needs the owner's explicit confirm in chat first");
  });

  it("spoken ack text is unchanged", () => {
    expect(SPEECH.ackSuccess).toBe("On it — I've woken chief of staff.");
  });
});

describe("wakeCos", () => {
  it("mock mode logs payload and returns ok without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const logs: unknown[] = [];
    const result = await wakeCos(
      {
        query: "check calendar",
        source: "alexa",
        requestId: "req-1",
        timestamp: "2026-10-05T21:00:00Z",
      },
      {
        url: undefined,
        key: undefined,
        mock: true,
        timeoutMs: 1000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        log: (_m, data) => logs.push(data),
      },
    );
    expect(result).toEqual({ ok: true, mocked: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs[0]).toMatchObject({ query: "check calendar", source: "alexa" });
  });

  it("posts JSON with auth headers on success", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, runUuid: "abc" }), {
          status: 200,
        }),
    );
    const result = await wakeCos(
      {
        query: "draft a reply",
        source: "alexa",
        requestId: "req-2",
        timestamp: "2026-10-05T21:01:00Z",
      },
      {
        url: "https://example.com/hook",
        key: "secret",
        mock: false,
        timeoutMs: 1000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result).toEqual({ ok: true, mocked: false, status: 200 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("returns ok:false on abort/timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });
    const result = await wakeCos(
      {
        query: "slow",
        source: "alexa",
        requestId: "req-3",
        timestamp: "2026-10-05T21:02:00Z",
      },
      {
        url: "https://example.com/hook",
        key: "secret",
        mock: false,
        timeoutMs: 50,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.mocked).toBe(false);
  });
});

describe("signature verify helpers", () => {
  it("accepts Amazon Echo API cert URLs", () => {
    expect(() =>
      validateCertificateUrl(
        "https://s3.amazonaws.com/echo.api/echosecure.pem",
      ),
    ).not.toThrow();
  });

  it("rejects non-Amazon cert URLs", () => {
    expect(() =>
      validateCertificateUrl("https://evil.example/echo.api/cert.pem"),
    ).toThrow(AlexaVerifyError);
  });

  it("rejects missing signature headers (fail closed)", async () => {
    await expect(
      verifyAlexaRequest(JSON.stringify(loadFixture("launch.json")), {}),
    ).rejects.toThrow(/Missing Certificate/);
  });

  it("rejects stale timestamps", () => {
    const body = JSON.stringify({
      request: { timestamp: "2020-01-01T00:00:00Z", type: "LaunchRequest" },
    });
    expect(() => verifyTimestamp(body)).toThrow(/tolerance/);
  });
});

describe("HTTP /alexa skip-verify path", () => {
  it("GET /health returns 200", async () => {
    const res = await handleHttpRequest(
      new Request("http://127.0.0.1/health"),
      testConfig(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
  });

  it("POST /alexa LaunchRequest returns welcome speech", async () => {
    const res = await handleHttpRequest(
      new Request("http://127.0.0.1/alexa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadFixture("launch.json")),
      }),
      testConfig(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      version: string;
      response: { outputSpeech?: { ssml?: string }; shouldEndSession?: boolean };
    };
    expect(json.version).toBe("1.0");
    expect(speechText(json)).toBe(SPEECH.welcome);
  });

  it("POST /alexa AskIntent returns mock ack", async () => {
    const res = await handleHttpRequest(
      new Request("http://127.0.0.1/alexa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadFixture("ask-intent.json")),
      }),
      testConfig(),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      response: { outputSpeech?: { ssml?: string }; shouldEndSession?: boolean };
    };
    expect(speechText(json)).toBe(SPEECH.ackSuccess);
    expect(json.response.shouldEndSession).toBe(true);
  });

  it("production config rejects unsigned POST /alexa", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      COS_WEBHOOK_URL: "https://example.com/hook",
      COS_WEBHOOK_KEY: "secret",
      SKILL_APPLICATION_ID: "amzn1.ask.skill.test-app-id",
    });
    const res = await handleHttpRequest(
      new Request("http://127.0.0.1/alexa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadFixture("launch.json")),
      }),
      config,
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("invalid_alexa_signature");
  });

  it("Express createApp POST /alexa works with skip verify", async () => {
    const config = testConfig();
    const app = createApp(config);

    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const server = app.listen(0, "127.0.0.1", async () => {
          try {
            const addr = server.address();
            if (!addr || typeof addr === "string") {
              throw new Error("no port");
            }
            const res = await fetch(`http://127.0.0.1:${addr.port}/alexa`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(loadFixture("ask-intent.json")),
            });
            const body = await res.text();
            resolve({ status: res.status, body });
          } catch (err) {
            reject(err);
          } finally {
            server.close();
          }
        });
      },
    );

    expect(response.status).toBe(200);
    expect(speechText(JSON.parse(response.body))).toBe(SPEECH.ackSuccess);
  });
});

describe("HTTP /alexa skill application ID check", () => {
  const SKILL_ID = "amzn1.ask.skill.test-app-id";

  function postAlexa(body: unknown) {
    return new Request("http://127.0.0.1/alexa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Real (non-mock) webhook config so any wake would hit the fetch spy. */
  function liveWakeConfig(overrides: Record<string, string | undefined> = {}) {
    return testConfig({
      MOCK_COS: "0",
      COS_WEBHOOK_URL: "https://example.com/hook",
      COS_WEBHOOK_KEY: "test-key",
      SKILL_APPLICATION_ID: SKILL_ID,
      ...overrides,
    });
  }

  async function withFetchSpy<T>(
    fn: (spy: ReturnType<typeof vi.fn>) => Promise<T>,
  ): Promise<T> {
    const spy = vi.fn(async () => new Response("{}", { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      return await fn(spy);
    } finally {
      globalThis.fetch = original;
    }
  }

  it("matching applicationId passes and wakes CoS", async () => {
    await withFetchSpy(async (spy) => {
      const res = await handleHttpRequest(
        postAlexa(loadFixture("ask-intent.json")),
        liveWakeConfig(),
      );
      expect(res.status).toBe(200);
      expect(speechText(await res.json())).toBe(SPEECH.ackSuccess);
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  it("HTTP AskIntent wake body is read-only with policy; ack unchanged", async () => {
    await withFetchSpy(async (spy) => {
      const res = await handleHttpRequest(
        postAlexa(loadFixture("ask-intent.json")),
        liveWakeConfig(),
      );
      expect(speechText(await res.json())).toBe("On it — I've woken chief of staff.");
      const [, init] = spy.mock.calls[0]!;
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body.mode).toBe("read-only");
      expect(body.policy).toBe(VOICE_POLICY);
      expect(body.policy).toContain("speaker is not verified");
      expect(body.message.startsWith(VOICE_POLICY)).toBe(true);
      expect(body.message).toContain("what's on my calendar tomorrow");
      expect(body.query).toBe("what's on my calendar tomorrow");
    });
  });

  it("falls back to session.application.applicationId", async () => {
    const envelope = loadFixture("ask-intent.json") as {
      context?: unknown;
    };
    delete envelope.context;
    await withFetchSpy(async (spy) => {
      const res = await handleHttpRequest(postAlexa(envelope), liveWakeConfig());
      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  it("wrong applicationId gets 400 and does not wake CoS", async () => {
    const envelope = loadFixture("ask-intent.json") as {
      session: { application: { applicationId: string } };
      context: { System: { application: { applicationId: string } } };
    };
    envelope.session.application.applicationId = "amzn1.ask.skill.someone-else";
    envelope.context.System.application.applicationId =
      "amzn1.ask.skill.someone-else";
    await withFetchSpy(async (spy) => {
      const res = await handleHttpRequest(postAlexa(envelope), liveWakeConfig());
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_application_id",
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("context applicationId wins over a matching session one", async () => {
    const envelope = loadFixture("ask-intent.json") as {
      context: { System: { application: { applicationId: string } } };
    };
    envelope.context.System.application.applicationId =
      "amzn1.ask.skill.someone-else";
    await withFetchSpy(async (spy) => {
      const res = await handleHttpRequest(postAlexa(envelope), liveWakeConfig());
      expect(res.status).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("missing applicationId gets 400 and does not wake CoS", async () => {
    const envelope = loadFixture("ask-intent.json") as {
      session?: unknown;
      context?: unknown;
    };
    delete envelope.session;
    delete envelope.context;
    await withFetchSpy(async (spy) => {
      const res = await handleHttpRequest(postAlexa(envelope), liveWakeConfig());
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_application_id",
      );
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("production with no SKILL_APPLICATION_ID rejects everything (fail closed)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const config = loadConfig({
        NODE_ENV: "production",
        COS_WEBHOOK_URL: "https://example.com/hook",
        COS_WEBHOOK_KEY: "secret",
      });
      await withFetchSpy(async (spy) => {
        for (const name of ["launch.json", "ask-intent.json", "help.json"]) {
          const res = await handleHttpRequest(postAlexa(loadFixture(name)), config);
          expect(res.status).toBe(400);
          expect(((await res.json()) as { error: string }).error).toBe(
            "skill_id_not_configured",
          );
        }
        // No cert fetch, no CoS wake.
        expect(spy).not.toHaveBeenCalled();
      });
      expect(
        errors.mock.calls.some((c) => String(c[0]).includes("SKILL_APPLICATION_ID")),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
  });

  it("Worker maps SKILL_APPLICATION_ID from env", async () => {
    const res = await worker.fetch(
      postAlexa({
        ...(loadFixture("launch.json") as object),
        context: { System: { application: { applicationId: "amzn1.ask.skill.nope" } } },
      }),
      {
        NODE_ENV: "development",
        DEV_SKIP_VERIFY: "1",
        MOCK_COS: "1",
        SKILL_APPLICATION_ID: SKILL_ID,
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("Cloudflare Worker entry", () => {
  it("maps Worker env to production verify-on config", () => {
    const config = configFromWorkerEnv({
      NODE_ENV: "production",
      COS_WEBHOOK_URL: "https://example.com/hook",
      COS_WEBHOOK_KEY: "secret",
    });
    expect(config.skipVerify).toBe(false);
    expect(config.mockCos).toBe(false);
  });

  it("fetch GET /health returns 200", async () => {
    const res = await worker.fetch(new Request("https://example.workers.dev/health"), {
      NODE_ENV: "development",
      DEV_SKIP_VERIFY: "1",
      MOCK_COS: "1",
    });
    expect(res.status).toBe(200);
  });

  it("fetch POST /alexa returns ack in mock mode", async () => {
    const res = await worker.fetch(
      new Request("https://example.workers.dev/alexa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loadFixture("ask-intent.json")),
      }),
      {
        NODE_ENV: "development",
        DEV_SKIP_VERIFY: "1",
        MOCK_COS: "1",
      },
    );
    expect(res.status).toBe(200);
    expect(speechText(await res.json())).toBe(SPEECH.ackSuccess);
  });
});
