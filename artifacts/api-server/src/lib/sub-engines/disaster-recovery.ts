import { createHash, randomUUID } from "node:crypto";
import { AuditSink, EngineError, clone } from "./common";

export type BackupArtifact = { name: string; content: string | Buffer; checksum?: string; verified?: boolean };
export type BackupRecord = { id: string; organizationId?: number; createdAt: Date; artifacts: Array<Omit<BackupArtifact, "content"> & { checksum: string }>; status: "catalogued" | "verified" | "failed" };
export type RestorePlan = { id: string; backupId: string; dependencies: string[]; orderedDependencies: string[]; drill: boolean; status: "planned" | "passed" | "failed"; failure?: string };

export class DisasterRecoveryEngine {
  private readonly backups = new Map<string, { record: BackupRecord; content: Map<string, Buffer> }>();
  private readonly plans = new Map<string, RestorePlan>();

  constructor(private readonly audit: AuditSink) {}

  catalog(input: { organizationId?: number; artifacts: BackupArtifact[]; actorUserId?: number | null }): BackupRecord {
    if (!input.artifacts.length) throw new EngineError("Backup must contain artifacts", "DR_BACKUP_EMPTY");
    const content = new Map<string, Buffer>();
    const artifacts = input.artifacts.map((artifact) => {
      const data = Buffer.isBuffer(artifact.content) ? Buffer.from(artifact.content) : Buffer.from(artifact.content);
      const checksum = createHash("sha256").update(data).digest("hex");
      content.set(artifact.name, data);
      return { name: artifact.name, checksum, verified: false };
    });
    const record: BackupRecord = { id: randomUUID(), organizationId: input.organizationId, createdAt: new Date(), artifacts, status: "catalogued" };
    this.backups.set(record.id, { record, content });
    this.audit.record({ engine: "disaster-recovery", action: "backup.catalogued", actorUserId: input.actorUserId, organizationId: input.organizationId, subjectId: record.id, metadata: { artifacts: artifacts.map((artifact) => artifact.name) } });
    return clone(record);
  }

  verify(backupId: string, actorUserId?: number | null): BackupRecord {
    const backup = this.get(backupId);
    let valid = true;
    for (const artifact of backup.record.artifacts) {
      const data = backup.content.get(artifact.name);
      const checksum = data ? createHash("sha256").update(data).digest("hex") : "";
      artifact.verified = checksum === artifact.checksum;
      valid &&= artifact.verified;
    }
    backup.record.status = valid ? "verified" : "failed";
    this.audit.record({ engine: "disaster-recovery", action: valid ? "backup.verified" : "backup.verification_failed", actorUserId, organizationId: backup.record.organizationId, subjectId: backupId, metadata: { valid } });
    return clone(backup.record);
  }

  planRestore(backupId: string, dependencies: string[], drill = true, actorUserId?: number | null): RestorePlan {
    const backup = this.get(backupId).record;
    const ordered = this.orderDependencies(dependencies);
    const plan: RestorePlan = { id: randomUUID(), backupId, dependencies: [...dependencies], orderedDependencies: ordered, drill, status: "planned" };
    this.plans.set(plan.id, plan);
    this.audit.record({ engine: "disaster-recovery", action: "restore.plan_created", actorUserId, organizationId: backup.organizationId, subjectId: plan.id, metadata: { backupId, orderedDependencies: ordered, drill } });
    return clone(plan);
  }

  runDrill(planId: string, actorUserId?: number | null): RestorePlan {
    const plan = this.plans.get(planId);
    if (!plan) throw new EngineError("Restore plan not found", "DR_PLAN_NOT_FOUND", 404);
    const backup = this.verify(plan.backupId, actorUserId);
    if (backup.status !== "verified") { plan.status = "failed"; plan.failure = "Backup integrity verification failed"; throw new EngineError(plan.failure, "DR_VERIFICATION_FAILED", 409); }
    plan.status = "passed";
    this.audit.record({ engine: "disaster-recovery", action: "restore.drill_passed", actorUserId, organizationId: backup.organizationId, subjectId: plan.id, metadata: { dependencies: plan.orderedDependencies } });
    return clone(plan);
  }

  get(backupId: string): { record: BackupRecord; content: Map<string, Buffer> } {
    const backup = this.backups.get(backupId);
    if (!backup) throw new EngineError("Backup not found", "DR_BACKUP_NOT_FOUND", 404);
    return backup;
  }

  private orderDependencies(dependencies: string[]): string[] {
    const unique = [...new Set(dependencies)];
    const known = new Set(unique);
    if (known.size !== dependencies.length) throw new EngineError("Duplicate recovery dependency", "DR_DEPENDENCY_INVALID");
    return unique.sort((a, b) => a.localeCompare(b));
  }
}