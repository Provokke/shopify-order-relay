import { backoffMs, realSleep, type Sleep } from "../retry.js";
import { PermanentError, TransientError } from "../types.js";
import type { Logger } from "../logger.js";
import { silentLogger } from "../logger.js";

export interface ThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

interface GraphQLErrorShape {
  message: string;
  extensions?: { code?: string };
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorShape[];
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number | null; throttleStatus: ThrottleStatus } };
}

export interface GraphQLClientOptions {
  shopDomain: string;
  accessToken: string;
  apiVersion: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
  maxAttempts?: number;
  logger?: Logger;
}

/**
 * Minimal Admin GraphQL client that cooperates with the calculated-cost leaky bucket.
 *
 *  - Tracks throttleStatus from every response and waits before sending a query whose
 *    estimated cost exceeds the estimated bucket level (proactive).
 *  - On a THROTTLED error, waits for the bucket to refill by the deficit (reactive).
 *  - On HTTP 429 honours Retry-After; on 5xx/network errors uses full-jitter exponential backoff.
 *  - A 200 response can still carry errors: THROTTLED is retried, anything else is permanent.
 */
export class ShopifyGraphQLClient {
  private bucket: { status: ThrottleStatus; at: number } | undefined;
  private fetchFn: typeof fetch;
  private sleep: Sleep;
  private now: () => number;
  private random: () => number;
  private maxAttempts: number;
  private log: Logger;

  constructor(private opts: GraphQLClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.log = opts.logger ?? silentLogger;
  }

  /** Estimated points currently available, extrapolating the refill since the last response. */
  private estimatedAvailable(): number | undefined {
    if (!this.bucket) return undefined;
    const { status, at } = this.bucket;
    const refilled = ((this.now() - at) / 1000) * status.restoreRate;
    return Math.min(status.maximumAvailable, status.currentlyAvailable + refilled);
  }

  private waitForPoints(needed: number): number {
    const available = this.estimatedAvailable();
    if (available === undefined || !this.bucket || available >= needed) return 0;
    return Math.ceil(((needed - available) / this.bucket.status.restoreRate) * 1000);
  }

  /**
   * @param estimatedCost expected query cost in points; used for proactive pacing (default 50).
   */
  async request<T>(query: string, variables: Record<string, unknown> = {}, estimatedCost = 50): Promise<T> {
    const url = `https://${this.opts.shopDomain}/admin/api/${this.opts.apiVersion}/graphql.json`;
    let lastError: unknown;

    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const proactive = this.waitForPoints(estimatedCost);
      if (proactive > 0) await this.sleep(proactive);

      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-shopify-access-token": this.opts.accessToken },
          body: JSON.stringify({ query, variables }),
        });
      } catch (err) {
        lastError = err;
        await this.sleep(backoffMs(attempt, { baseMs: 500, capMs: 10_000, random: this.random }));
        continue;
      }

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000;
        this.log.warn("shopify http 429", { attempt, waitMs: wait });
        lastError = new TransientError("HTTP 429 from Shopify");
        await this.sleep(wait);
        continue;
      }
      if (res.status >= 500) {
        lastError = new TransientError(`HTTP ${res.status} from Shopify`);
        await this.sleep(backoffMs(attempt, { baseMs: 500, capMs: 10_000, random: this.random }));
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) {
        throw new PermanentError(`HTTP ${res.status} from Shopify (check token, scopes and shop domain)`);
      }
      if (!res.ok) throw new PermanentError(`HTTP ${res.status} from Shopify`);

      const json = (await res.json()) as GraphQLResponse<T>;
      const cost = json.extensions?.cost;
      if (cost) this.bucket = { status: cost.throttleStatus, at: this.now() };

      if (json.errors?.length) {
        if (json.errors.some((e) => e.extensions?.code === "THROTTLED")) {
          const needed = cost ? Math.max(cost.requestedQueryCost, estimatedCost) : estimatedCost;
          const wait = Math.max(this.waitForPoints(needed), 1000);
          this.log.warn("graphql THROTTLED", { attempt, waitMs: wait });
          lastError = new TransientError("GraphQL THROTTLED");
          await this.sleep(wait);
          continue;
        }
        throw new PermanentError(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
      }
      if (json.data === undefined) throw new PermanentError("GraphQL response had neither data nor errors");
      return json.data;
    }
    throw new TransientError(`Shopify request failed after ${this.maxAttempts} attempts: ${String(lastError)}`);
  }
}
