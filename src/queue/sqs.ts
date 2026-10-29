import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { RelayMessage } from "../types.js";
import type { MessageQueue } from "./queue.js";

export class SqsQueue implements MessageQueue {
  constructor(
    private client: Pick<SQSClient, "send">,
    private queueUrl: string,
  ) {}
  async send(message: RelayMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(message) }));
  }
}
