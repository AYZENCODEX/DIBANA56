import { AuditSink, EngineError, Scope, clone } from "./common";

export type RuleValue = string | number | boolean | null;
export type Condition =
  | { op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"; field: string; value: RuleValue }
  | { op: "in"; field: string; value: RuleValue[] }
  | { op: "exists"; field: string; value: boolean }
  | { op: "all" | "any"; conditions: Condition[] }
  | { op: "not"; condition: Condition };
export type Rule = { id: string; version: number; priority: number; condition: Condition; result: Record<string, unknown>; organizationId?: number | null; activeFrom?: Date; activeUntil?: Date; enabled: boolean };
export type RuleContext = Scope & Record<string, unknown>;

export class RulesEngine {
  private readonly rules = new Map<string, Rule[]>();

  constructor(private readonly audit: AuditSink) {}

  publish(rule: Omit<Rule, "version">, actorUserId?: number | null): Rule {
    if (!rule.id || !rule.condition || !rule.result) throw new EngineError("Invalid rule", "RULE_INVALID");
    const versions = this.rules.get(rule.id) ?? [];
    const published = { ...clone(rule), version: versions.length + 1, enabled: rule.enabled ?? true };
    versions.push(published);
    this.rules.set(rule.id, versions);
    this.audit.record({ engine: "rules", action: "rule.published", actorUserId, organizationId: rule.organizationId, subjectId: rule.id, metadata: { version: published.version, priority: rule.priority } });
    return clone(published);
  }

  evaluate(context: RuleContext, options: { organizationId?: number | null; dryRun?: boolean } = {}): { matched: boolean; result: Record<string, unknown>; ruleId?: string; version?: number; trace: Array<Record<string, unknown>> } {
    const time = new Date();
    const candidates = [...this.rules.values()].map((versions) => versions[versions.length - 1]!).filter((rule) =>
      rule.enabled && (rule.organizationId == null || rule.organizationId === options.organizationId) &&
      (!rule.activeFrom || time >= new Date(rule.activeFrom)) && (!rule.activeUntil || time <= new Date(rule.activeUntil)),
    ).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const trace: Array<Record<string, unknown>> = [];
    for (const rule of candidates) {
      const matched = this.test(rule.condition, context, trace);
      trace.push({ ruleId: rule.id, version: rule.version, matched, dryRun: options.dryRun ?? false });
      if (matched) {
        if (!options.dryRun) this.audit.record({ engine: "rules", action: "rule.evaluated", organizationId: options.organizationId, subjectId: rule.id, metadata: { version: rule.version, trace } });
        return { matched: true, result: clone(rule.result), ruleId: rule.id, version: rule.version, trace };
      }
    }
    return { matched: false, result: {}, trace };
  }

  history(id?: string): Rule[] { return [...this.rules.entries()].flatMap(([key, versions]) => (!id || id === key) ? versions.map(clone) : []); }

  private test(condition: Condition, context: RuleContext, trace: Array<Record<string, unknown>>): boolean {
    if (condition.op === "all") return condition.conditions.every((item) => this.test(item, context, trace));
    if (condition.op === "any") return condition.conditions.some((item) => this.test(item, context, trace));
    if (condition.op === "not") return !this.test(condition.condition, context, trace);
    const actual = context[condition.field];
    if (condition.op === "exists") return (actual !== undefined && actual !== null) === condition.value;
    if (condition.op === "in") return condition.value.includes(actual as RuleValue);
    if (condition.op === "eq") return actual === condition.value;
    if (condition.op === "neq") return actual !== condition.value;
    if (typeof actual !== "number" || typeof condition.value !== "number") return false;
    if (condition.op === "gt") return actual > condition.value;
    if (condition.op === "gte") return actual >= condition.value;
    if (condition.op === "lt") return actual < condition.value;
    return actual <= condition.value;
  }
}