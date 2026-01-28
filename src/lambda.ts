/** Lambda entrypoints. Wiring only, the logic is in the handlers. Not covered by tests (needs real AWS). */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { requireEnv } from "./config.js";
import { HttpDestination } from "./destination/http.js";
import { DynamoIdempotencyStore } from "./idempotency/dynamo.js";
import { createIngestHandler } from "./ingest/handler.js";
import { jsonLogger } from "./logger.js";
import { SqsQueue } from "./queue/sqs.js";
import { ShopifyGraphQLClient } from "./shopify/graphql-client.js";
import { createWorkerHandler } from "./worker/handler.js";

const store = new DynamoIdempotencyStore(new DynamoDBClient({}), requireEnv("IDEMPOTENCY_TABLE"));

export const ingest = createIngestHandler({
  secret: requireEnv("SHOPIFY_API_SECRET"),
  store,
  queue: new SqsQueue(new SQSClient({}), requireEnv("ORDER_QUEUE_URL")),
  logger: jsonLogger,
});

export const worker = createWorkerHandler({
  store,
  destination: new HttpDestination(requireEnv("DESTINATION_URL"), requireEnv("DESTINATION_TOKEN")),
  logger: jsonLogger,
  // Single shop setup. A multi-shop app would look up the offline token per shop domain.
  graphqlFor: (shopDomain) =>
    new ShopifyGraphQLClient({
      shopDomain,
      accessToken: requireEnv("SHOPIFY_ADMIN_TOKEN"),
      apiVersion: process.env.SHOPIFY_API_VERSION ?? "2026-10",
      logger: jsonLogger,
    }),
});
