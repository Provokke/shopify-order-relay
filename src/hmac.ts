import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks a Shopify webhook signature (base64 HMAC-SHA256 of the raw body).
 * Pass the exact bytes received, re-serialised JSON won't match.
 */
export function verifyShopifyHmac(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "base64");
  // timingSafeEqual throws if the lengths differ, so check those first
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}
