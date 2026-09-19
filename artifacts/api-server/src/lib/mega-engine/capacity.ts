/**
 * Runtime capacity controls shared by the three Mega Engine subsystems.
 *
 * The defaults preserve the existing behavior. Environment variables make
 * pressure limits explicit and prevent a single poll tick from claiming more
 * work than the process can safely drain.
 */
export interface EngineCapacity {
  eventBatchSize: number;
  schedulerBatchSize: number;
  eventMaxInFlight: number;
  schedulerMaxInFlight: number;
  retryStormWindowMs: number;
  retryStormLimit: number;
}

export function ratio(failures: number, total: number): number {
  return total > 0 ? Number((failures / total).toFixed(4)) : 0;
}

/**
 * Runs independent worker items with an explicit process-local concurrency
 * ceiling. Database leases remain the cross-process correctness boundary;
 * this helper only prevents one poll tick from overwhelming this process.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(limit)));
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  }));
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function getEngineCapacity(): EngineCapacity {
  const eventBatchSize = positiveInt("ENGINE_EVENT_BATCH_SIZE", 25);
  const schedulerBatchSize = positiveInt("ENGINE_SCHEDULER_BATCH_SIZE", 25);
  return {
    eventBatchSize,
    schedulerBatchSize,
    eventMaxInFlight: positiveInt("ENGINE_EVENT_MAX_IN_FLIGHT", eventBatchSize),
    schedulerMaxInFlight: positiveInt("ENGINE_SCHEDULER_MAX_IN_FLIGHT", schedulerBatchSize),
    retryStormWindowMs: positiveInt("ENGINE_RETRY_STORM_WINDOW_MS", 60_000),
    retryStormLimit: nonNegativeInt("ENGINE_RETRY_STORM_LIMIT", 100),
  };
}

/**
 * Small, deterministic retry-storm gate. It is intentionally process-local:
 * durable retry state remains in the database, while this gate only applies
 * backpressure to a hot worker loop.
 */
export class RetryStormGate {
  private windowStartedAt = 0;
  private retries = 0;

  constructor(private readonly windowMs: number, private readonly limit: number) {}

  allow(now = Date.now()): boolean {
    if (now - this.windowStartedAt >= this.windowMs) {
      this.windowStartedAt = now;
      this.retries = 0;
    }
    if (this.limit === 0 || this.retries >= this.limit) return false;
    this.retries++;
    return true;
  }

  snapshot(): { retries: number; limit: number; windowMs: number; throttled: boolean } {
    return {
      retries: this.retries,
      limit: this.limit,
      windowMs: this.windowMs,
      throttled: this.limit > 0 && this.retries >= this.limit,
    };
  }
}
