import { createHash, randomUUID } from "node:crypto";
import { AuditSink, EngineError, clone } from "./common";

export type BlobScope = { organizationId: number; userId?: number; resourceId?: string };
export type BlobRecord = {
  id: string;
  scope: BlobScope;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  version: number;
  temporary: boolean;
  retentionUntil?: Date;
  status: "active" | "deleted";
  createdAt: Date;
};

export type BlobAccessPolicy = (record: BlobRecord, scope: BlobScope) => boolean;

export class FileBlobEngine {
  private readonly records = new Map<string, BlobRecord>();
  private readonly bytes = new Map<string, Buffer>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly audit: AuditSink, private readonly access: BlobAccessPolicy = (record, scope) =>
    record.scope.organizationId === scope.organizationId && (!record.scope.userId || record.scope.userId === scope.userId)) {}

  put(input: {
    scope: BlobScope;
    fileName: string;
    mimeType: string;
    data: Buffer | Uint8Array | string;
    temporary?: boolean;
    retentionUntil?: Date;
    actorUserId?: number | null;
  }): BlobRecord {
    if (!input.scope.organizationId || !input.fileName || !input.mimeType) throw new EngineError("Blob scope, file name and MIME type are required", "BLOB_METADATA_INVALID");
    const data = Buffer.isBuffer(input.data) ? Buffer.from(input.data) : Buffer.from(input.data);
    if (data.length === 0) throw new EngineError("Empty blobs are not allowed", "BLOB_EMPTY");
    const checksum = createHash("sha256").update(data).digest("hex");
    const logicalKey = `${input.scope.organizationId}:${input.scope.resourceId ?? input.fileName}`;
    const version = (this.versions.get(logicalKey) ?? 0) + 1;
    const record: BlobRecord = {
      id: randomUUID(), scope: clone(input.scope), fileName: input.fileName, mimeType: input.mimeType,
      sizeBytes: data.length, checksum, version, temporary: Boolean(input.temporary),
      retentionUntil: input.retentionUntil, status: "active", createdAt: new Date(),
    };
    this.records.set(record.id, record);
    this.bytes.set(record.id, data);
    this.versions.set(logicalKey, version);
    this.audit.record({ engine: "file-blob", action: "blob.created", actorUserId: input.actorUserId, organizationId: input.scope.organizationId, subjectId: record.id, metadata: { checksum, sizeBytes: data.length, version } });
    return clone(record);
  }

  get(id: string, scope: BlobScope): { record: BlobRecord; data: Buffer } {
    const record = this.records.get(id);
    if (!record || record.status !== "active") throw new EngineError("Blob not found", "BLOB_NOT_FOUND", 404);
    if (!this.access(record, scope)) throw new EngineError("Blob access denied", "BLOB_ACCESS_DENIED", 403);
    const data = this.bytes.get(id);
    if (!data) throw new EngineError("Blob content is unavailable", "BLOB_CONTENT_MISSING", 500);
    return { record: clone(record), data: Buffer.from(data) };
  }

  list(scope: BlobScope): BlobRecord[] {
    return [...this.records.values()].filter((record) => record.status === "active" && this.access(record, scope)).map(clone);
  }

  delete(id: string, scope: BlobScope, actorUserId?: number | null): void {
    const record = this.records.get(id);
    if (!record || record.status !== "active") throw new EngineError("Blob not found", "BLOB_NOT_FOUND", 404);
    if (!this.access(record, scope)) throw new EngineError("Blob access denied", "BLOB_ACCESS_DENIED", 403);
    record.status = "deleted";
    this.bytes.delete(id);
    this.audit.record({ engine: "file-blob", action: "blob.deleted", actorUserId, organizationId: record.scope.organizationId, subjectId: id, metadata: { checksum: record.checksum } });
  }

  cleanup(now = new Date()): number {
    let removed = 0;
    for (const record of this.records.values()) {
      if (record.status === "active" && (record.temporary || (record.retentionUntil && record.retentionUntil <= now))) {
        record.status = "deleted"; this.bytes.delete(record.id); removed++;
      }
    }
    if (removed) this.audit.record({ engine: "file-blob", action: "blob.cleanup", metadata: { removed } });
    return removed;
  }
}