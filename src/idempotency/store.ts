export type ClaimResult = "acquired" | "done" | "in_progress";

/**
 * Two phase idempotency record.
 *  - claim():    take a lease unless the key is done or someone else holds it.
 *  - complete(): mark done until the TTL expires.
 *  - release():  drop the lease so the next attempt can go straight away.
 * A crashed worker never releases, its lease just expires.
 */
export interface IdempotencyStore {
  claim(key: string, leaseMs: number): Promise<ClaimResult>;
  complete(key: string, ttlSeconds: number): Promise<void>;
  release(key: string): Promise<void>;
}
