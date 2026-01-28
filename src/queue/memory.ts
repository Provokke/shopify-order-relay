import type { RelayMessage } from "../types.js";
import type { MessageQueue } from "./queue.js";

export class MemoryQueue implements MessageQueue {
  messages: RelayMessage[] = [];
  failNext = false;
  async send(message: RelayMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("queue unavailable");
    }
    this.messages.push(message);
  }
}
