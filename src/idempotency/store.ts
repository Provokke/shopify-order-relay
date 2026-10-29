export type ClaimResult = "acquired" | "done" | "in_progress";

/**
 * Two-phase idempotency record.
 *  - claim():    atomically take a lease unless the key is done or leased by someone else.
 *  - complete(): mark done (until TTL expiry).
 *  - release():  drop the lease so the next attempt can retry immediately.
 * A crashed worker never calls release(); its lease simply expires.
 */
export interface IdempotencyStore {
  claim(key: string, leaseMs: number): Promise<ClaimResult>;
  complete(key: string, ttlSeconds: number): Promise<void>;
  release(key: string): Promise<void>;
}
