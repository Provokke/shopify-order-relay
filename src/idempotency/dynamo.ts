import {
  ConditionalCheckFailedException,
  DeleteItemCommand,
  type DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { ClaimResult, IdempotencyStore } from "./store.js";

/**
 * DynamoDB-backed store. Table: partition key `pk` (S), TTL attribute `expiresAt` (N, epoch seconds).
 * Attribute `state` is "leased" or "done".
 * DynamoDB TTL deletion is lazy (can lag by hours), so expiry is also checked in the condition.
 */
export class DynamoIdempotencyStore implements IdempotencyStore {
  constructor(
    private client: Pick<DynamoDBClient, "send">,
    private table: string,
    private nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async claim(key: string, leaseMs: number): Promise<ClaimResult> {
    const now = this.nowSeconds();
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.table,
          Item: {
            pk: { S: key },
            state: { S: "leased" },
            expiresAt: { N: String(now + Math.ceil(leaseMs / 1000)) },
          },
          ConditionExpression: "attribute_not_exists(pk) OR expiresAt < :now",
          ExpressionAttributeValues: { ":now": { N: String(now) } },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return "acquired";
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        return err.Item?.state?.S === "done" ? "done" : "in_progress";
      }
      throw err;
    }
  }

  async complete(key: string, ttlSeconds: number): Promise<void> {
    await this.client.send(
      new UpdateItemCommand({
        TableName: this.table,
        Key: { pk: { S: key } },
        UpdateExpression: "SET #s = :done, expiresAt = :exp",
        ExpressionAttributeNames: { "#s": "state" },
        ExpressionAttributeValues: {
          ":done": { S: "done" },
          ":exp": { N: String(this.nowSeconds() + ttlSeconds) },
        },
      }),
    );
  }

  async release(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.table,
          Key: { pk: { S: key } },
          // Never delete a record that has already been completed.
          ConditionExpression: "#s = :leased",
          ExpressionAttributeNames: { "#s": "state" },
          ExpressionAttributeValues: { ":leased": { S: "leased" } },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  }
}
