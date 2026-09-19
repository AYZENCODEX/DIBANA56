import { randomUUID } from "node:crypto";
import { AuditSink, EngineError, clone, emitSubEngineEvent } from "./common";

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
    emitSubEngineEvent({
      type: "subengine.governance.registered",
      actorUserId,
      organizationId: input.organizationId,
      aggregate: { type: "governance-record", id: record.id },
      payload: { recordId: record.id, resourceType: record.resourceType, resourceId: record.resourceId, classification: record.classification },
    });
    return clone(record);
  }

  addHold(recordId: string, kind: GovernanceHold["kind"], reason: string, actorUserId?: number | null): GovernanceHold {
    const record = this.get(recordId);
    const hold = { id: randomUUID(), recordId, kind, reason: reason.trim(), createdAt: new Date() };
    this.holds.set(hold.id, hold);
    record.lifecycle = "held"; record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.hold_added", actorUserId, organizationId: record.organizationId, subjectId: recordId, metadata: { kind, reason } });
    emitSubEngineEvent({ type: "subengine.governance.hold_added", actorUserId, organizationId: record.organizationId, aggregate: { type: "governance-record", id: recordId }, payload: { recordId, holdId: hold.id, kind, reason } });
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
    emitSubEngineEvent({ type: "subengine.governance.hold_released", actorUserId, organizationId: record.organizationId, aggregate: { type: "governance-record", id: record.id }, payload: { recordId: record.id, holdId } });
  }

  requestDeletion(recordId: string, actorUserId?: number | null): GovernanceRecord {
    const record = this.get(recordId);
    if (this.activeHold(recordId)) throw new EngineError("Protected data cannot be deleted while a hold is active", "GOVERNANCE_HOLD_BLOCKED", 409);
    record.lifecycle = "pending_deletion"; record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.deletion_requested", actorUserId, organizationId: record.organizationId, subjectId: record.id, metadata: {} });
    emitSubEngineEvent({ type: "subengine.governance.deletion_requested", actorUserId, organizationId: record.organizationId, aggregate: { type: "governance-record", id: record.id }, payload: { recordId: record.id, resourceType: record.resourceType, resourceId: record.resourceId } });
    return clone(record);
  }

  delete(recordId: string, actorUserId?: number | null): GovernanceRecord {
    const record = this.get(recordId);
    if (this.activeHold(recordId)) throw new EngineError("Protected data cannot be deleted while a hold is active", "GOVERNANCE_HOLD_BLOCKED", 409);
    record.lifecycle = "deleted"; record.updatedAt = new Date();
    this.audit.record({ engine: "data-governance", action: "governance.deleted", actorUserId, organizationId: record.organizationId, subjectId: record.id, metadata: {} });
    emitSubEngineEvent({ type: "subengine.governance.deleted", actorUserId, organizationId: record.organizationId, aggregate: { type: "governance-record", id: record.id }, payload: { recordId: record.id, resourceType: record.resourceType, resourceId: record.resourceId } });
    return clone(record);
  }

  canExport(recordId: string): boolean {
    const record = this.get(recordId);
    return record.lifecycle !== "deleted" && record.classification !== "restricted";
  }

  canAccess(recordId: string, organizationId: number): boolean {
    const record = this.get(recordId);
    return record.organizationId === organizationId && record.lifecycle !== "deleted";
  }

  enforceRetention(now = new Date()): number {
    let deleted = 0;
    for (const record of this.records.values()) {
      if (record.lifecycle === "active" && record.retentionUntil && record.retentionUntil <= now && !this.activeHold(record.id)) {
        record.lifecycle = "deleted";
        record.updatedAt = now;
        deleted++;
        this.audit.record({ engine: "data-governance", action: "governance.retention_deleted", organizationId: record.organizationId, subjectId: record.id, metadata: { retentionUntil: record.retentionUntil.toISOString() } });
        emitSubEngineEvent({ type: "subengine.governance.deleted", organizationId: record.organizationId, aggregate: { type: "governance-record", id: record.id }, payload: { recordId: record.id, resourceType: record.resourceType, resourceId: record.resourceId, reason: "retention" } });
      }
    }
    return deleted;
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