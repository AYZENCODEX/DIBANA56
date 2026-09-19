import { randomUUID } from "node:crypto";
import { cacheEngine, featureFlagEngine, rateLimitEngine, rulesEngine, subEngineAudit } from "../sub-engines";
import { getCurrentTraceContext, newTraceId } from "../trace-context";
import type {
  SioraDecision, SioraEngine, SioraEngineResult, SioraEngineTools, SioraEvaluation, SioraEvent, SioraSignal,
  SioraPolicyContext,
} from "./contracts";
import { newSioraEvent, sanitizeRecord } from "./contracts";
import { sioraOperations } from "./operations";

type EngineConfig = { enabled: boolean; timeoutMs: number; failClosed: boolean };

const severityRank: Record<SioraSignal["severity"], number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export class SioraRuntime {
  private readonly engines = new Map<string, SioraEngine>();
  private readonly configs = new Map<string, EngineConfig>();
  private readonly events: SioraEvent[] = [];
  private readonly signals: SioraSignal[] = [];
  private readonly evaluations: SioraEvaluation[] = [];

  register(engine: SioraEngine, config: Partial<EngineConfig> = {}): void {
    this.engines.set(engine.name, engine);
    this.configs.set(engine.name, {
      enabled: config.enabled ?? true,
      timeoutMs: config.timeoutMs ?? 250,
      failClosed: config.failClosed ?? false,
    });
  }

  configure(name: string, config: Partial<EngineConfig>): EngineConfig {
    const current = this.configs.get(name);
    if (!current) throw new Error(`Unknown SIORA engine: ${name}`);
    const next = { ...current, ...config };
    if (!Number.isInteger(next.timeoutMs) || next.timeoutMs < 1 || next.timeoutMs > 10_000) {
      throw new Error("SIORA timeoutMs must be an integer between 1 and 10000");
    }
    this.configs.set(name, next);
    subEngineAudit.record({ engine: "siora", action: "engine.configured", subjectId: name, metadata: next });
    return { ...next };
  }

  listEngines(): Array<{ name: string; priority: number } & EngineConfig> {
    return [...this.engines.values()]
      .sort((a, b) => a.priority - b.priority)
      .map((engine) => ({ name: engine.name, priority: engine.priority, ...this.configs.get(engine.name)! }));
  }

  async dispatch(input: Omit<SioraEvent, "id" | "occurredAt"> & { id?: string; occurredAt?: string }): Promise<SioraEvaluation> {
    const event = newSioraEvent({
      ...input,
      trace: input.trace ?? {
        traceId: getCurrentTraceContext()?.traceId ?? newTraceId(),
        correlationId: getCurrentTraceContext()?.correlationId,
      },
    });
    this.events.push(event);
    this.trim(this.events);

    const tools = this.tools();
    const results: SioraEngineResult[] = [];
    for (const engine of [...this.engines.values()].sort((a, b) => a.priority - b.priority)) {
      const config = this.configs.get(engine.name)!;
      if (!config.enabled || !this.isFeatureEnabled(engine.name, event)) continue;
      const started = tools.now();
      try {
        const result = await this.withTimeout(Promise.resolve(engine.evaluate(event, tools)), config.timeoutMs);
        const normalized = { ...result, engine: engine.name, durationMs: Math.max(result.durationMs, tools.now() - started) };
        results.push(normalized);
        this.signals.push(...normalized.signals);
        this.trim(this.signals);
      } catch (error) {
        const failure: SioraEngineResult = {
          engine: engine.name,
          signals: [{
            engine: engine.name,
            code: "ENGINE_FAILURE",
            severity: config.failClosed ? "high" : "low",
            confidence: "high",
            score: config.failClosed ? 80 : 10,
            reason: config.failClosed ? "Security engine failed closed" : "Security engine failed open",
            evidence: { error: error instanceof Error ? error.message : "unknown" },
            createdAt: new Date().toISOString(),
          }],
          decision: config.failClosed ? "restrict" : "monitor",
          durationMs: tools.now() - started,
          error: error instanceof Error ? error.message : "unknown",
          timedOut: error instanceof Error && error.message === "SIORA_ENGINE_TIMEOUT",
        };
        results.push(failure);
        this.signals.push(...failure.signals);
        this.trim(this.signals);
        subEngineAudit.record({ engine: "siora", action: "engine.failed", subjectId: engine.name, metadata: sanitizeRecord({ eventId: event.id, error: failure.error }) });
      }
    }

    const signals = results.flatMap((result) => result.signals);
    const decision = this.decisionFor(results, signals);
    const responseAction = sioraOperations.recommend(signals, decision, event.trace.traceId);
    const policyContext = this.toPolicyContext(signals, event.trace.traceId);
    const evaluation = {
      eventId: event.id,
      traceId: event.trace.traceId,
      decision,
      signals,
      results,
      responseActionId: responseAction?.id,
      policyContext,
      completedAt: new Date().toISOString(),
    };
    this.evaluations.push(evaluation);
    this.trim(this.evaluations);
    return evaluation;
  }

  recentEvents(limit = 50): SioraEvent[] { return this.events.slice(-Math.max(1, Math.min(limit, 500))).reverse(); }
  recentSignals(limit = 100): SioraSignal[] { return this.signals.slice(-Math.max(1, Math.min(limit, 500))).reverse(); }
  recentEvaluations(limit = 50): SioraEvaluation[] { return this.evaluations.slice(-Math.max(1, Math.min(limit, 500))).reverse(); }

  health(): { status: "ok"; engineCount: number; enabledEngineCount: number; recentEvaluationAt?: string } {
    return {
      status: "ok",
      engineCount: this.engines.size,
      enabledEngineCount: [...this.configs.values()].filter((config) => config.enabled).length,
      recentEvaluationAt: this.evaluations.at(-1)?.completedAt,
    };
  }

  private tools(): SioraEngineTools {
    return {
      now: () => Date.now(),
      scoreToSeverity: (score) => score >= 85 ? "critical" : score >= 65 ? "high" : score >= 40 ? "medium" : score >= 15 ? "low" : "info",
      confidenceFromSignals: (signals) => signals.some((signal) => signal.confidence === "high") ? "high" : signals.some((signal) => signal.confidence === "medium") ? "medium" : "low",
      emit: (signal) => ({ ...signal, evidence: signal.evidence ? sanitizeRecord(signal.evidence) : undefined, createdAt: new Date().toISOString() }),
      getRecentEvents: (filter, limit = 100) => this.events.filter(filter).slice(-limit).reverse(),
      getSignals: (filter, limit = 100) => this.signals.filter(filter).slice(-limit).reverse(),
      cacheKey: (namespace, key) => cacheEngine.key(namespace, key, {}, "siora-1"),
    };
  }

  private isFeatureEnabled(name: string, event: SioraEvent): boolean {
    const flag = featureFlagEngine.get(`siora.${name}.enabled`);
    return !flag || featureFlagEngine.evaluate(flag.key, { userId: event.context.actor?.userId, organizationId: event.context.actor?.organizationId });
  }

  private decisionFor(results: SioraEngineResult[], signals: SioraSignal[]): SioraDecision {
    if (results.some((result) => result.decision === "deny")) return "deny";
    if (results.some((result) => result.decision === "restrict")) return "restrict";
    if (results.some((result) => result.decision === "step_up")) return "step_up";
    if (signals.some((signal) => severityRank[signal.severity] >= severityRank.high)) return "monitor";
    return "allow";
  }

  private toPolicyContext(signals: SioraSignal[], traceId: string): SioraPolicyContext {
    const scoreFor = (engine: string) => Math.round(Math.min(100, signals
      .filter((signal) => signal.engine === engine)
      .reduce((max, signal) => Math.max(max, signal.score), 0)));
    const identityRisk = scoreFor("identity-trust");
    const policyContext: SioraPolicyContext = {
      threatScore: scoreFor("threat-intelligence"),
      identityTrust: Math.max(0, 100 - identityRisk),
      sessionRisk: scoreFor("session-security"),
      abuseScore: scoreFor("abuse-detection"),
      aggregateRisk: scoreFor("risk-anomaly"),
      confidence: signals.some((signal) => signal.confidence === "high") ? "high" : signals.some((signal) => signal.confidence === "medium") ? "medium" : "low",
      reasonCodes: [...new Set(signals.map((signal) => signal.code))].slice(0, 20),
      traceId,
    };
    return policyContext;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("SIORA_ENGINE_TIMEOUT")), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private trim<T>(items: T[]): void {
    if (items.length > 1000) items.splice(0, items.length - 1000);
  }
}

export const sioraRuntime = new SioraRuntime();

export function createSioraEvent(input: Omit<SioraEvent, "id" | "occurredAt">): Omit<SioraEvent, "id" | "occurredAt"> {
  return { ...input, id: randomUUID() } as Omit<SioraEvent, "id" | "occurredAt">;
}

// Keep these imports as explicit dependencies of the SIORA runtime. Existing
// sub-engines remain the source of truth for caching, rate limits, rules, and audit.
export const sioraDependencies = { cacheEngine, rateLimitEngine, rulesEngine };