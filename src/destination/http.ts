import { PermanentError, TransientError, type OrderEvent } from "../types.js";
import type { Destination } from "./destination.js";

/**
 * POSTs the event downstream with the idempotency key as an Idempotency-Key header.
 * 408/429/5xx and network errors are transient, any other non-2xx is permanent.
 */
export class HttpDestination implements Destination {
  constructor(
    private url: string,
    private token: string,
    private fetchFn: typeof fetch = fetch,
    private timeoutMs = 8000,
  ) {}

  async send(event: OrderEvent): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
          "idempotency-key": event.idempotencyKey,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new TransientError(`destination unreachable: ${String(err)}`);
    }
    if (res.ok) return;
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new TransientError(`destination returned ${res.status}`);
    }
    throw new PermanentError(`destination rejected event with ${res.status}`);
  }
}
