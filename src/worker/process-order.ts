import type { Destination } from "../destination/destination.js";
import type { ShopifyGraphQLClient } from "../shopify/graphql-client.js";
import { ORDER_QUERY, type OrderQueryResult } from "../shopify/order-queries.js";
import { PermanentError, type OrderEvent, type RelayMessage } from "../types.js";

export const HANDLED_TOPICS = new Set(["orders/create", "orders/paid", "orders/cancelled"]);

interface OrderWebhookPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  name?: string;
  email?: string | null;
  currency?: string;
  total_price?: string;
  line_items?: { sku?: string | null; title?: string; quantity?: number }[];
}

/**
 * Build the downstream event. When a GraphQL client is supplied the order is re-read from the
 * Admin API, because webhook payloads can be stale by the time a retried delivery is processed.
 */
export async function buildOrderEvent(msg: RelayMessage, graphql?: ShopifyGraphQLClient): Promise<OrderEvent> {
  let payload: OrderWebhookPayload;
  try {
    payload = JSON.parse(msg.body) as OrderWebhookPayload;
  } catch {
    throw new PermanentError("webhook body is not valid JSON");
  }
  const gid = payload.admin_graphql_api_id ?? (payload.id !== undefined ? `gid://shopify/Order/${payload.id}` : undefined);
  if (!gid) throw new PermanentError("webhook payload has no order id");

  const base = {
    idempotencyKey: `${msg.shopDomain}:${msg.topic}:${msg.webhookId}`,
    topic: msg.topic,
    shopDomain: msg.shopDomain,
    orderId: gid,
  };

  if (graphql) {
    const { order } = await graphql.request<OrderQueryResult>(ORDER_QUERY, { id: gid }, 30);
    if (!order) throw new PermanentError(`order ${gid} not found via Admin API`);
    return {
      ...base,
      orderName: order.name,
      currency: order.totalPriceSet.shopMoney.currencyCode,
      total: order.totalPriceSet.shopMoney.amount,
      email: order.email,
      lineItems: order.lineItems.nodes.map((l) => ({ sku: l.sku, title: l.title, quantity: l.quantity })),
    };
  }

  return {
    ...base,
    orderName: payload.name ?? gid,
    currency: payload.currency ?? "",
    total: payload.total_price ?? "0.00",
    email: payload.email ?? null,
    lineItems: (payload.line_items ?? []).map((l) => ({ sku: l.sku ?? null, title: l.title ?? "", quantity: l.quantity ?? 0 })),
  };
}

export async function processMessage(msg: RelayMessage, destination: Destination, graphql?: ShopifyGraphQLClient): Promise<"sent" | "skipped"> {
  if (!HANDLED_TOPICS.has(msg.topic)) return "skipped";
  await destination.send(await buildOrderEvent(msg, graphql));
  return "sent";
}
