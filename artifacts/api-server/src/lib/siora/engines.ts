import type { SioraEngine, SioraEngineResult, SioraEvent, SioraEngineTools, SioraSignal } from "./contracts";

function result(engine: string, started: number, signals: SioraSignal[], decision?: SioraEngineResult["decision"]): SioraEngineResult {
  return { engine, signals, decision, durationMs: Date.now() - started };
}

function signal(tools: SioraEngineTools, input: Omit<SioraSignal, "createdAt">): SioraSignal {
  return tools.emit(input);
}

export type ThreatIndicator = {
  value: string;
  type: "ip" | "domain" | "url" | "user_agent" | "identifier";
  severity: SioraSignal["severity"];
  confidence: SioraSignal["confidence"];
  expiresAt?: string;
  source: string;
  allowed?: boolean;
};

export class ThreatIntelligenceEngine implements SioraEngine {
  readonly name = "threat-intelligence";
  readonly priority = 10;
  private readonly indicators = new Map<string, ThreatIndicator>();

  upsert(indicator: ThreatIndicator): ThreatIndicator {
    if (!indicator.value || !indicator.source) throw new Error("Threat indicator value and source are required");
    this.indicators.set(`${indicator.type}:${indicator.value.toLowerCase()}`, { ...indicator });
    return { ...indicator };
  }
  list(): ThreatIndicator[] { return [...this.indicators.values()].map((item) => ({ ...item })); }

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const started = Date.now();
    const candidates = [
      ["ip", event.context.request?.ip],
      ["domain", event.context.request?.path?.split("/")[2]],
      ["url", event.context.request?.path],
      ["user_agent", event.context.request?.userAgent],
      ["identifier", event.context.actor?.userId == null ? undefined : String(event.context.actor.userId)],
    ] as const;
    const signals = candidates.flatMap(([type, value]) => {
      if (!value) return [];
      const item = this.indicators.get(`${type}:${value.toLowerCase()}`);
      if (!item || item.allowed || (item.expiresAt && new Date(item.expiresAt).getTime() <= Date.now())) return [];
      const score = item.severity === "critical" ? 95 : item.severity === "high" ? 80 : item.severity === "medium" ? 55 : 25;
      return [signal(tools, { engine: this.name, code: "KNOWN_INDICATOR_MATCH", severity: item.severity, confidence: item.confidence, score, reason: `Matched ${item.type} indicator from ${item.source}`, evidence: { type: item.type, source: item.source, value: "[REDACTED]" } })];
    });
    return result(this.name, started, signals, signals.some((item) => item.severity === "critical" || item.severity === "high") ? "restrict" : undefined);
  }
}

export class IdentityTrustEngine implements SioraEngine {
  readonly name = "identity-trust";
  readonly priority = 20;

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const started = Date.now();
    const actor = event.context.actor;
    if (!actor?.userId) return result(this.name, started, [signal(tools, { engine: this.name, code: "IDENTITY_MISSING", severity: "medium", confidence: "high", score: 50, reason: "No authenticated actor was available" })], "step_up");
    let trust = 45;
    const reasons: string[] = [];
    if (actor.verified) { trust += 20; reasons.push("verified account"); }
    if (actor.authType === "oidc" || actor.authType === "session") { trust += 15; reasons.push("recognized authentication context"); }
    if ((actor.accountAgeDays ?? 0) >= 30) { trust += 10; reasons.push("established account"); }
    if (actor.role === "admin" || actor.role === "dev") { trust += 5; reasons.push("privileged role requires continued monitoring"); }
    const score = Math.max(0, Math.min(100, trust));
    const severity = score < 35 ? "high" : score < 55 ? "medium" : "info";
    const signals = [signal(tools, { engine: this.name, code: score < 55 ? "LOW_IDENTITY_TRUST" : "IDENTITY_TRUST_ASSESSED", severity, confidence: actor.verified === undefined ? "medium" : "high", score: 100 - score, reason: reasons.length ? reasons.join(", ") : "Insufficient identity trust signals", evidence: { trustScore: score } })];
    return result(this.name, started, signals, score < 35 ? "step_up" : undefined);
  }
}

