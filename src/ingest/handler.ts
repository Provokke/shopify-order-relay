import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { verifyShopifyHmac } from "../hmac.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import type { Logger } from "../logger.js";
import type { MessageQueue } from "../queue/queue.js";

export interface IngestDeps {
  secret: string;
  store: IdempotencyStore;
  queue: MessageQueue;
  logger: Logger;
  now?: () => Date;
}

/** Shopify retries for about 4 hours, so remember delivery ids for a day. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;
/** Lease covers the window between claiming and a successful enqueue. */
const CLAIM_LEASE_MS = 30_000;

const res = (statusCode: number, body = ""): APIGatewayProxyResultV2 => ({ statusCode, body });

/**
 * Ingest function: verify, dedupe, enqueue, answer fast.
 * Shopify requires a 2xx within 5 seconds, so no business logic runs here.
 *
 * Status codes: 200 accepted (or duplicate), 400 missing headers, 401 bad signature,
 * 500 could not enqueue (Shopify will retry the delivery).
 */
export function createIngestHandler(deps: IngestDeps) {
  const now = deps.now ?? (() => new Date());

  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    // API Gateway lowercases header names. The body must stay byte-exact for HMAC.
    const h = event.headers ?? {};
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64") : Buffer.from(event.body ?? "", "utf8");

    if (!verifyShopifyHmac(raw, h["x-shopify-hmac-sha256"], deps.secret)) {
      deps.logger.warn("hmac verification failed");
      return res(401);
    }

    const webhookId = h["x-shopify-webhook-id"];
    const topic = h["x-shopify-topic"];
    const shopDomain = h["x-shopify-shop-domain"];
    if (!webhookId || !topic || !shopDomain) {
      deps.logger.warn("signed webhook missing required headers", { webhookId, topic, shopDomain });
      return res(400);
    }

    const key = `ingest:${webhookId}`;
    const claim = await deps.store.claim(key, CLAIM_LEASE_MS);
    if (claim !== "acquired") {
      deps.logger.info("duplicate delivery ignored", { webhookId, topic, claim });
      return res(200);
    }

    try {
      await deps.queue.send({
        webhookId,
        eventId: h["x-shopify-event-id"],
        topic,
        shopDomain,
        apiVersion: h["x-shopify-api-version"],
        receivedAt: now().toISOString(),
        body: raw.toString("utf8"),
      });
    } catch (err) {
      // Free the claim so Shopify's retry is not mistaken for a duplicate, then ask for a retry.
      await deps.store.release(key).catch(() => undefined);
      deps.logger.error("enqueue failed", { webhookId, topic, error: String(err) });
      return res(500);
    }

    await deps.store.complete(key, DEDUPE_TTL_SECONDS).catch((err) => {
      // The message is already queued; the worker's own idempotency covers a later duplicate.
      deps.logger.warn("could not mark ingest complete", { webhookId, error: String(err) });
    });
    deps.logger.info("webhook queued", { webhookId, topic, shopDomain });
    return res(200);
  };
}
