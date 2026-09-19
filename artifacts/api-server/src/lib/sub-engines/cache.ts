import { AuditSink, EngineError, Scope, nowMs, scopeKey, clone } from "./common";

type Entry = { value: unknown; expiresAt: number; negative: boolean; version: string };

export class CacheEngine {
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;

  constructor(private readonly audit: AuditSink) {}

  key(namespace: string, key: string, scope: Scope = {}, version = "1"): string {
    if (!namespace || !key) throw new EngineError("Cache namespace and key are required", "CACHE_KEY_INVALID");
    return `${namespace}:v${version}:${scopeKey(scope)}:${key}`;
  }

  set<T>(cacheKey: string, value: T, ttlMs: number, options: { negative?: boolean; version?: string } = {}): void {
    if (ttlMs <= 0) throw new EngineError("Cache TTL must be positive", "CACHE_TTL_INVALID");
    this.entries.set(cacheKey, { value: clone(value), expiresAt: nowMs() + ttlMs, negative: options.negative ?? false, version: options.version ?? "1" });
  }

  get<T>(cacheKey: string): T | undefined {
    const entry = this.entries.get(cacheKey);
    if (!entry || entry.expiresAt <= nowMs()) { this.entries.delete(cacheKey); this.misses++; return undefined; }
    this.hits++;
    return clone(entry.value) as T;
  }

  async getOrSet<T>(cacheKey: string, loader: () => Promise<T>, ttlMs: number, options: { negative?: boolean; version?: string } = {}): Promise<T> {
    const existing = this.get<T>(cacheKey);
    if (existing !== undefined) return existing;
    const running = this.inflight.get(cacheKey);
    if (running) return running as Promise<T>;
    const promise = loader().then((value) => { this.set(cacheKey, value, ttlMs, options); return value; }).finally(() => this.inflight.delete(cacheKey));
    this.inflight.set(cacheKey, promise);
    return promise;
  }

  invalidate(prefix: string, actorUserId?: number | null): number {
    let removed = 0;
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) { this.entries.delete(key); removed++; }
    this.audit.record({ engine: "cache", action: "cache.invalidated", actorUserId, subjectId: prefix, metadata: { removed } });
    return removed;
  }

  stats(): { entries: number; hits: number; misses: number } { return { entries: this.entries.size, hits: this.hits, misses: this.misses }; }
}