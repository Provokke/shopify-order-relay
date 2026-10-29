import { describe, expect, it } from "vitest";
import { ShopifyGraphQLClient } from "../src/shopify/graphql-client.js";
import { PermanentError, TransientError } from "../src/types.js";
import { fetchSequence, json } from "./helpers.js";

const cost = (currentlyAvailable: number, requested = 10) => ({
  cost: { requestedQueryCost: requested, actualQueryCost: requested, throttleStatus: { maximumAvailable: 1000, currentlyAvailable, restoreRate: 50 } },
});
const ok = (currentlyAvailable: number) => json({ data: { hello: "world" }, extensions: cost(currentlyAvailable) });

function client(responses: Parameters<typeof fetchSequence>[0], clock = { t: 0 }) {
  const { fn, calls } = fetchSequence(responses);
  const sleeps: number[] = [];
  const c = new ShopifyGraphQLClient({
    shopDomain: "dev-store.myshopify.com",
    accessToken: "tok",
    apiVersion: "2026-10",
    fetch: fn,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    now: () => clock.t,
    random: () => 0.999,
    maxAttempts: 4,
  });
  return { c, calls, sleeps };
}

describe("ShopifyGraphQLClient", () => {
  it("posts to the versioned endpoint with the access token", async () => {
    const { c, calls } = client([ok(990)]);
    await expect(c.request("{ shop { name } }")).resolves.toEqual({ hello: "world" });
    expect(calls[0]?.url).toBe("https://dev-store.myshopify.com/admin/api/2026-10/graphql.json");
    expect((calls[0]?.init.headers as Record<string, string>)["x-shopify-access-token"]).toBe("tok");
  });

  it("waits proactively when the bucket is nearly empty", async () => {
    // 10 points left, restore 50/s, next query estimated at 50 => needs 40 more => 800ms.
    const { c, sleeps } = client([ok(10), ok(990)]);
    await c.request("q");
    await c.request("q");
    expect(sleeps).toEqual([800]);
  });

  it("does not wait when enough time has passed for the bucket to refill", async () => {
    const clock = { t: 0 };
    const { c, sleeps } = client([ok(10), ok(990)], clock);
    await c.request("q");
    clock.t += 2000; // refills 100 points
    await c.request("q");
    expect(sleeps).toEqual([]);
  });

  it("retries a THROTTLED error delivered inside a 200 response", async () => {
    const throttled = json({
      errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
      extensions: cost(0, 100),
    });
    const { c, sleeps, calls } = client([throttled, ok(900)]);
    await expect(c.request("q")).resolves.toEqual({ hello: "world" });
    expect(calls).toHaveLength(2);
    expect(sleeps[0]).toBe(2000); // 100 points / 50 per second
  });

  it("honours Retry-After on HTTP 429", async () => {
    const { c, sleeps } = client([new Response("", { status: 429, headers: { "retry-after": "3" } }), ok(900)]);
    await c.request("q");
    expect(sleeps).toEqual([3000]);
  });

  it("backs off with jitter on 5xx and network errors, then succeeds", async () => {
    const { c, sleeps } = client([new Response("", { status: 502 }), new Error("ECONNRESET"), ok(900)]);
    await c.request("q");
    expect(sleeps).toEqual([499, 999]); // floor(0.999 * min(10000, 500 * 2^attempt))
  });

  it("gives up with a TransientError after maxAttempts", async () => {
    const { c, calls } = client(Array.from({ length: 4 }, () => new Response("", { status: 503 })));
    await expect(c.request("q")).rejects.toBeInstanceOf(TransientError);
    expect(calls).toHaveLength(4);
  });

  it("fails fast with a PermanentError on auth failures and GraphQL errors", async () => {
    const a = client([new Response("", { status: 401 })]);
    await expect(a.c.request("q")).rejects.toBeInstanceOf(PermanentError);
    const b = client([json({ errors: [{ message: "Field does not exist" }] })]);
    await expect(b.c.request("q")).rejects.toThrow(/Field does not exist/);
    expect(b.calls).toHaveLength(1);
  });
});
