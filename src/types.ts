/** Message placed on the queue by the ingest function and consumed by the worker. */
export interface RelayMessage {
  webhookId: string;
  eventId: string | undefined;
  topic: string;
  shopDomain: string;
  apiVersion: string | undefined;
  receivedAt: string;
  /** Raw webhook body, kept verbatim so the worker sees exactly what Shopify sent. */
  body: string;
}

/** Normalised event sent to the downstream system. */
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

/** Thrown for failures that retrying cannot fix (bad payload, 4xx from destination). */
export class PermanentError extends Error {
  override name = "PermanentError";
}

/** Thrown for failures worth retrying (5xx, timeouts, throttling). */
export class TransientError extends Error {
  override name = "TransientError";
}
