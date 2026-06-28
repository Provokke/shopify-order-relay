import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { MessageQueue } from "../queue/queue.js";
import type { RelayMessage } from "../types.js";
import type { Trace } from "./trace.js";

export interface DemoQueueOptions {
  /** The real worker handler. */
  handler: (event: SQSEvent) => Promise<SQSBatchResponse>;
  /** Delay before a failed message shows up again. attempt is the receive count so far. */
  backoffMs: (attempt: number) => number;
  /** Receives before a message goes to the dead-letter queue (like maxReceiveCount). */
  maxReceiveCount?: number;
  trace: Trace;
}

interface Item {
  messageId: string;
  msg: RelayMessage;
  receiveCount: number;
  visibleAt: number;
}

/**
 * In-memory stand-in for SQS plus the Lambda event source mapping: retry delay, receive counts,
 * a DLQ and partial batch responses. Batch size is 1 to keep the trace readable.
 * Doesn't model SQS ordering or at-least-once races.
 */
export class DemoQueue implements MessageQueue {
  readonly dlq: RelayMessage[] = [];
  /** When true, send() throws like SQS being down. */
  failSends = false;
  private items: Item[] = [];
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private idleWaiters: (() => void)[] = [];
  private nextId = 1;
  private readonly maxReceiveCount: number;

  constructor(private readonly opts: DemoQueueOptions) {
    this.maxReceiveCount = opts.maxReceiveCount ?? 4;
  }

  async send(msg: RelayMessage): Promise<void> {
    if (this.failSends) throw new Error("queue unavailable");
    this.items.push({ messageId: `msg-${this.nextId++}`, msg, receiveCount: 0, visibleAt: Date.now() });
    this.schedule();
  }

  get depth(): number {
    return this.items.length;
  }

  /** Resolves once nothing is queued, waiting to retry, or being processed. */
  idle(): Promise<void> {
    if (this.items.length === 0 && !this.running) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.items.length === 0) {
      for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    const next = Math.min(...this.items.map((i) => i.visibleAt));
    this.timer = setTimeout(() => void this.drain(), Math.max(0, next - Date.now()));
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      const due = this.items.filter((i) => i.visibleAt <= Date.now());
      for (const item of due) await this.deliver(item);
    } finally {
      this.running = false;
      this.schedule();
    }
  }

  private async deliver(item: Item): Promise<void> {
    item.receiveCount++;
    let failed = true;
    try {
      const res = await this.opts.handler({
        Records: [{ messageId: item.messageId, body: JSON.stringify(item.msg) }],
      } as unknown as SQSEvent);
      failed = res.batchItemFailures.some((f) => f.itemIdentifier === item.messageId);
    } catch {
      failed = true;
    }
    const wh = item.msg.webhookId;
    if (!failed) {
      this.items = this.items.filter((i) => i !== item);
      return;
    }
    if (item.receiveCount >= this.maxReceiveCount) {
      this.items = this.items.filter((i) => i !== item);
      this.dlq.push(item.msg);
      this.opts.trace.emit("dlq", `wh=${wh} gave up after ${item.receiveCount} receives, moved to the dead-letter queue`);
      return;
    }
    const delay = this.opts.backoffMs(item.receiveCount);
    item.visibleAt = Date.now() + delay;
    this.opts.trace.emit(
      "retry",
      `wh=${wh} failed attempt ${item.receiveCount}/${this.maxReceiveCount}, back on the queue, visible again in ${delay}ms`,
    );
  }
}