export class SessionSecurityEngine implements SioraEngine {
  readonly name = "session-security";
  readonly priority = 30;

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const started = Date.now();
    const session = event.context.session;
    if (!session) return result(this.name, started, []);
    const signals: SioraSignal[] = [];
    const request = event.context.request;
    if (session.expiresAt && new Date(session.expiresAt).getTime() <= Date.now()) {
      signals.push(signal(tools, { engine: this.name, code: "STALE_SESSION", severity: "high", confidence: "high", score: 85, reason: "Session is expired", evidence: { sessionId: session.id ?? "[unknown]" } }));
    }
    if (session.previousIp && request?.ip && session.previousIp !== request.ip) {
      signals.push(signal(tools, { engine: this.name, code: "SESSION_IP_CHANGE", severity: "medium", confidence: "medium", score: 55, reason: "Session request IP changed", evidence: { previousIp: "[REDACTED]", currentIp: "[REDACTED]" } }));
    }
    if (session.previousDeviceId && request?.deviceId && session.previousDeviceId !== request.deviceId) {
      signals.push(signal(tools, { engine: this.name, code: "SESSION_DEVICE_CHANGE", severity: "medium", confidence: "medium", score: 60, reason: "Session device changed", evidence: { sessionId: session.id ?? "[unknown]" } }));
    }
    const prior = tools.getRecentEvents((candidate) => candidate.context.actor?.userId === event.context.actor?.userId && candidate.context.session?.id === session.id, 20);
    if (prior.length >= 10) signals.push(signal(tools, { engine: this.name, code: "RAPID_SESSION_ACTIVITY", severity: "medium", confidence: "medium", score: 50, reason: "Session generated many recent events", evidence: { recentEvents: prior.length } }));
    return result(this.name, started, signals, signals.some((item) => item.severity === "high") ? "step_up" : undefined);
  }
}

export class AbuseDetectionEngine implements SioraEngine {
  readonly name = "abuse-detection";
  readonly priority = 40;

  evaluate(event: SioraEvent, tools: SioraEngineTools): SioraEngineResult {
    const started = Date.now();
    const actorId = event.context.actor?.userId;
    const requestKey = actorId ? `user:${actorId}` : `ip:${event.context.request?.ip ?? "unknown"}`;
    const recent = tools.getRecentEvents((candidate) => {
      const candidateKey = candidate.context.actor?.userId ? `user:${candidate.context.actor.userId}` : `ip:${candidate.context.request?.ip ?? "unknown"}`;
      return candidateKey === requestKey && Date.now() - new Date(candidate.occurredAt).getTime() <= 60_000;
    }, 100);
    const signals: SioraSignal[] = [];
    if (recent.length >= 20) {
      signals.push(signal(tools, { engine: this.name, code: "REQUEST_BURST", severity: "high", confidence: "high", score: 80, reason: "Request velocity exceeded the abuse threshold", evidence: { windowMs: 60_000, count: recent.length, subject: actorId ? "user" : "ip" } }));
    } else if (recent.length >= 8) {
      signals.push(signal(tools, { engine: this.name, code: "HIGH_REQUEST_VELOCITY", severity: "medium", confidence: "medium", score: 45, reason: "Request velocity is unusually high", evidence: { windowMs: 60_000, count: recent.length, subject: actorId ? "user" : "ip" } }));
    }
    const sameAction = recent.filter((candidate) => candidate.name === event.name);
    if (sameAction.length >= 5) {
      signals.push(signal(tools, { engine: this.name, code: "REPEATED_ACTION", severity: "medium", confidence: "high", score: 55, reason: "The same action was repeated rapidly", evidence: { action: event.name, count: sameAction.length } }));
    }
    const automation = event.data.automation === true || /bot|headless|scrapy/i.test(event.context.request?.userAgent ?? "");
    if (automation) signals.push(signal(tools, { engine: this.name, code: "AUTOMATION_INDICATOR", severity: "medium", confidence: "medium", score: 50, reason: "Request contains an automation indicator", evidence: { action: event.name } }));
    return result(this.name, started, signals, signals.some((item) => item.severity === "high") ? "restrict" : undefined);
  }
}