import type { RelayMessage } from "../types.js";

export interface MessageQueue {
  send(message: RelayMessage): Promise<void>;
}
