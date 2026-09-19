import { randomUUID } from "node:crypto";
import { AuditSink, EngineError, clone } from "./common";

export type Classification = "public" | "internal" | "confidential" | "restricted";
export type LifecycleState = "active" | "held" | "pending_deletion" | "deleted";
export type GovernanceRecord = {
  id: string; organizationId: number; resourceType: string; resourceId: string;
  classification: Classification; lifecycle: LifecycleState; retentionUntil?: Date;
  sensitiveFields: string[]; createdAt: Date; updatedAt: Date;
};
export type GovernanceHold = { id: string; recordId: string; kind: "legal" | "operational"; reason: string; createdAt: Date; releasedAt?: Date };

export class DataGovernanceEngine {
  private readonly records = new Map<string, GovernanceRecord>();
  private readonly holds = new Map<string, GovernanceHold>();

  constructor(private readonly audit: AuditSink) {}

  register(input: Omit<GovernanceRecord, "id" | "lifecycle" | "createdAt" | "updatedAt">, actorUserId?: number | null): GovernanceRecord {
    if (!input.organizationId || !input.resourceType || !input.resourceId) throw new EngineError("Governance resource identity is required", "GOVERNANCE_RESOURCE_INVALID");
    const existing = [...this.records.values()].find((record) => record.organizationId === input.organizationId && record.resourceType === input.resourceType && record.resourceId === input.resourceId);
    const now = new Date();
    const record = existing ?? { ...clone(input), id: randomUUID(), lifecycle: "active" as const, createdAt: now, updatedAt: now };
    Object.assign(record, { ...clone(input), updatedAt: now });
    this.records.set(record.id, record);
    this.audit.record({ engine: "data-governance", action: "governance.registered", actorUserId, organizationId: input.organizationId, subjectId: record.id, metadata: { classification: input.classification } });
    return clone(record);
  }

  addHold(recordId: string, kind: GovernanceHold["kind"], reason: string, actorUserId?: number | null): GovernanceHold {
    const record = this.get(recordId);
    const hold = { id: randomUUID(), recordId, kind, reason: reason.trim(), createdAt: new Date() };
    this.holds.set(hold.id, hold);
    record.lifecycle = "held"; record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.hold_added", actorUserId, organizationId: record.organizationId, subjectId: recordId, metadata: { kind, reason } });
    return clone(hold);
  }

  releaseHold(holdId: string, actorUserId?: number | null): void {
    const hold = this.holds.get(holdId);
    if (!hold || hold.releasedAt) throw new EngineError("Governance hold not found", "GOVERNANCE_HOLD_NOT_FOUND", 404);
    hold.releasedAt = new Date();
    const record = this.get(hold.recordId);
    if (!this.activeHold(record.id)) record.lifecycle = "active";
    record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.hold_released", actorUserId, organizationId: record.organizationId, subjectId: record.id, metadata: { holdId } });
  }

  requestDeletion(recordId: string, actorUserId?: number | null): GovernanceRecord {
    const record = this.get(recordId);
    if (this.activeHold(recordId)) throw new EngineError("Protected data cannot be deleted while a hold is active", "GOVERNANCE_HOLD_BLOCKED", 409);
    record.lifecycle = "pending_deletion"; record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.deletion_requested", actorUserId, organizationId: record.organizationId, subjectId: record.id, metadata: {} });
    return clone(record);
  }

  delete(recordId: string, actorUserId?: number | null): GovernanceRecord {
    const record = this.get(recordId);
    if (this.activeHold(recordId)) throw new EngineError("Protected data cannot be deleted while a hold is active", "GOVERNANCE_HOLD_BLOCKED", 409);
    record.lifecycle = "deleted"; record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.deleted", actorUserId, organizationId: record.organizationId, subjectId: record.id, metadata: {} });
    return clone(record);
  }

  canExport(recordId: string): boolean {
    const record = this.get(recordId);
    return record.lifecycle !== "deleted" && record.classification !== "restricted";
  }

  get(recordId: string): GovernanceRecord {
    const record = this.records.get(recordId);
    if (!record) throw new EngineError("Governance record not found", "GOVERNANCE_RECORD_NOT_FOUND", 404);
    return record;
  }

  list(organizationId: number): GovernanceRecord[] {
    return [...this.records.values()].filter((record) => record.organizationId === organizationId).map(clone);
  }

  private activeHold(recordId: string): boolean {
    return [...this.holds.values()].some((hold) => hold.recordId === recordId && !hold.releasedAt);
  }
}