import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { Destination } from "../destination/destination.js";
import type { IdempotencyStore } from "../idempotency/store.js";
import type { Logger } from "../logger.js";
import type { ShopifyGraphQLClient } from "../shopify/graphql-client.js";
import { PermanentError, type RelayMessage } from "../types.js";
import { processMessage } from "./process-order.js";

export interface WorkerDeps {
  store: IdempotencyStore;
  destination: Destination;
  logger: Logger;
  /** Optional: re-read the order from the Admin API before sending. */
  graphqlFor?: (shopDomain: string) => ShopifyGraphQLClient;
  /** Must be longer than the worst-case processing time of one message. */
  leaseMs?: number;
}

const DONE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * SQS consumer using partial batch responses (enable ReportBatchItemFailures on the event source
 * mapping): only failed messages return to the queue; after maxReceiveCount they land in the DLQ.
 */
export function createWorkerHandler(deps: WorkerDeps) {
  const leaseMs = deps.leaseMs ?? 5 * 60_000;

  return async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
    const failures: SQSBatchResponse["batchItemFailures"] = [];

    for (const record of event.Records) {
      let msg: RelayMessage;
      try {
        msg = JSON.parse(record.body) as RelayMessage;
      } catch {
        deps.logger.error("unparseable queue message, sending to DLQ", { messageId: record.messageId });
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const key = `process:${msg.webhookId}`;
      const claim = await deps.store.claim(key, leaseMs);
      if (claim === "done") {
        deps.logger.info("already processed, skipping", { webhookId: msg.webhookId });
        continue;
      }
      if (claim === "in_progress") {
        // Another invocation holds the lease; let SQS redeliver after the visibility timeout.
        deps.logger.warn("message in progress elsewhere", { webhookId: msg.webhookId });
        failures.push({ itemIdentifier: record.messageId });
        continue;
      }

      try {
        const graphql = deps.graphqlFor?.(msg.shopDomain);
        const outcome = await processMessage(msg, deps.destination, graphql);
        await deps.store.complete(key, DONE_TTL_SECONDS);
        deps.logger.info("message processed", { webhookId: msg.webhookId, topic: msg.topic, outcome });
      } catch (err) {
        await deps.store.release(key).catch(() => undefined);
        const permanent = err instanceof PermanentError;
        deps.logger.error("processing failed", { webhookId: msg.webhookId, topic: msg.topic, permanent, error: String(err) });
        // Permanent failures are also reported: retrying is futile but the DLQ keeps the evidence.
        failures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
