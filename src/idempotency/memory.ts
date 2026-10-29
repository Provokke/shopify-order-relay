import type { ClaimResult, IdempotencyStore } from "./store.js";

interface Entry {
  state: "leased" | "done";
  expiresAt: number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}

  async claim(key: string, leaseMs: number): Promise<ClaimResult> {
    const e = this.entries.get(key);
    if (e && e.expiresAt > this.now()) return e.state === "done" ? "done" : "in_progress";
    this.entries.set(key, { state: "leased", expiresAt: this.now() + leaseMs });
    return "acquired";
  }
  async complete(key: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { state: "done", expiresAt: this.now() + ttlSeconds * 1000 });
  }
  async release(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (e?.state === "leased") this.entries.delete(key);
  }
}
