import { z } from "zod/v4";
import {
  registerEvent,
  listEventDefinitions,
  publishEventStandalone,
  subscribe,
} from "../event-bus";
import {
  hasActiveJobForCorrelation,
  registerJobHandler,
  scheduleRecurring,
  scheduleJob,
  type ScheduledJob,
} from "../scheduler";
import { logger } from "../logger";
import {
  dataGovernanceEngine,
  disasterRecoveryEngine,
  eventReplayEngine,
  fileBlobEngine,
  dataPipelineEngine,
} from "./index";
import { setSubEngineEventSink } from "./common";

export const SUBENGINE_BLOB_CLEANUP_JOB = "subengine.blob.cleanup";
export const SUBENGINE_PIPELINE_RUN_JOB = "subengine.pipeline.run";
export const SUBENGINE_BACKUP_VERIFY_JOB = "subengine.backup.verify";

type PipelineRunPayload = {
  pipelineId: string;
  input: unknown;
  actorUserId?: number | null;
};

type BackupVerifyPayload = {
  backupId: string;
  actorUserId?: number | null;
};

const EVENT_TYPES = [
  ["subengine.blob.created", z.object({ blobId: z.string(), resourceId: z.string().nullable(), fileName: z.string(), mimeType: z.string(), sizeBytes: z.number(), checksum: z.string(), version: z.number() })],
  ["subengine.blob.deleted", z.object({ blobId: z.string(), resourceId: z.string().nullable(), checksum: z.string() })],
  ["subengine.blob.cleanup", z.object({ removed: z.number() })],
  ["subengine.governance.registered", z.object({ recordId: z.string(), resourceType: z.string(), resourceId: z.string(), classification: z.string() })],
  ["subengine.governance.hold_added", z.object({ recordId: z.string(), holdId: z.string(), kind: z.string(), reason: z.string() })],
  ["subengine.governance.hold_released", z.object({ recordId: z.string(), holdId: z.string() })],
  ["subengine.governance.deletion_requested", z.object({ recordId: z.string(), resourceType: z.string(), resourceId: z.string() })],
  ["subengine.governance.deleted", z.object({ recordId: z.string(), resourceType: z.string(), resourceId: z.string() })],
  ["subengine.replay.completed", z.object({ runId: z.string(), status: z.string(), selected: z.number(), processed: z.number(), failed: z.number(), dryRun: z.boolean() })],
  ["subengine.replay.cancel_requested", z.object({ runId: z.string() })],
  ["subengine.pipeline.started", z.object({ runId: z.string(), pipelineId: z.string(), version: z.number() })],
  ["subengine.pipeline.completed", z.object({ runId: z.string(), pipelineId: z.string(), checkpoint: z.number(), lineage: z.array(z.string()) })],
  ["subengine.pipeline.failed", z.object({ runId: z.string(), pipelineId: z.string(), checkpoint: z.number(), error: z.string() })],
  ["subengine.workflow.published", z.object({ workflowId: z.string(), version: z.number() })],
  ["subengine.backup.catalogued", z.object({ backupId: z.string(), artifacts: z.array(z.string()) })],
  ["subengine.backup.verified", z.object({ backupId: z.string(), valid: z.boolean() })],
  ["subengine.backup.verification_failed", z.object({ backupId: z.string(), valid: z.boolean() })],
  ["subengine.restore.plan_created", z.object({ planId: z.string(), backupId: z.string(), dependencies: z.array(z.string()), drill: z.boolean() })],
  ["subengine.restore.drill_passed", z.object({ planId: z.string(), backupId: z.string(), dependencies: z.array(z.string()) })],
] as const;

for (const [type, schema] of EVENT_TYPES) {
  registerEvent({ type, version: 1, owner: "sub-engines", schema });
}

let registered = false;

/**
 * Installs the bridge once the database is available. The engines remain
 * usable in isolation, while production mutations become durable outbox
 * events and are therefore available to workflow triggers and replay.
 */
