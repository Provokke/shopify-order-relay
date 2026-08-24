# shopify-order-relay

A serverless TypeScript pipeline that gets orders out of Shopify and into another system (ERP, WMS, 3PL, accounting) without losing or duplicating them. It's a small reference implementation, not a framework. The reliability logic is injectable and unit tested offline.

## How it works

```
Shopify webhook -> API Gateway -> Ingest Lambda (verify HMAC, dedupe, enqueue)
                                      |
                              SQS queue (+ DLQ) -> Worker Lambda -> downstream system
                                                       |
                                          optional re-read via Admin GraphQL
```

- Ingest checks the HMAC-SHA256 of the raw body, dedupes on `X-Shopify-Webhook-Id`, enqueues and answers in milliseconds. No business logic runs there, because Shopify wants a response within 5 seconds.
- The worker takes a lease in DynamoDB, optionally re-reads the order from the Admin API (a retried webhook can be hours old), and POSTs it downstream with a deterministic `Idempotency-Key`. Failures use SQS partial batch responses and end up in the DLQ.
- The GraphQL client tracks the cost bucket, waits when a query won't fit, and retries `THROTTLED` and 429 responses.
- Delivery is at least once with effectively once effects. If the downstream call succeeds but `complete()` fails, the retry re-sends, so the downstream should honour `Idempotency-Key`.

Code map: `src/ingest/`, `src/worker/`, `src/shopify/graphql-client.ts`, `src/idempotency/` (in-memory and DynamoDB), `src/destination/http.ts`, `src/lambda.ts` (env wiring only), `test/` (offline, with signed fixtures).

## Run locally

Needs Node 20+. No Shopify store or AWS account.

```bash
npm install
npm run check          # typecheck, lint, tests
npm run build          # emits dist/
npm run demo:scenario  # starts everything, runs a scripted tour, prints the trace, exits
```

The demo runs the real handlers against in-memory stand-ins for SQS and DynamoDB plus a mock downstream that can be told to fail. It sends a valid signed order, a tampered body (401), a repeated delivery id (deduped), then makes the downstream return 500 twice and hang once so you see retries with backoff and one delivery per order. The stand-ins model retry delays, receive counts and a DLQ, not real AWS behaviour.

To drive it yourself, run `npm run demo:local` in one terminal (listens on `http://127.0.0.1:8787/webhooks/shopify`, override with `PORT`, `HOST`, `SHOPIFY_API_SECRET`) and `npm run demo:send` in another. `.env.example` lists what the deployed functions read.

```bash
SECRET=demo-shopify-client-secret
BODY=$(cat test/fixtures/orders-create.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64)
curl -i -X POST http://127.0.0.1:8787/webhooks/shopify \
  -H "Content-Type: application/json" -H "X-Shopify-Hmac-SHA256: $SIG" \
  -H "X-Shopify-Webhook-Id: curl-1" -H "X-Shopify-Topic: orders/create" \
  -H "X-Shopify-Shop-Domain: dev-store.myshopify.com" --data-binary "$BODY"
# make the next 2 downstream requests fail, then resend with a new Webhook-Id
curl -X POST http://127.0.0.1:8787/control/downstream -d '{"mode":"500","times":2}'   # or "timeout", "ok"
```

## Deploying (no IaC included)

You'll need a DynamoDB table (partition key `pk`, TTL attribute `expiresAt`), an SQS queue with a DLQ and a visibility timeout of at least 6x the worker timeout, an ingest Lambda (`dist/lambda.ingest`) behind `POST /webhooks/shopify`, and a worker Lambda (`dist/lambda.worker`) with an SQS event source mapping and `ReportBatchItemFailures` enabled. Add an alarm on DLQ depth, and subscribe to `orders/create`, `orders/paid` and `orders/cancelled`.

Env vars are `SHOPIFY_API_SECRET`, `IDEMPOTENCY_TABLE`, `ORDER_QUEUE_URL`, `DESTINATION_URL`, `DESTINATION_TOKEN`, `SHOPIFY_ADMIN_TOKEN` and `SHOPIFY_API_VERSION`. Keep secrets in SSM or Secrets Manager rather than plain environment variables. The Admin token only needs `read_orders`.

## Caveats

- Never run against a real Shopify store or deployed to AWS. Header names, the HMAC scheme and the `extensions.cost` shape come from Shopify's docs, not real deliveries.
- The order GraphQL query hasn't been checked against the live schema for the pinned API version (`2026-10`).
- Single shop token in env. A public multi-tenant app would need OAuth, per-shop tokens and the GDPR webhooks.
- No replay window check (Shopify gives no signed timestamp) and no load testing. Each Lambda keeps its own bucket estimate.
- After a secret rotation Shopify can take up to an hour to switch signing keys, so consider accepting two secrets.
- Typecheck, lint and 45 tests pass offline, and CI runs the same plus a build.

## Licence

MIT, see [LICENSE](LICENSE).
