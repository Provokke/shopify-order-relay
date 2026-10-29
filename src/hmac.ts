import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a Shopify webhook signature.
 * Shopify signs the raw request body with HMAC-SHA256 using the app client secret
 * and sends the base64 digest in X-Shopify-Hmac-SHA256.
 * The body MUST be the exact bytes received; re-serialised JSON will not match.
 */
export function verifyShopifyHmac(rawBody: string | Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "base64");
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}