export async function registerSubEngineIntegration(): Promise<void> {
  if (registered) return;
  registered = true;

  setSubEngineEventSink((event) => {
    void publishEventStandalone({
      type: event.type,
      payload: event.payload,
      actor: event.actorUserId == null
        ? undefined
        : { userId: event.actorUserId, organizationId: event.organizationId ?? undefined, source: "sub-engine" },
      aggregate: event.aggregate,
    }).catch((error) => logger.error({ error, eventType: event.type }, "Sub-engine event publication failed"));
  });

  // Capture the complete registered event stream for authorized replay. This
  // is a consumer, not a second dispatch path; replay still invokes explicit
  // target consumers only.
  for (const definition of listEventDefinitions()) {
    subscribe(definition.type, "subengine-event-replay-capture", async (envelope) => {
      eventReplayEngine.append(envelope);
    });
  }

  // A blob is governed by default as soon as it is created. Explicit admin
  // governance registration remains available for classification/retention
  // changes.
  subscribe("subengine.blob.created", "subengine-governance-blob-registration", async (envelope) => {
    const payload = envelope.payload as { blobId: string; mimeType: string };
    const organizationId = envelope.actor?.organizationId;
    if (!organizationId) return;
    dataGovernanceEngine.register({
      organizationId,
      resourceType: "blob",
      resourceId: payload.blobId,
      classification: payload.mimeType.startsWith("image/") ? "internal" : "confidential",
      sensitiveFields: [],
    }, envelope.actor?.userId);
  });

  registerJobHandler(SUBENGINE_BLOB_CLEANUP_JOB, async () => {
    fileBlobEngine.cleanup();
    dataGovernanceEngine.enforceRetention();
  }, { defaultMaxAttempts: 3, owner: "sub-engines", description: "Remove expired temporary blobs and govern expired records." });

  registerJobHandler<PipelineRunPayload>(SUBENGINE_PIPELINE_RUN_JOB, async (job: ScheduledJob<PipelineRunPayload>) => {
    const payload = job.payload;
    if (!payload?.pipelineId) throw new Error(`"${SUBENGINE_PIPELINE_RUN_JOB}" requires pipelineId`);
    await dataPipelineEngine.start(payload.pipelineId, payload.input, payload.actorUserId);
  }, { defaultMaxAttempts: 2, owner: "sub-engines", description: "Run a registered data pipeline outside the request path." });

  registerJobHandler<BackupVerifyPayload>(SUBENGINE_BACKUP_VERIFY_JOB, async (job: ScheduledJob<BackupVerifyPayload>) => {
    const payload = job.payload;
    if (!payload?.backupId) throw new Error(`"${SUBENGINE_BACKUP_VERIFY_JOB}" requires backupId`);
    disasterRecoveryEngine.verify(payload.backupId, payload.actorUserId);
  }, { defaultMaxAttempts: 2, owner: "sub-engines", description: "Verify a catalogued backup through the durable scheduler." });

  const cleanupCorrelation = "sub-engines:daily-cleanup";
  if (!(await hasActiveJobForCorrelation(SUBENGINE_BLOB_CLEANUP_JOB, cleanupCorrelation))) {
    await scheduleRecurring({
      jobType: SUBENGINE_BLOB_CLEANUP_JOB,
      intervalMs: 24 * 60 * 60 * 1000,
      correlationId: cleanupCorrelation,
      idempotencyKey: cleanupCorrelation,
      payload: {},
    });
  }

  logger.info({ eventTypes: EVENT_TYPES.length }, "S5-S8 sub-engine integration registered");
}

export async function schedulePipelineRun(input: PipelineRunPayload, options?: {
  actorUserId?: number | null;
  correlationId?: string;
  causationId?: string;
}): Promise<{ id: string }> {
  return scheduleJob({
    jobType: SUBENGINE_PIPELINE_RUN_JOB,
    runAt: new Date(),
    payload: { ...input, actorUserId: options?.actorUserId ?? input.actorUserId },
    correlationId: options?.correlationId,
    causationId: options?.causationId,
    idempotencyKey: options?.causationId ? `subengine.pipeline:${options.causationId}` : undefined,
  });
}

export async function scheduleBackupVerification(input: BackupVerifyPayload, options?: {
  actorUserId?: number | null;
  correlationId?: string;
  causationId?: string;
}): Promise<{ id: string }> {
  return scheduleJob({
    jobType: SUBENGINE_BACKUP_VERIFY_JOB,
    runAt: new Date(),
    payload: { ...input, actorUserId: options?.actorUserId ?? input.actorUserId },
    correlationId: options?.correlationId,
    causationId: options?.causationId,
    idempotencyKey: options?.causationId ? `subengine.backup-verify:${options.causationId}` : undefined,
  });
}