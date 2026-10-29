import { afterEach, describe, expect, it } from "vitest";
import { postWebhook, runScenario, sampleOrder } from "../src/demo/scenario.js";
import { startDemoServer, type DemoServer } from "../src/demo/server.js";

let demo: DemoServer | undefined;
afterEach(async () => {
  await demo?.close();
  demo = undefined;
});

const start = (over: Parameters<typeof startDemoServer>[0] = {}) =>
  startDemoServer({ backoffBaseMs: 20, backoffCapMs: 40, downstreamTimeoutMs: 200, ...over });

const control = (url: string, mode: string, times?: number) =>
  fetch(`${url}/control/downstream`, { method: "POST", body: JSON.stringify({ mode, times }) });
const idle = (url: string) => fetch(`${url}/idle`);
const kinds = (d: DemoServer) => d.trace.entries.map((e) => e.kind);

describe("demo wiring", () => {
  it("accepts a valid signed webhook and delivers it downstream once", async () => {
    demo = await start();
    expect(await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" })).toBe(200);
    await idle(demo.url);
    expect(demo.downstream.state().delivered).toEqual(["dev-store.myshopify.com:orders/create:w1"]);
    expect(kinds(demo)).toEqual(["accepted", "delivered", "processed"]);
  });

  it("rejects a tampered body with 401 and queues nothing", async () => {
    demo = await start();
    const status = await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1", tamper: (b) => b.replace("129.90", "1.00") });
    expect(status).toBe(401);
    expect(demo.queue.depth).toBe(0);
    expect(demo.downstream.attempts).toBe(0);
    expect(kinds(demo)).toEqual(["rejected"]);
  });

  it("rejects a body signed with the wrong secret", async () => {
    demo = await start({ secret: "another-secret" });
    expect(await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" })).toBe(401);
  });

  it("acknowledges a duplicate delivery id but does not deliver twice", async () => {
    demo = await start();
    await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" });
    await idle(demo.url);
    expect(await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" })).toBe(200);
    await idle(demo.url);
    expect(demo.downstream.attempts).toBe(1);
    expect(kinds(demo)).toContain("deduped");
  });

  it("retries after downstream 500s and then delivers exactly once", async () => {
    demo = await start();
    await control(demo.url, "500", 2);
    await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" });
    await idle(demo.url);
    const s = demo.downstream.state();
    expect(s.attempts).toBe(3);
    expect(s.delivered).toHaveLength(1);
    expect(s.duplicates).toBe(0);
    expect(kinds(demo).filter((k) => k === "retry")).toHaveLength(2);
  });

  it("treats a downstream timeout as transient and retries", async () => {
    demo = await start();
    await control(demo.url, "timeout", 1);
    await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" });
    await idle(demo.url);
    expect(demo.downstream.state().delivered).toHaveLength(1);
    expect(kinds(demo)).toContain("retry");
  });

  it("moves a message to the dead-letter queue when the downstream never recovers", async () => {
    demo = await start({ maxReceiveCount: 3 });
    await control(demo.url, "500");
    await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" });
    await idle(demo.url);
    expect(demo.downstream.attempts).toBe(3);
    expect(demo.queue.dlq).toHaveLength(1);
    expect(kinds(demo)).toContain("dlq");
  });

  it("returns 500 to Shopify when the queue is unavailable, then accepts the retry", async () => {
    demo = await start();
    demo.queue.failSends = true;
    expect(await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" })).toBe(500);
    demo.queue.failSends = false;
    expect(await postWebhook(demo.url, sampleOrder(1, "#1"), { webhookId: "w1" })).toBe(200);
    await idle(demo.url);
    expect(demo.downstream.state().delivered).toHaveLength(1);
  });

  it("rejects an invalid control request", async () => {
    demo = await start();
    expect((await control(demo.url, "explode")).status).toBe(400);
  });

  it("runs the whole scripted scenario with the expected outcome", async () => {
    demo = await start();
    const lines: string[] = [];
    const summary = await runScenario(demo.url, (l) => lines.push(l));
    expect(summary).toEqual({ uniqueDeliveries: 3, downstreamAttempts: 6, duplicatesReceived: 0, deadLetters: 0 });
    const text = lines.join("\n");
    for (const word of ["ACCEPTED", "REJECTED", "DEDUPED", "RETRY", "DELIVERED"]) expect(text).toContain(word);
  });
});
