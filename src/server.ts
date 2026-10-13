import express from "express";
import dotenv from "dotenv";
import { loadConfig, type AppConfig } from "./config.js";
import { handleHttpRequest } from "./http-app.js";

/**
 * Create the Express app.
 * Routes match the Worker: GET /health, POST /alexa (and / for local fixtures).
 * Signature verification: fail closed in production (DEV_SKIP_VERIFY must be off).
 */
export function createApp(config: AppConfig): express.Express {
  const app = express();

  // Bridge Express → Web Request so Node and Workers share one handler.
  app.use(async (req, res) => {
    try {
      const host = req.get("host") ?? `127.0.0.1:${config.port}`;
      const url = new URL(req.originalUrl || req.url, `http://${host}`);

      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const v of value) headers.append(key, v);
        } else {
          headers.set(key, value);
        }
      }

      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const raw = hasBody ? await readRawBody(req) : undefined;
      const request = new Request(url, {
        method: req.method,
        headers,
        body: raw ? new Uint8Array(raw) : undefined,
      });

      const response = await handleHttpRequest(request, config);
      res.status(response.status);
      response.headers.forEach((value, key) => {
        res.setHeader(key, value);
      });
      const buf = Buffer.from(await response.arrayBuffer());
      res.send(buf);
    } catch (err) {
      console.error("[http] error", err);
      res.status(500).json({ error: "internal_error" });
    }
  });

  return app;
}

function readRawBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));

if (isMain) {
  dotenv.config();
  const config = loadConfig();
  const app = createApp(config);
  app.listen(config.port, "0.0.0.0", () => {
    console.log(
      `Alexa CoS skill listening on http://127.0.0.1:${config.port} (mockCos=${config.mockCos}, skipVerify=${config.skipVerify})`,
    );
    console.log(`Alexa endpoint: POST http://127.0.0.1:${config.port}/alexa`);
  });
}
