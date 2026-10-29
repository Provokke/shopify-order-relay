import type { OrderEvent } from "../types.js";

export interface Destination {
  send(event: OrderEvent): Promise<void>;
}
