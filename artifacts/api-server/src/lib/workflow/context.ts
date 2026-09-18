/**
 * lib/workflow/context.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core
 * (§18 Durable Workflow State, §19 Workflow Context). Two independent
 * pieces of per-run durable state, kept in their own tables on purpose
 * (see migration 113's header):
 *
 *   - CHECKPOINTS (workflow_checkpoint) — engine-internal resumption
 *     state, append-only. "Which step is next" bookkeeping, not
 *     something a step's own handler writes.
 *   - VARIABLES (workflow_variable) — the "safe variables"/"step outputs"
 *     §19 lists as OK to carry between steps, UPDATE-in-place (current
 *     value only, no history).
 *
 * setVariable() is the one enforcement point for §19's "do not persist
 * raw passwords / OIDC tokens / refresh tokens / private keys / vault
 * seeds / payment credentials" rule — a denylist on the variable KEY
 * name, not the value (the value is arbitrary JSON the engine can't
 * meaningfully inspect for secrets), so a step handler that means to
 * store `apiToken` or `refreshToken` gets a loud failure here instead of
 * a silent row in the database. This is a floor, not a substitute for
 * every action handler's own judgment about what it feeds in as a
 * variable in the first place.
 */
import { db, workflowCheckpointTable, workflowVariableTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class UnsafeVariableKeyError extends Error {
  constructor(public readonly key: string) {
    super(`Refusing to persist workflow variable "${key}" — key name matches §19's secret denylist. Store a reference (e.g. a vault path) instead of the raw value.`);
    this.name = "UnsafeVariableKeyError";
  }
}

// Matched case-insensitively against the variable key, not its value —
// see this file's header. Deliberately broad substrings ("token", "key")
// over an exact-name allowlist: a false positive here just means a step
// author picks a differently-named variable, while a false negative
// means a real secret lands in the database.
const UNSAFE_KEY_PATTERN = /password|passwd|secret|token|refresh|private[_-]?key|vault[_-]?seed|credential|card[_-]?number|cvv|ssn/i;

export async function setVariable(runId: string, key: string, value: unknown, tx?: DbTx): Promise<void> {
  if (UNSAFE_KEY_PATTERN.test(key)) throw new UnsafeVariableKeyError(key);
  const executor = tx ?? db;
  await executor.insert(workflowVariableTable)
    .values({ runId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [workflowVariableTable.runId, workflowVariableTable.key],
      set: { value, updatedAt: new Date() },
    });
}

export async function getVariable(runId: string, key: string): Promise<unknown | undefined> {
  const [row] = await db.select().from(workflowVariableTable)
    .where(and(eq(workflowVariableTable.runId, runId), eq(workflowVariableTable.key, key)))
    .limit(1);
  return row?.value;
}

/** All of a run's current variables as a plain object — the shape a step's `input` template resolution (Part C2) will read from. */
export async function getAllVariables(runId: string): Promise<Record<string, unknown>> {
  const rows = await db.select().from(workflowVariableTable).where(eq(workflowVariableTable.runId, runId));
  const out: Record<string, unknown> = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

/** Append-only — see this file's header. `stepId` is optional: a checkpoint recorded between steps (while WAITING, §24) has no step currently running. */
export async function recordCheckpoint(runId: string, state: Record<string, unknown>, stepId?: string, tx?: DbTx): Promise<void> {
  const executor = tx ?? db;
  await executor.insert(workflowCheckpointTable).values({ runId, stepId, state });
}

/** The most recent checkpoint for a run — what a crashed/restarted worker reads to resume, per §18's "must survive API restart / worker crash / deployment" list. */
export async function getLatestCheckpoint(runId: string): Promise<Record<string, unknown> | undefined> {
  const [row] = await db.select().from(workflowCheckpointTable)
    .where(eq(workflowCheckpointTable.runId, runId))
    .orderBy(desc(workflowCheckpointTable.id))
    .limit(1);
  return row?.state;
}
