import { PermanentError, TransientError, type OrderEvent } from "../types.js";
import type { Destination } from "./destination.js";

/**
 * POSTs the event to a downstream system (ERP/WMS/3PL). The idempotency key is sent as the
 * Idempotency-Key header so the receiver can dedupe if our own record is lost between send and complete().
 * 408/429/5xx and network errors are transient; every other non-2xx is permanent.
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
