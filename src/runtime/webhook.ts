import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookHeaders {
  deliveryId: string | null;
  eventName: string | null;
  signature256: string | null;
  installationId: string | null;
}

/**
 * Pull the GitHub delivery headers we care about from a Headers-like map.
 * Accepts Fetch Headers, a plain record, or Node's IncomingHttpHeaders shape.
 */
export function readWebhookHeaders(
  headers: Headers | Record<string, string | string[] | undefined>,
): WebhookHeaders {
  const get = (name: string): string | null => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name);
    }
    const raw =
      (headers as Record<string, string | string[] | undefined>)[name] ??
      (headers as Record<string, string | string[] | undefined>)[
        name.toLowerCase()
      ];
    if (raw === undefined) return null;
    return Array.isArray(raw) ? (raw[0] ?? null) : raw;
  };

  return {
    deliveryId: get("x-github-delivery"),
    eventName: get("x-github-event"),
    signature256: get("x-hub-signature-256"),
    installationId: get("x-github-hook-installation-target-id"),
  };
}

/**
 * Verify `X-Hub-Signature-256` against the raw request body.
 * Returns true only when the signature is present, well-formed, and matches.
 */
export function verifyGitHubWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !secret) return false;
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length).trim();
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Compute the signature header value for tests and local replay. */
export function signGitHubWebhookBody(
  rawBody: string | Buffer,
  secret: string,
): string {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody;
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}
