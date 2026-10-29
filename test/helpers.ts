import { readFileSync } from "node:fs";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { signBody } from "../src/hmac.js";

export const SECRET = "test-client-secret";

export const orderCreateBody = readFileSync(new URL("./fixtures/orders-create.json", import.meta.url), "utf8");

export function webhookEvent(
  body: string,
  overrides: Record<string, string | undefined> = {},
  secret = SECRET,
): APIGatewayProxyEventV2 {
  const headers: Record<string, string | undefined> = {
    "x-shopify-hmac-sha256": signBody(body, secret),
    "x-shopify-webhook-id": "wh-1",
    "x-shopify-event-id": "ev-1",
    "x-shopify-topic": "orders/create",
    "x-shopify-shop-domain": "dev-store.myshopify.com",
    "x-shopify-api-version": "2026-10",
    ...overrides,
  };
  return { body, headers, isBase64Encoded: false } as unknown as APIGatewayProxyEventV2;
}

/** Build a fetch stub that returns the given responses in order. */
export function fetchSequence(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("fetch called more times than expected");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
