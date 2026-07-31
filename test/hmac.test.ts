import { describe, expect, it } from "vitest";
import { signBody, verifyShopifyHmac } from "../src/hmac.js";

describe("verifyShopifyHmac", () => {
  const body = '{"id":1}';
  const good = signBody(body, "s3cret");

  it("accepts a valid signature", () => {
    expect(verifyShopifyHmac(body, good, "s3cret")).toBe(true);
    expect(verifyShopifyHmac(Buffer.from(body), good, "s3cret")).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyShopifyHmac('{"id":2}', good, "s3cret")).toBe(false);
  });
  it("rejects re-serialised JSON (whitespace changes the digest)", () => {
    expect(verifyShopifyHmac('{ "id": 1 }', good, "s3cret")).toBe(false);
  });
  it("rejects wrong secret, missing or malformed signatures without throwing", () => {
    expect(verifyShopifyHmac(body, good, "other")).toBe(false);
    expect(verifyShopifyHmac(body, undefined, "s3cret")).toBe(false);
    expect(verifyShopifyHmac(body, "", "s3cret")).toBe(false);
    expect(verifyShopifyHmac(body, "abc", "s3cret")).toBe(false);
    expect(verifyShopifyHmac(body, good, "")).toBe(false);
  });
});
