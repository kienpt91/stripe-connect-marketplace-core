import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe's webhook signature. The header looks like `t=1762678800,v1=<64 hex>[,v1=<64 hex>][,v0=...]`: a Unix time in seconds and
 * one or more HMAC-SHA256 signatures of `"<t>.<raw body>"`, keyed with the endpoint's signing secret. A secret that is being
 * rotated makes Stripe send two `v1` values; any scheme other than `v1` is ignored, as Stripe's guide says, so a downgrade to a
 * weaker scheme does nothing.
 */
const HEX64 = /^[0-9a-f]{64}$/;
const SECONDS = /^\d{1,12}$/;
const MAX_HEADER = 1024;

export type SignatureVerdict = "ok" | "malformed" | "stale" | "mismatch";

function mac(secret: string, seconds: string, body: Buffer): Buffer {
  return createHmac("sha256", secret).update(seconds).update(".").update(body).digest();
}

/** Builds the header a sender must send. Used by tests, the demo and the fake Stripe. */
export function signBody(secret: string, atMs: number, body: Buffer | string): string {
  const seconds = String(Math.floor(atMs / 1000));
  return `t=${seconds},v1=${mac(secret, seconds, Buffer.from(body)).toString("hex")}`;
}

/**
 * Checks a webhook signature over the exact bytes received. Every secret is tried against every `v1` value (so a secret can be
 * rotated without downtime) and the comparison is constant-time with no early exit. A signature older or newer than `toleranceMs` is
 * refused, which limits how long a captured request can be replayed; the event id is what stops a replay inside the window.
 */
export function verifySignature(header: string | undefined, body: Buffer, secrets: readonly string[], nowMs: number, toleranceMs: number): SignatureVerdict {
  if (header === undefined || header.length > MAX_HEADER) return "malformed";
  let seconds: string | undefined;
  const given: Buffer[] = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at < 1) return "malformed";
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") {
      if (seconds !== undefined || !SECONDS.test(value)) return "malformed";
      seconds = value;
    } else if (key === "v1") {
      if (!HEX64.test(value)) return "malformed";
      given.push(Buffer.from(value, "hex"));
    }
  }
  if (seconds === undefined || given.length === 0 || given.length > 4) return "malformed";
  let matched = false;
  for (const secret of secrets) {
    const expected = mac(secret, seconds, body);
    for (const candidate of given) if (timingSafeEqual(expected, candidate)) matched = true;
  }
  if (!matched) return "mismatch";
  return Math.abs(nowMs - Number(seconds) * 1000) > toleranceMs ? "stale" : "ok";
}
