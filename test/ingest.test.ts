import { describe, expect, it } from "vitest";
import { MemoryIdempotencyStore } from "../src/idempotency/memory.js";
import { createIngestHandler } from "../src/ingest/handler.js";
import { silentLogger } from "../src/logger.js";
import { MemoryQueue } from "../src/queue/memory.js";
import { SECRET, orderCreateBody, webhookEvent } from "./helpers.js";

function setup() {
  const store = new MemoryIdempotencyStore();
  const queue = new MemoryQueue();
  const handler = createIngestHandler({ secret: SECRET, store, queue, logger: silentLogger, now: () => new Date("2026-10-29T00:00:00Z") });
  return { handler, queue };
}

describe("ingest handler", () => {
  it("queues a valid webhook verbatim and returns 200", async () => {
    const { handler, queue } = setup();
    const res = await handler(webhookEvent(orderCreateBody));
    expect(res).toMatchObject({ statusCode: 200 });
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]).toMatchObject({
      webhookId: "wh-1",
      eventId: "ev-1",
      topic: "orders/create",
      shopDomain: "dev-store.myshopify.com",
      receivedAt: "2026-10-29T00:00:00.000Z",
      body: orderCreateBody,
    });
  });

  it("returns 401 and queues nothing for a bad signature", async () => {
    const { handler, queue } = setup();
    const res = await handler(webhookEvent(orderCreateBody, {}, "wrong-secret"));
    expect(res).toMatchObject({ statusCode: 401 });
    expect(queue.messages).toHaveLength(0);
  });

  it("returns 401 when the signature header is absent", async () => {
    const { handler } = setup();
    const res = await handler(webhookEvent(orderCreateBody, { "x-shopify-hmac-sha256": undefined }));
    expect(res).toMatchObject({ statusCode: 401 });
  });

  it("returns 400 for a signed request missing the webhook id", async () => {
    const { handler } = setup();
    const res = await handler(webhookEvent(orderCreateBody, { "x-shopify-webhook-id": undefined }));
    expect(res).toMatchObject({ statusCode: 400 });
  });

  it("verifies the HMAC against base64-decoded bodies", async () => {
    const { handler, queue } = setup();
    const ev = webhookEvent(orderCreateBody);
    ev.body = Buffer.from(orderCreateBody).toString("base64");
    ev.isBase64Encoded = true;
    expect(await handler(ev)).toMatchObject({ statusCode: 200 });
    expect(queue.messages[0]?.body).toBe(orderCreateBody);
  });

  it("acknowledges but does not re-queue a duplicate delivery", async () => {
    const { handler, queue } = setup();
    await handler(webhookEvent(orderCreateBody));
    const res = await handler(webhookEvent(orderCreateBody));
    expect(res).toMatchObject({ statusCode: 200 });
    expect(queue.messages).toHaveLength(1);
  });

  it("treats a different webhook id for the same event id as a new delivery", async () => {
    const { handler, queue } = setup();
    await handler(webhookEvent(orderCreateBody));
    await handler(webhookEvent(orderCreateBody, { "x-shopify-webhook-id": "wh-2" }));
    expect(queue.messages).toHaveLength(2);
  });

  it("returns 500 when the queue is down and lets the retry through afterwards", async () => {
    const { handler, queue } = setup();
    queue.failNext = true;
    expect(await handler(webhookEvent(orderCreateBody))).toMatchObject({ statusCode: 500 });
    expect(queue.messages).toHaveLength(0);
    expect(await handler(webhookEvent(orderCreateBody))).toMatchObject({ statusCode: 200 });
    expect(queue.messages).toHaveLength(1);
  });
});
