/** Message the ingest function puts on the queue for the worker. */
export interface RelayMessage {
  webhookId: string;
  eventId: string | undefined;
  topic: string;
  shopDomain: string;
  apiVersion: string | undefined;
  receivedAt: string;
  /** Raw webhook body, kept as is so the worker sees exactly what Shopify sent. */
  body: string;
}

/** Normalised event sent downstream. */
export interface OrderEvent {
  idempotencyKey: string;
  topic: string;
  shopDomain: string;
  orderId: string;
  orderName: string;
  currency: string;
  total: string;
  email: string | null;
  lineItems: { sku: string | null; title: string; quantity: number }[];
}

/** For failures retrying can't fix (bad payload, 4xx from the destination). */
export class PermanentError extends Error {
  override name = "PermanentError";
}

/** For failures worth retrying (5xx, timeouts, throttling). */
export class TransientError extends Error {
  override name = "TransientError";
}
