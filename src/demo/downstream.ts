import type { IncomingMessage, ServerResponse } from "node:http";
import type { Trace } from "./trace.js";

export type DownstreamMode = "ok" | "500" | "timeout";

export interface DownstreamState {
  mode: DownstreamMode;
  /** How many more requests misbehave before going back to "ok". null means until changed. */
  remaining: number | null;
  attempts: number;
  /** Unique deliveries by Idempotency-Key. */
  delivered: string[];
  /** Requests with an Idempotency-Key we'd already delivered. */
  duplicates: number;
}

/** Mock ERP/WMS. Can be told to 500 or hang so retries show up, and dedupes on Idempotency-Key. */
export class MockDownstream {
  mode: DownstreamMode = "ok";
  remaining: number | null = null;
  attempts = 0;
  duplicates = 0;
  private readonly delivered = new Set<string>();
  private readonly hung = new Set<ServerResponse>();

  constructor(private readonly trace: Trace) {}

  setMode(mode: DownstreamMode, times?: number): void {
    this.mode = mode;
    this.remaining = mode === "ok" ? null : (times ?? null);
  }

  state(): DownstreamState {
    return {
      mode: this.mode,
      remaining: this.remaining,
      attempts: this.attempts,
      delivered: [...this.delivered],
      duplicates: this.duplicates,
    };
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    this.attempts++;
    const key = String(req.headers["idempotency-key"] ?? "(none)");
    req.resume();
    if (this.mode !== "ok") {
      const mode = this.mode;
      if (this.remaining !== null && --this.remaining <= 0) this.setMode("ok");
      if (mode === "500") {
        this.trace.emit("downstream", `attempt #${this.attempts} key=${key} -> 500 (injected failure)`);
        res.writeHead(500).end("injected failure");
      } else {
        this.trace.emit("downstream", `attempt #${this.attempts} key=${key} -> no response (injected timeout)`);
        this.hung.add(res);
        res.on("close", () => this.hung.delete(res));
      }
      return;
    }
    if (this.delivered.has(key)) {
      this.duplicates++;
      this.trace.emit("downstream", `attempt #${this.attempts} key=${key} -> 200 (key already delivered, ignored)`);
    } else {
      this.delivered.add(key);
      this.trace.emit("delivered", `attempt #${this.attempts} key=${key} -> 200, stored`);
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  }

  close(): void {
    for (const r of this.hung) r.destroy();
    this.hung.clear();
  }
}
