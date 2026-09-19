import { AuditSink, EngineError, Scope, deterministicPercent, clone } from "./common";

export type FeatureFlag = {
  key: string;
  enabled: boolean;
  killSwitch?: boolean;
  percentage?: number;
  organizationIds?: number[];
  userIds?: number[];
  cohorts?: string[];
  dependsOn?: string[];
  version: number;
};

export type FlagContext = Scope & { userId?: number | null; cohort?: string };

export class FeatureFlagEngine {
  private readonly flags = new Map<string, FeatureFlag>();

  constructor(private readonly audit: AuditSink) {}

  upsert(flag: Omit<FeatureFlag, "version">, actorUserId?: number | null): FeatureFlag {
    if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(flag.key)) throw new EngineError("Invalid feature flag key", "FLAG_INVALID");
    if (flag.percentage != null && (flag.percentage < 0 || flag.percentage > 100)) throw new EngineError("percentage must be 0..100", "FLAG_PERCENTAGE_INVALID");
    const current = this.flags.get(flag.key);
    const next = { ...clone(flag), version: (current?.version ?? 0) + 1 };
    this.flags.set(flag.key, next);
    this.audit.record({ engine: "feature-flags", action: "flag.updated", actorUserId, organizationId: flag.organizationIds?.[0], subjectId: flag.key, metadata: { version: next.version } });
    return clone(next);
  }

  evaluate(key: string, context: FlagContext, seen = new Set<string>()): boolean {
    const flag = this.flags.get(key);
    if (!flag || flag.killSwitch || !flag.enabled || seen.has(key)) return false;
    seen.add(key);
    if (flag.dependsOn?.some((dependency) => !this.evaluate(dependency, context, seen))) return false;
    if (flag.organizationIds?.length && !flag.organizationIds.includes(context.organizationId ?? -1)) return false;
    if (flag.userIds?.length && !flag.userIds.includes(context.userId ?? -1)) return false;
    if (flag.cohorts?.length && (!context.cohort || !flag.cohorts.includes(context.cohort))) return false;
    if (flag.percentage != null) {
      const subject = `${key}:${context.organizationId ?? "*"}:${context.userId ?? "*"}:${context.cohort ?? "*"}`;
      if (deterministicPercent(subject) >= flag.percentage) return false;
    }
    return true;
  }

  get(key: string): FeatureFlag | undefined {
    return clone(this.flags.get(key));
  }

  list(): FeatureFlag[] {
    return [...this.flags.values()].map(clone);
  }
}