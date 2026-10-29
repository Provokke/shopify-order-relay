export type TraceKind = "accepted" | "rejected" | "deduped" | "retry" | "dlq" | "downstream" | "delivered" | "processed" | "info";

export interface TraceEntry {
  seq: number;
  /** Milliseconds since the demo server started. */
  atMs: number;
  kind: TraceKind;
  text: string;
}

/** Ordered, readable record of what the demo did. Optionally echoed live to a sink. */
export class Trace {
  readonly entries: TraceEntry[] = [];
  private readonly startedAt = Date.now();
  constructor(private readonly sink?: (line: string) => void) {}

  emit(kind: TraceKind, text: string): void {
    const entry: TraceEntry = { seq: this.entries.length, atMs: Date.now() - this.startedAt, kind, text };
    this.entries.push(entry);
    this.sink?.(formatTraceEntry(entry));
  }
}

export function formatTraceEntry(e: TraceEntry): string {
  const t = `+${(e.atMs / 1000).toFixed(3)}s`.padStart(9);
  return `${t}  ${e.kind.toUpperCase().padEnd(10)} ${e.text}`;
}
