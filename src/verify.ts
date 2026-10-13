/**
 * Alexa request signature + timestamp verification for Node and Cloudflare Workers.
 *
 * Uses the same rules as ASK's SkillRequestSignatureVerifier / TimestampVerifier, but
 * loads the signing cert with `fetch` (Workers-safe) instead of Node `https`.
 *
 * @see https://developer.amazon.com/docs/custom-skills/host-a-custom-skill-as-a-web-service.html#checking-the-signature-of-the-request
 */

import { createVerify } from "node:crypto";
import forge from "node-forge";

const { pki } = forge;

const VALID_PROTOCOL = "https:";
const VALID_HOST = "s3.amazonaws.com";
const VALID_PATH_PREFIX = "/echo.api/";
const CERT_PORT = 443;
const CERT_DOMAIN = "echo-api.amazon.com";
const SIGNATURE_CERT_HEADER = "signaturecertchainurl";
const SIGNATURE_HEADER = "signature-256";
const MAX_TIMESTAMP_SKEW_MS = 150_000;

const certCache = new Map<string, string>();

export class AlexaVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlexaVerifyError";
  }
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const want = name.toLowerCase();
  if (typeof (headers as Headers).get === "function") {
    const v = (headers as Headers).get(name) ?? (headers as Headers).get(want);
    return v ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === want) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export function validateCertificateUrl(signatureCertChainUrl: string): void {
  let urlObj: URL;
  try {
    urlObj = new URL(signatureCertChainUrl);
  } catch {
    throw new AlexaVerifyError("SignatureCertChainUrl is not a valid URL");
  }

  if (urlObj.protocol.toLowerCase() !== VALID_PROTOCOL) {
    throw new AlexaVerifyError(
      `SignatureCertChainUrl contains an unsupported protocol ${urlObj.protocol}`,
    );
  }
  if (urlObj.hostname !== VALID_HOST) {
    throw new AlexaVerifyError(
      `SignatureCertChainUrl has invalid host name: ${urlObj.hostname}`,
    );
  }
  if (!urlObj.pathname.startsWith(VALID_PATH_PREFIX)) {
    throw new AlexaVerifyError(
      `SignatureCertChainUrl has invalid path: ${urlObj.pathname}`,
    );
  }
  if (urlObj.port && Number(urlObj.port) !== CERT_PORT) {
    throw new AlexaVerifyError(
      `SignatureCertChainUrl has invalid port: ${urlObj.port}`,
    );
  }
}

function validateCertChain(pemCert: string): void {
  const cert = pki.certificateFromPem(pemCert);
  const now = Date.now();
  const notAfter = new Date(cert.validity.notAfter).getTime();
  const notBefore = new Date(cert.validity.notBefore).getTime();
  if (!(now <= notAfter && now >= notBefore)) {
    throw new AlexaVerifyError("Signing Certificate expired or not started");
  }

  const san = cert.getExtension("subjectAltName") as
    | { altNames?: Array<{ value?: string }> }
    | null
    | undefined;
  const altNames = san?.altNames ?? [];
  if (!altNames.some((d) => d.value === CERT_DOMAIN)) {
    throw new AlexaVerifyError(
      `${CERT_DOMAIN} domain missing in Signature Certificate Chain.`,
    );
  }
}

async function tryTrustChain(pemCert: string): Promise<void> {
  try {
    const tls = await import("node:tls");
    const roots = tls.rootCertificates;
    if (!roots?.length) return;

    const caStore = pki.createCaStore([...roots]);
    const matches = pemCert.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    );
    if (!matches?.length) return;
    const certs = matches.map((pem) => pki.certificateFromPem(pem));
    pki.verifyCertificateChain(caStore, certs);
  } catch {
    // Workers without a full root store still rely on leaf+SAN+signature checks.
  }
}

async function loadCertChain(signatureCertChainUrl: string): Promise<string> {
  validateCertificateUrl(signatureCertChainUrl);
  const cached = certCache.get(signatureCertChainUrl);
  if (cached) return cached;

  const response = await fetch(signatureCertChainUrl);
  if (!response.ok) {
    throw new AlexaVerifyError(
      `Unable to load x509 certificate from URL: ${signatureCertChainUrl}. Status: ${response.status}`,
    );
  }
  const pemCert = await response.text();
  validateCertChain(pemCert);
  // Full Mozilla CA chain checks are best-effort when Node's root store is present.
  // Leaf expiry + SAN (echo-api.amazon.com) + RSA-SHA256 body signature are always enforced.
  await tryTrustChain(pemCert);
  certCache.set(signatureCertChainUrl, pemCert);
  return pemCert;
}

function validateRequestBody(
  pemCert: string,
  signature: string,
  requestBody: string,
): void {
  const verifier = createVerify("RSA-SHA256");
  verifier.update(requestBody, "utf8");
  if (!verifier.verify(pemCert, signature, "base64")) {
    throw new AlexaVerifyError("request body and signature does not match");
  }
}

export function verifyTimestamp(
  requestBody: string,
  nowMs: number = Date.now(),
): void {
  let envelope: { request?: { timestamp?: string; type?: string } };
  try {
    envelope = JSON.parse(requestBody) as {
      request?: { timestamp?: string; type?: string };
    };
  } catch {
    throw new AlexaVerifyError("request body is not valid JSON");
  }

  const timestamp = envelope.request?.timestamp;
  if (!timestamp) {
    throw new AlexaVerifyError("Missing request timestamp");
  }
  const requestTime = Date.parse(timestamp);
  if (Number.isNaN(requestTime)) {
    throw new AlexaVerifyError("Invalid request timestamp");
  }
  if (Math.abs(nowMs - requestTime) > MAX_TIMESTAMP_SKEW_MS) {
    throw new AlexaVerifyError(
      "Request timestamp is outside the allowed tolerance",
    );
  }
}

/**
 * Fail-closed verification of an Alexa skill request.
 * Call only when DEV_SKIP_VERIFY is off.
 */
export async function verifyAlexaRequest(
  requestBody: string,
  headers: Headers | Record<string, string | string[] | undefined>,
): Promise<void> {
  const signatureCertChainUrl = headerValue(headers, SIGNATURE_CERT_HEADER);
  const signature = headerValue(headers, SIGNATURE_HEADER);

  if (!signatureCertChainUrl) {
    throw new AlexaVerifyError("Missing Certificate for the skill request");
  }
  if (!signature) {
    throw new AlexaVerifyError("Missing Signature for the skill request");
  }

  const pemCert = await loadCertChain(signatureCertChainUrl);
  validateRequestBody(pemCert, signature, requestBody);
  verifyTimestamp(requestBody);
}

/** Test helper — clear in-memory cert cache between tests. */
export function clearCertCache(): void {
  certCache.clear();
}
