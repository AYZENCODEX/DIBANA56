import type { SioraEngine, SioraEngineResult, SioraEvent, SioraEngineTools, SioraSignal, SioraSeverity, SioraConfidence } from "./contracts";
import { dataSecuritySignal, classifyField } from "./data-security";
import type { ThreatIndicator } from "./engines";

function makeResult(engine: string, start: number, signals: SioraSignal[], decision?: SioraEngineResult["decision"]): SioraEngineResult {
  return { engine, signals, decision, durationMs: Date.now() - start };
}

function emit(tools: SioraEngineTools, input: Omit<SioraSignal, "createdAt">): SioraSignal {
  return tools.emit(input);
}

export class RiskAnomalyEngine implements SioraEngine {
  readonly name = "risk-anomaly";
  readonly priority = 50;

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const start = Date.now();
    const inputs = tools.getSignals((item) => item.createdAt >= event.occurredAt, 25);
    const total = Math.min(100, inputs.reduce((sum, item) => sum + item.score * (item.confidence === "high" ? 1 : item.confidence === "medium" ? 0.75 : 0.5), 0) / Math.max(1, inputs.length));
    const reasons = inputs.map((item) => item.code).slice(0, 8);
    const signals = inputs.length ? [emit(tools, {
      engine: this.name,
      code: "AGGREGATE_RISK_ASSESSED",
      severity: tools.scoreToSeverity(total),
      confidence: tools.confidenceFromSignals(inputs),
      score: Math.round(total),
      reason: reasons.length ? `Aggregate risk from ${reasons.join(", ")}` : "No elevated signals",
      evidence: { signalCount: inputs.length, reasonCodes: reasons, score: Math.round(total) },
    })] : [];
    return makeResult(this.name, start, signals, total >= 80 ? "restrict" : total >= 60 ? "step_up" : undefined);
  }
}

export class DataSecurityEngine implements SioraEngine {
  readonly name = "data-security";
  readonly priority = 60;

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const start = Date.now();
    const found = dataSecuritySignal(event.context, event.data, tools.emit);
    return makeResult(this.name, start, found ? [found] : []);
  }
}

export class SecretsSecurityEngine implements SioraEngine {
  readonly name = "secrets-security";
  readonly priority = 70;
  private readonly registry = new Map<string, { id: string; type: string; owner: string; purpose: string; expiresAt?: string; rotationState: "current" | "due" | "expired" | "revoked"; createdAt: string; revokedAt?: string }>();

  register(input: { id: string; type: string; owner: string; purpose: string; expiresAt?: string; rotationState?: "current" | "due" | "expired" | "revoked" }): Omit<ThreatIndicator, "value"> & { id: string; type: string; owner: string; purpose: string; expiresAt?: string; rotationState: string; createdAt: string } {
    const item = { ...input, rotationState: input.rotationState ?? "current", createdAt: new Date().toISOString() };
    this.registry.set(input.id, item);
    return { ...item } as Omit<ThreatIndicator, "value"> & { id: string; type: string; owner: string; purpose: string; expiresAt?: string; rotationState: string; createdAt: string };
  }
  list(): unknown[] { return [...this.registry.values()].map((item) => ({ ...item })); }

  evaluate(_event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const start = Date.now();
    const due = [...this.registry.values()].filter((item) => item.rotationState !== "revoked" && item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now() + 7 * 24 * 60 * 60 * 1000);
    const signals = due.map((item) => emit(tools, {
      engine: this.name,
      code: new Date(item.expiresAt!).getTime() <= Date.now() ? "SECRET_EXPIRED" : "SECRET_ROTATION_DUE",
      severity: new Date(item.expiresAt!).getTime() <= Date.now() ? "high" : "medium",
      confidence: "high",
      score: new Date(item.expiresAt!).getTime() <= Date.now() ? 85 : 55,
      reason: `Secret lifecycle requires attention: ${item.id}`,
      evidence: { secretId: item.id, owner: item.owner, purpose: item.purpose },
    }));
    return makeResult(this.name, start, signals, signals.some((item) => item.severity === "high") ? "restrict" : undefined);
  }
}

type EndpointDefinition = { pattern: string; sensitivity: "low" | "medium" | "high" | "critical"; write: boolean; abuseCost: number; authRequired: boolean };

export class ApiDefenseEngine implements SioraEngine {
  readonly name = "api-defense";
  readonly priority = 80;
  private readonly endpoints = new Map<string, EndpointDefinition>();

  registerEndpoint(path: string, definition: Omit<EndpointDefinition, "pattern">): EndpointDefinition {
    const item = { pattern: path, ...definition };
    this.endpoints.set(path, item);
    return { ...item };
  }
  listEndpoints(): EndpointDefinition[] { return [...this.endpoints.values()].map((item) => ({ ...item })); }

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const start = Date.now();
    const path = event.context.request?.path ?? "";
    const definition = [...this.endpoints.values()].find((item) => path === item.pattern || (item.pattern.endsWith("*") && path.startsWith(item.pattern.slice(0, -1))));
    if (!definition) return makeResult(this.name, start, []);
    const unauthenticated = definition.authRequired && !event.context.actor?.userId;
    const recent = tools.getRecentEvents((candidate) => candidate.context.request?.path === path && candidate.context.request?.ip === event.context.request?.ip, 50);
    const burst = recent.length >= Math.max(5, 20 - definition.abuseCost);
    const signals: SioraSignal[] = [];
    if (unauthenticated) signals.push(emit(tools, { engine: this.name, code: "SENSITIVE_ENDPOINT_UNAUTHENTICATED", severity: "high", confidence: "high", score: 85, reason: "Sensitive endpoint was called without an authenticated actor", evidence: { endpoint: path } }));
    if (burst) signals.push(emit(tools, { engine: this.name, code: "ENDPOINT_BURST", severity: definition.sensitivity === "critical" ? "high" : "medium", confidence: "medium", score: definition.abuseCost + 35, reason: "Endpoint request velocity exceeded its configured cost", evidence: { endpoint: path, requests: recent.length } }));
    return makeResult(this.name, start, signals, signals.some((item) => item.severity === "high") ? "restrict" : undefined);
  }
}