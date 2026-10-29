import type { SQSEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { HttpDestination } from "../src/destination/http.js";
import type { Destination } from "../src/destination/destination.js";
import { MemoryIdempotencyStore } from "../src/idempotency/memory.js";
import { silentLogger } from "../src/logger.js";
import { ShopifyGraphQLClient } from "../src/shopify/graphql-client.js";
import { PermanentError, TransientError, type OrderEvent, type RelayMessage } from "../src/types.js";
import { createWorkerHandler } from "../src/worker/handler.js";
import { fetchSequence, json, orderCreateBody } from "./helpers.js";

const msg = (over: Partial<RelayMessage> = {}): RelayMessage => ({
  webhookId: "wh-1",
  eventId: "ev-1",
  topic: "orders/create",
  shopDomain: "dev-store.myshopify.com",
  apiVersion: "2026-10",
  receivedAt: "2026-10-29T00:00:00.000Z",
  body: orderCreateBody,
  ...over,
});
const sqs = (...bodies: string[]): SQSEvent =>
  ({ Records: bodies.map((b, i) => ({ messageId: `m${i}`, body: b })) }) as unknown as SQSEvent;

class RecordingDestination implements Destination {
  sent: OrderEvent[] = [];
  error: Error | undefined;
  async send(e: OrderEvent) {
    if (this.error) throw this.error;
    this.sent.push(e);
  }
}

function setup(graphqlFor?: Parameters<typeof createWorkerHandler>[0]["graphqlFor"]) {
  const destination = new RecordingDestination();
  const store = new MemoryIdempotencyStore();
  const handler = createWorkerHandler({ store, destination, logger: silentLogger, ...(graphqlFor ? { graphqlFor } : {}) });
  return { destination, handler, store };
}

describe("worker handler", () => {
  it("maps the webhook payload and sends it with a stable idempotency key", async () => {
    const { handler, destination } = setup();
    const out = await handler(sqs(JSON.stringify(msg())));
    expect(out.batchItemFailures).toEqual([]);
    expect(destination.sent[0]).toEqual({
      idempotencyKey: "dev-store.myshopify.com:orders/create:wh-1",
      topic: "orders/create",
      shopDomain: "dev-store.myshopify.com",
      orderId: "gid://shopify/Order/820982911946154500",
      orderName: "#1001",
      currency: "AUD",
      total: "129.90",
      email: "jane.example@example.com",
      lineItems: [
        { sku: "TEE-BLK-M", title: "Black Tee (M)", quantity: 2 },
        { sku: null, title: "Gift wrap", quantity: 1 },
      ],
    });
  });

  it("does not send twice when the same message is redelivered", async () => {
    const { handler, destination } = setup();
    await handler(sqs(JSON.stringify(msg())));
    await handler(sqs(JSON.stringify(msg())));
    expect(destination.sent).toHaveLength(1);
  });

  it("reports only the failed message and allows an immediate retry", async () => {
    const { handler, destination } = setup();
    destination.error = new TransientError("destination returned 503");
    const out = await handler(sqs(JSON.stringify(msg()), JSON.stringify(msg({ webhookId: "wh-2", topic: "customers/update" }))));
    expect(out.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    destination.error = undefined;
    const retry = await handler(sqs(JSON.stringify(msg())));
    expect(retry.batchItemFailures).toEqual([]);
    expect(destination.sent).toHaveLength(1);
  });

  it("reports a message that is leased by a concurrent invocation", async () => {
    const { handler, store } = setup();
    await store.claim("process:wh-1", 60_000);
    const out = await handler(sqs(JSON.stringify(msg())));
    expect(out.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
  });

  it("fails unparseable messages and permanent errors so they reach the DLQ", async () => {
    const { handler, destination } = setup();
    destination.error = new PermanentError("rejected");
    const out = await handler(sqs("not json", JSON.stringify(msg()), JSON.stringify(msg({ webhookId: "wh-3", body: "{" }))));
    expect(out.batchItemFailures.map((f) => f.itemIdentifier)).toEqual(["m0", "m1", "m2"]);
  });

  it("ignores topics it does not handle", async () => {
    const { handler, destination } = setup();
    const out = await handler(sqs(JSON.stringify(msg({ topic: "products/update" }))));
    expect(out.batchItemFailures).toEqual([]);
    expect(destination.sent).toHaveLength(0);
  });

  it("re-reads the order from the Admin API when a client is provided", async () => {
    const { fn, calls } = fetchSequence([
      json({
        data: {
          order: {
            id: "gid://shopify/Order/820982911946154500",
            name: "#1001",
            email: null,
            currencyCode: "AUD",
            totalPriceSet: { shopMoney: { amount: "99.00", currencyCode: "AUD" } },
            lineItems: { nodes: [{ sku: "TEE-BLK-M", title: "Black Tee (M)", quantity: 1 }] },
          },
        },
      }),
    ]);
    const { handler, destination } = setup(
      (shopDomain) => new ShopifyGraphQLClient({ shopDomain, accessToken: "t", apiVersion: "2026-10", fetch: fn }),
    );
    await handler(sqs(JSON.stringify(msg())));
    expect(calls).toHaveLength(1);
    expect(destination.sent[0]).toMatchObject({ total: "99.00", email: null, lineItems: [{ quantity: 1 }] });
  });
});

describe("HttpDestination", () => {
  const event = { idempotencyKey: "k" } as OrderEvent;
  const dest = (r: Response | Error) => new HttpDestination("https://erp.test/o", "tok", fetchSequence([r]).fn);

  it("sends the idempotency key header", async () => {
    const { fn, calls } = fetchSequence([new Response("", { status: 201 })]);
    await new HttpDestination("https://erp.test/o", "tok", fn).send(event);
    expect((calls[0]?.init.headers as Record<string, string>)["idempotency-key"]).toBe("k");
  });
  it("classifies 5xx, 429 and network errors as transient", async () => {
    await expect(dest(new Response("", { status: 503 })).send(event)).rejects.toBeInstanceOf(TransientError);
    await expect(dest(new Response("", { status: 429 })).send(event)).rejects.toBeInstanceOf(TransientError);
    await expect(dest(new Error("boom")).send(event)).rejects.toBeInstanceOf(TransientError);
  });
  it("classifies other 4xx as permanent", async () => {
    await expect(dest(new Response("", { status: 422 })).send(event)).rejects.toBeInstanceOf(PermanentError);
  });
});
