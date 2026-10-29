export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export interface BackoffOptions {
  baseMs: number;
  capMs: number;
  /** Returns a value in [0,1). Injectable for deterministic tests. */
  random?: () => number;
}

/** "Full jitter" exponential backoff: random in [0, min(cap, base * 2^attempt)). */
export function backoffMs(attempt: number, { baseMs, capMs, random = Math.random }: BackoffOptions): number {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}
