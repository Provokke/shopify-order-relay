import { DEFAULT_DEMO_SECRET, WEBHOOK_PATH, startDemoServer } from "./server.js";

/**
 * `npm run demo:local`: long-running local server. Env: PORT (8787), HOST (127.0.0.1),
 * SHOPIFY_API_SECRET (defaults to a demo value; set it to your app's client secret to receive
 * real Shopify deliveries through a tunnel).
 */
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const secret = process.env.SHOPIFY_API_SECRET || DEFAULT_DEMO_SECRET;

const demo = await startDemoServer({ port, host, secret, sink: console.log });
console.log(`shopify-order-relay local demo (no AWS: in-memory queue and idempotency store, mock downstream)`);
console.log(`  webhook endpoint : http://${host}:${port}${WEBHOOK_PATH}`);
console.log(`  signing secret   : ${secret === DEFAULT_DEMO_SECRET ? `${DEFAULT_DEMO_SECRET} (demo value)` : "from SHOPIFY_API_SECRET"}`);
console.log(`  scripted tour    : npm run demo:send   (in another terminal)`);
console.log(`  break downstream : curl -X POST http://${host}:${port}/control/downstream -d '{"mode":"500","times":2}'`);
console.log(`Ctrl+C to stop.\n`);

process.on("SIGINT", () => {
  void demo.close().then(() => process.exit(0));
});
