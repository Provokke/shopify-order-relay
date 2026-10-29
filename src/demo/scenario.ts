import { signBody } from "../hmac.js";
import { DEFAULT_DEMO_SECRET, WEBHOOK_PATH, startDemoServer } from "./server.js";
import { formatTraceEntry, type TraceEntry } from "./trace.js";

/** A representative orders/create payload (fictional customer, example.com address). */
export function sampleOrder(id: number, name: string): string {
  return JSON.stringify({
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name,
    email: "jane.example@example.com",
    currency: "AUD",
    total_price: "129.90",
    line_items: [
      { sku: "TEE-BLK-M", title: "Black Tee (M)", quantity: 2 },
      { sku: null, title: "Gift wrap", quantity: 1 },
    ],
  });
}

export interface WebhookOptions {
  webhookId: string;
  topic?: string;
  secret?: string;
  /** Replace the body after signing, so the signature no longer matches. */
  tamper?: (body: string) => string;
}

/** POST a Shopify-style signed webhook. Returns the HTTP status. */
export async function postWebhook(baseUrl: string, body: string, o: WebhookOptions): Promise<number> {
  const signature = signBody(body, o.secret ?? DEFAULT_DEMO_SECRET);
  const res = await fetch(`${baseUrl}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": signature,
      "x-shopify-webhook-id": o.webhookId,
      "x-shopify-event-id": `ev-${o.webhookId}`,
      "x-shopify-topic": o.topic ?? "orders/create",
      "x-shopify-shop-domain": "dev-store.myshopify.com",
      "x-shopify-api-version": "2026-10",
    },
    body: o.tamper ? o.tamper(body) : body,
  });
  return res.status;
}

async function control(baseUrl: string, mode: "ok" | "500" | "timeout", times?: number): Promise<void> {
  await fetch(`${baseUrl}/control/downstream`, { method: "POST", body: JSON.stringify({ mode, times }) });
}

export interface Summary {
  uniqueDeliveries: number;
  downstreamAttempts: number;
  duplicatesReceived: number;
  deadLetters: number;
}

/**
 * The scripted tour. Talks to the demo server only over HTTP, so it works against a server
 * started separately (`npm run demo:local`) as well as an in-process one.
 */
export async function runScenario(baseUrl: string, print: (line: string) => void): Promise<Summary> {
  let cursor = 0;
  const flush = async () => {
    const entries = (await (await fetch(`${baseUrl}/trace?since=${cursor}`)).json()) as TraceEntry[];
    for (const e of entries) print(formatTraceEntry(e));
    cursor += entries.length;
  };
  const step = async (title: string) => {
    await flush();
    print("");
    print(`== ${title}`);
  };
  const settle = async () => {
    await fetch(`${baseUrl}/idle`);
    await flush();
  };

  type State = { downstream: { attempts: number; delivered: string[]; duplicates: number }; deadLetters: number };
  const getState = async () => (await (await fetch(`${baseUrl}/state`)).json()) as State;
  const before = await getState();
  await control(baseUrl, "ok");
  await step("1. Valid signed order webhook: accepted, queued, delivered once");
  await postWebhook(baseUrl, sampleOrder(1001, "#1001"), { webhookId: "demo-1" });
  await settle();

  await step("2. Same payload, tampered after signing: rejected with 401");
  await postWebhook(baseUrl, sampleOrder(1002, "#1002"), {
    webhookId: "demo-2",
    tamper: (b) => b.replace('"129.90"', '"1.00"'),
  });
  await settle();

  await step("3. Shopify re-sends delivery demo-1: deduped, not delivered again");
  await postWebhook(baseUrl, sampleOrder(1001, "#1001"), { webhookId: "demo-1" });
  await settle();

  await step("4. Downstream returns 500 twice: worker fails, SQS retries with backoff, then delivered once");
  await control(baseUrl, "500", 2);
  await postWebhook(baseUrl, sampleOrder(1003, "#1003"), { webhookId: "demo-3" });
  await settle();

  await step("5. Downstream hangs once (relay times out after 1s): retried, delivered once");
  await control(baseUrl, "timeout", 1);
  await postWebhook(baseUrl, sampleOrder(1004, "#1004"), { webhookId: "demo-4" });
  await settle();

  await step("6. Summary");
  const state = await getState();
  const summary: Summary = {
    uniqueDeliveries: state.downstream.delivered.length - before.downstream.delivered.length,
    downstreamAttempts: state.downstream.attempts - before.downstream.attempts,
    duplicatesReceived: state.downstream.duplicates - before.downstream.duplicates,
    deadLetters: state.deadLetters - before.deadLetters,
  };
  print("  webhooks sent: 5 requests (4 distinct delivery ids; demo-1 sent twice, demo-2 tampered)");
  print(`  unique orders delivered downstream: ${summary.uniqueDeliveries} (expected 3: demo-1, demo-3, demo-4)`);
  print(`  downstream attempts including failures: ${summary.downstreamAttempts}`);
  print(`  duplicate deliveries that reached downstream: ${summary.duplicatesReceived} (expected 0)`);
  print(`  dead-lettered: ${summary.deadLetters}`);
  return summary;
}

/** `node dist/demo/scenario.js` runs its own server; with --url it targets one already running. */
async function main(): Promise<void> {
  const i = process.argv.indexOf("--url");
  const remote = i > -1 ? process.argv[i + 1] : undefined;
  if (remote) {
    await runScenario(remote.replace(/\/$/, ""), console.log);
    return;
  }
  const demo = await startDemoServer();
  try {
    console.log(`In-process demo server on ${demo.url} (in-memory SQS/DynamoDB stand-ins, mock downstream)\n`);
    await runScenario(demo.url, console.log);
  } finally {
    await demo.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
