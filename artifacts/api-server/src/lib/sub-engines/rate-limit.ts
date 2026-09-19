import { AuditSink, EngineError, Scope, nowMs } from "./common";

export type RateLimitRule = { key: string; limit: number; windowMs: number; burst?: number; scopes: Array<"user" | "organization" | "ip" | "endpoint" | "model"> };
export type RateLimitContext = Scope & { ip?: string; endpoint?: string; model?: string; exempt?: boolean };
type Bucket = { startedAt: number; count: number };

export class RateLimitEngine {
  private readonly rules = new Map<string, RateLimitRule>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly overrides = new Map<string, RateLimitRule>();

  constructor(private readonly audit: AuditSink) {}

  upsert(rule: RateLimitRule, actorUserId?: number | null): void {
    if (rule.limit <= 0 || rule.windowMs <= 0 || rule.scopes.length === 0) throw new EngineError("Invalid rate-limit rule", "RATE_RULE_INVALID");
    this.rules.set(rule.key, { ...rule });
    this.audit.record({ engine: "rate-limit", action: "rate_rule.updated", actorUserId, subjectId: rule.key, metadata: { limit: rule.limit, windowMs: rule.windowMs } });
  }

  override(scopeValue: string, rule: RateLimitRule, actorUserId?: number | null): void {
    this.overrides.set(scopeValue, { ...rule });
    this.audit.record({ engine: "rate-limit", action: "rate_override.updated", actorUserId, subjectId: scopeValue, metadata: { rule: rule.key } });
  }

  check(ruleKey: string, context: RateLimitContext): { allowed: boolean; remaining: number; retryAfterMs: number; limit: number } {
    const rule = this.rules.get(ruleKey);
    if (!rule) throw new EngineError(`Unknown rate-limit rule: ${ruleKey}`, "RATE_RULE_NOT_FOUND", 404);
    if (context.exempt) return { allowed: true, remaining: rule.limit, retryAfterMs: 0, limit: rule.limit };
    const results = rule.scopes.map((scope) => this.checkScope(this.overrides.get(this.scopeValue(scope, context)) ?? rule, scope, context));
    const decision = results.sort((a, b) => a.remaining - b.remaining)[0]!;
    if (!decision.allowed) this.audit.record({ engine: "rate-limit", action: "rate_limit.denied", organizationId: context.organizationId, subjectId: ruleKey, metadata: { retryAfterMs: decision.retryAfterMs, scopes: rule.scopes } });
    return decision;
  }

  private checkScope(rule: RateLimitRule, scope: RateLimitRule["scopes"][number], context: RateLimitContext) {
    const value = this.scopeValue(scope, context);
    const key = `${rule.key}:${scope}:${value}`;
    const now = nowMs();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.startedAt >= rule.windowMs) { this.buckets.set(key, { startedAt: now, count: 1 }); return { allowed: true, remaining: Math.max(0, rule.limit - 1), retryAfterMs: 0, limit: rule.limit }; }
    const ceiling = rule.limit + (rule.burst ?? 0);
    const allowed = bucket.count < ceiling;
    if (allowed) bucket.count += 1;
    return { allowed, remaining: Math.max(0, ceiling - bucket.count), retryAfterMs: allowed ? 0 : rule.windowMs - (now - bucket.startedAt), limit: ceiling };
  }

  private scopeValue(scope: RateLimitRule["scopes"][number], context: RateLimitContext): string {
    const value = scope === "user" ? context.userId : scope === "organization" ? context.organizationId : scope === "ip" ? context.ip : scope === "endpoint" ? context.endpoint : context.model;
    if (value == null || value === "") throw new EngineError(`${scope} is required for this rate-limit check`, "RATE_SCOPE_MISSING", 400);
    return String(value);
  }
}