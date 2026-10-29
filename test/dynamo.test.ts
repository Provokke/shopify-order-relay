import { ConditionalCheckFailedException, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { describe, expect, it } from "vitest";
import { DynamoIdempotencyStore } from "../src/idempotency/dynamo.js";

/** Stub that records commands and replays scripted outcomes. No AWS calls are made. */
function stub(outcomes: (unknown | Error)[]) {
  const inputs: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      inputs.push({ name: cmd.constructor.name, input: cmd.input });
      const o = outcomes.shift();
      if (o instanceof Error) throw o;
      return o ?? {};
    },
  } as unknown as Pick<DynamoDBClient, "send">;
  return { client, inputs };
}
const conditionFailed = (state?: string) =>
  new ConditionalCheckFailedException({
    message: "x",
    $metadata: {},
    ...(state ? { Item: { state: { S: state } } } : {}),
  });

describe("DynamoIdempotencyStore", () => {
  it("claims with a conditional put that tolerates expired leases", async () => {
    const { client, inputs } = stub([{}]);
    const s = new DynamoIdempotencyStore(client, "tbl", () => 1000);
    await expect(s.claim("k", 30_000)).resolves.toBe("acquired");
    expect(inputs[0]?.name).toBe("PutItemCommand");
    expect(inputs[0]?.input.ConditionExpression).toBe("attribute_not_exists(pk) OR expiresAt < :now");
    expect((inputs[0]?.input.Item as Record<string, unknown>).expiresAt).toEqual({ N: "1030" });
  });
  it("maps condition failures to done / in_progress", async () => {
    const s = new DynamoIdempotencyStore(stub([conditionFailed("done"), conditionFailed("leased")]).client, "tbl");
    await expect(s.claim("k", 1000)).resolves.toBe("done");
    await expect(s.claim("k", 1000)).resolves.toBe("in_progress");
  });
  it("rethrows unexpected errors", async () => {
    const s = new DynamoIdempotencyStore(stub([new Error("throttled")]).client, "tbl");
    await expect(s.claim("k", 1000)).rejects.toThrow("throttled");
  });
  it("only deletes leased records on release", async () => {
    const { client, inputs } = stub([conditionFailed()]);
    const s = new DynamoIdempotencyStore(client, "tbl");
    await expect(s.release("k")).resolves.toBeUndefined();
    expect(inputs[0]?.input.ConditionExpression).toBe("#s = :leased");
  });
  it("marks complete with a TTL", async () => {
    const { client, inputs } = stub([{}]);
    await new DynamoIdempotencyStore(client, "tbl", () => 100).complete("k", 50);
    expect((inputs[0]?.input.ExpressionAttributeValues as Record<string, unknown>)[":exp"]).toEqual({ N: "150" });
  });
});
