import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { HttpDestination } from "../destination/http.js";
import { MemoryIdempotencyStore } from "../idempotency/memory.js";
import { createIngestHandler } from "../ingest/handler.js";
import type { Logger } from "../logger.js";
import { backoffMs } from "../retry.js";
import { createWorkerHandler } from "../worker/handler.js";
import { MockDownstream, type DownstreamMode } from "./downstream.js";
import { DemoQueue } from "./memory-sqs.js";
import { Trace } from "./trace.js";

export interface DemoOptions {
  /** Shopify app client secret used to verify signatures. Defaults to a non-secret demo value. */
  secret?: string;
  port?: number;
  host?: string;
  /** Live trace echo; leave undefined to stay silent (tests, scripted runs). */
  sink?: (line: string) => void;
  /** Timeout for the relay's call to the downstream, so an injected hang shows up quickly. */
  downstreamTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  maxReceiveCount?: number;
}

export interface DemoServer {
  server: Server;
  url: string;
  trace: Trace;
  queue: DemoQueue;
  downstream: MockDownstream;
  close(): Promise<void>;
}

export const DEFAULT_DEMO_SECRET = "demo-shopify-client-secret";
export const WEBHOOK_PATH = "/webhooks/shopify";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Wires the real ingest and worker handlers to in-memory stand-ins for SQS and DynamoDB, and to a
 * mock downstream, behind one local HTTP server. No AWS, no network beyond localhost.
 *
 *   POST /webhooks/shopify    the ingest function (point Shopify or curl here)
 *   POST /downstream          the mock ERP/WMS the worker delivers to
 *   POST /control/downstream  {"mode":"ok|500|timeout","times":n} make the downstream misbehave
 *   GET  /trace?since=n       trace entries from sequence n
 *   GET  /state               downstream and queue counters
 *   GET  /idle                resolves when nothing is queued or being retried
 */
export async function startDemoServer(opts: DemoOptions = {}): Promise<DemoServer> {
  const secret = opts.secret ?? DEFAULT_DEMO_SECRET;
  const trace = new Trace(opts.sink);
  const downstream = new MockDownstream(trace);
  const store = new MemoryIdempotencyStore();
  let baseUrl = "";

  const workerLogger: Logger = {
    info(msg, f) {
      if (msg === "message processed") trace.emit("processed", `wh=${String(f?.webhookId)} order relayed (${String(f?.outcome)})`);
      else if (msg === "already processed, skipping") trace.emit("info", `wh=${String(f?.webhookId)} worker: already processed, skipped`);
    },
    warn() {},
    error(msg, f) {
      if (msg === "processing failed") trace.emit("info", `wh=${String(f?.webhookId)} worker error: ${String(f?.error)}`);
    },
  };

  // The destination URL needs the bound port, so the worker is built after listen().
  const makeWorker = () =>
    createWorkerHandler({
      store,
      logger: workerLogger,
      destination: new HttpDestination(`${baseUrl}/downstream`, "demo-token", fetch, opts.downstreamTimeoutMs ?? 1000),
    });

  const ready: { worker?: ReturnType<typeof makeWorker> } = {};
  const queue = new DemoQueue({
    handler: (event) => {
      if (!ready.worker) throw new Error("demo server not ready");
      return ready.worker(event);
    },
    // Full jitter can pick ~0ms, which hides the backoff. Keep the jitter but floor it at half.
    backoffMs: (attempt) =>
      backoffMs(attempt - 1, {
        baseMs: opts.backoffBaseMs ?? 400,
        capMs: opts.backoffCapMs ?? 5000,
        random: () => 0.5 + Math.random() * 0.5,
      }),
    maxReceiveCount: opts.maxReceiveCount ?? 4,
    trace,
  });

  const ingestFor = (logger: Logger) => createIngestHandler({ secret, store, queue, logger });

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const id = String(req.headers["x-shopify-webhook-id"] ?? "(none)");
    const topic = String(req.headers["x-shopify-topic"] ?? "(none)");
    let deduped = false;
    const logger: Logger = {
      info(msg) {
        if (msg === "duplicate delivery ignored") deduped = true;
      },
      warn() {},
      error() {},
    };
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;
    const result = await ingestFor(logger)({ body, headers, isBase64Encoded: false } as unknown as APIGatewayProxyEventV2);
    const status = typeof result === "string" ? 200 : (result.statusCode ?? 200);
    if (status === 401) trace.emit("rejected", `wh=${id} ${topic} -> 401 signature does not match the body, not queued`);
    else if (status === 200 && deduped) trace.emit("deduped", `wh=${id} ${topic} -> 200 duplicate delivery id, acknowledged but not queued again`);
    else if (status === 200) trace.emit("accepted", `wh=${id} ${topic} -> 200 signature valid, queued for the worker`);
    else trace.emit("rejected", `wh=${id} ${topic} -> ${status}`);
    res.writeHead(status).end();
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        if (req.method === "POST" && url.pathname === WEBHOOK_PATH) return await handleWebhook(req, res);
        if (req.method === "POST" && url.pathname === "/downstream") return downstream.handle(req, res);
        if (req.method === "POST" && url.pathname === "/control/downstream") {
          const cfg = JSON.parse((await readBody(req)) || "{}") as { mode?: DownstreamMode; times?: number };
          if (cfg.mode !== "ok" && cfg.mode !== "500" && cfg.mode !== "timeout") return sendJson(res, 400, { error: "mode must be ok, 500 or timeout" });
          downstream.setMode(cfg.mode, cfg.times);
          trace.emit("info", `downstream set to ${cfg.mode}${cfg.mode !== "ok" && cfg.times ? ` for the next ${cfg.times} request(s)` : ""}`);
          return sendJson(res, 200, downstream.state());
        }
        if (req.method === "GET" && url.pathname === "/trace") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return sendJson(res, 200, trace.entries.slice(since));
        }
        if (req.method === "GET" && url.pathname === "/state") {
          return sendJson(res, 200, { downstream: downstream.state(), queueDepth: queue.depth, deadLetters: queue.dlq.length });
        }
        if (req.method === "GET" && url.pathname === "/idle") {
          await queue.idle();
          return sendJson(res, 200, { idle: true });
        }
        sendJson(res, 404, { error: "not found" });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  ready.worker = makeWorker();

  return {
    server,
    url: baseUrl,
    trace,
    queue,
    downstream,
    close: () =>
      new Promise<void>((resolve) => {
        queue.close();
        downstream.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
