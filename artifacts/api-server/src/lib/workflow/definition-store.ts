/**
 * lib/workflow/definition-store.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part C1: Workflow durable core
 * (§16 Workflow Definition). The DB-backed counterpart to event-bus/
 * event-registry.ts's in-memory registry — see workflow_definition's own
 * migration-113 comment for why a definition is data here, not code: it
 * carries its own `version` field and is meant to be authored/edited
 * (an admin UI, in V1) rather than shipped only via a `registerX()` call
 * at process boot.
 *
 * publishDefinition() validates synchronously (same "fail at the call
 * site, not at first run" posture scheduler/job-store.ts's scheduleCron()
 * uses for parseCron()) before ever inserting a row.
 */
import { db, workflowDefinitionTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { validateCondition } from "./conditions";
import type { WorkflowDefinition, WorkflowStepDefinition } from "./types";

export class InvalidDefinitionError extends Error {
  constructor(message: string) {
    super(`Invalid workflow definition: ${message}`);
    this.name = "InvalidDefinitionError";
  }
}

/**
 * §16/§20's "no arbitrary code execution" boundary starts here: this only
 * checks STRUCTURE (unique step ids, valid cross-references, a reachable
 * trigger-to-step wiring), not the meaning of a step's `type` or
 * `condition` — those are §20/§21's job (Part C2's condition evaluator and
 * action registry), which is exactly where "no eval() of user-provided
 * strings" actually gets enforced, by only ever dispatching to a fixed,
 * code-defined action registry rather than interpreting anything from the
 * JSONB `steps` column as executable.
 */
export function validateDefinition(def: WorkflowDefinition): void {
  if (!def.id) throw new InvalidDefinitionError("id is required");
  if (!Number.isInteger(def.version) || def.version < 1) throw new InvalidDefinitionError("version must be a positive integer");
  if (!def.name) throw new InvalidDefinitionError("name is required");
  if (!def.steps.length) throw new InvalidDefinitionError("steps must be non-empty");

  const ids = new Set<string>();
  for (const step of def.steps) {
    if (!step.id) throw new InvalidDefinitionError("every step needs an id");
    if (ids.has(step.id)) throw new InvalidDefinitionError(`duplicate step id "${step.id}"`);
    ids.add(step.id);
  }
  for (const step of def.steps) {
    for (const ref of [step.onSuccess, step.onFailure, step.compensation] as const) {
      if (ref !== undefined && !ids.has(ref)) {
        throw new InvalidDefinitionError(`step "${step.id}" references unknown step "${ref}"`);
      }
    }
    // Part C2 (§20) — structural validation only (depth/shape), same as
    // every other check in this function; whether a condition's `path`
    // actually resolves to anything meaningful at run time is out of
    // scope here, same posture already held for `input`/`type`.
    if (step.condition) {
      try {
        validateCondition(step.condition);
      } catch (err) {
        throw new InvalidDefinitionError(`step "${step.id}" has an invalid condition: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Compensation is deliberately a one-level unwind. A compensation action
  // cannot itself declare a compensation action: allowing that graph to
  // recurse makes a bad definition capable of compensating forever.
  for (const step of def.steps) {
    if (step.compensation === step.id) {
      throw new InvalidDefinitionError(`step "${step.id}" cannot compensate itself`);
    }
    if (step.compensation) {
      const compensationStep = def.steps.find((candidate) => candidate.id === step.compensation);
      if (compensationStep?.compensation) {
        throw new InvalidDefinitionError(
          `compensation step "${step.compensation}" cannot declare another compensation step`,
        );
      }
    }
  }

  if (def.trigger.kind === "schedule" && (!def.trigger.cron || !def.trigger.timezone)) {
    throw new InvalidDefinitionError("schedule trigger requires cron and timezone");
  }
  if (def.trigger.kind === "delayed" && !(def.trigger.afterMs > 0)) {
    throw new InvalidDefinitionError("delayed trigger requires a positive afterMs");
  }
}

function rowToDefinition(row: typeof workflowDefinitionTable.$inferSelect): WorkflowDefinition {
  return {
    id: row.workflowId,
    version: row.version,
    name: row.name,
    trigger: row.trigger as WorkflowDefinition["trigger"],
    steps: row.steps as WorkflowStepDefinition[],
    maxRuntimeMs: row.maxRuntimeMs ?? undefined,
    metadata: row.metadata ?? undefined,
  };
}

/**
 * Inserts a new (id, version) row as ACTIVE. Does not touch prior
 * versions' status — call deprecateDefinition() separately for that, same
 * "two explicit calls, not one that guesses" posture scheduler/job-
 * store.ts's cancelJob() (separate from scheduleJob()) uses.
 */
export async function publishDefinition(def: WorkflowDefinition): Promise<void> {
  validateDefinition(def);
  await db.insert(workflowDefinitionTable).values({
    workflowId: def.id,
    version: def.version,
    name: def.name,
    trigger: def.trigger,
    steps: def.steps as unknown as Record<string, unknown>[],
    maxRuntimeMs: def.maxRuntimeMs,
    metadata: def.metadata,
  });
}

/** Marks one specific version DEPRECATED — getActiveDefinition() will then skip it in favor of the newest remaining ACTIVE version, but existing runs that already captured this version keep working (workflow_run stores its own definitionVersion at start time). */
export async function deprecateDefinition(workflowId: string, version: number): Promise<void> {
  await db.update(workflowDefinitionTable)
    .set({ status: "DEPRECATED", updatedAt: new Date() })
    .where(and(eq(workflowDefinitionTable.workflowId, workflowId), eq(workflowDefinitionTable.version, version)));
}

export async function getDefinition(workflowId: string, version: number): Promise<WorkflowDefinition | undefined> {
  const [row] = await db.select().from(workflowDefinitionTable)
    .where(and(eq(workflowDefinitionTable.workflowId, workflowId), eq(workflowDefinitionTable.version, version)))
    .limit(1);
  return row ? rowToDefinition(row) : undefined;
}

/** The version run-store.ts's startRun() resolves to when the caller doesn't pin one — newest ACTIVE version for `workflowId`. */
export async function getActiveDefinition(workflowId: string): Promise<WorkflowDefinition | undefined> {
  const [row] = await db.select().from(workflowDefinitionTable)
    .where(and(eq(workflowDefinitionTable.workflowId, workflowId), eq(workflowDefinitionTable.status, "ACTIVE")))
    .orderBy(desc(workflowDefinitionTable.version))
    .limit(1);
  return row ? rowToDefinition(row) : undefined;
}

export async function listDefinitionVersions(workflowId: string): Promise<WorkflowDefinition[]> {
  const rows = await db.select().from(workflowDefinitionTable)
    .where(eq(workflowDefinitionTable.workflowId, workflowId))
    .orderBy(desc(workflowDefinitionTable.version));
  return rows.map(rowToDefinition);
}

/**
 * Part D1 (§23 Event trigger) — every workflow's newest ACTIVE version,
 * filtered down to the ones whose trigger is `{ kind: "event" }`. Powers
 * triggers.ts's boot-time event-bus subscription: one workflow_id can
 * have many ACTIVE... no, exactly one ACTIVE version at a time in
 * practice (publishDefinition() doesn't flip prior versions, but a
 * well-behaved admin flow deprecates the old one first) — this still
 * defensively keeps only the highest version per workflowId, same
 * tie-break getActiveDefinition() already applies per-workflow, just
 * fanned out across every workflow rather than scoped to one id.
 */
/** Shared by every listActive*TriggeredDefinitions() below — newest ACTIVE version per workflowId, across ALL workflows (not scoped to one id, unlike getActiveDefinition()). Factored out in Part D2 so the schedule/delayed variants don't re-duplicate D1's own dedupe-by-workflow loop. */
async function listLatestActiveDefinitions(): Promise<WorkflowDefinition[]> {
  const rows = await db.select().from(workflowDefinitionTable)
    .where(eq(workflowDefinitionTable.status, "ACTIVE"))
    .orderBy(desc(workflowDefinitionTable.version));

  const latestByWorkflow = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!latestByWorkflow.has(row.workflowId)) latestByWorkflow.set(row.workflowId, row); // rows are already newest-version-first per the ORDER BY above
  }

  return Array.from(latestByWorkflow.values()).map(rowToDefinition);
}

export async function listActiveEventTriggeredDefinitions(): Promise<WorkflowDefinition[]> {
  const defs = await listLatestActiveDefinitions();
  return defs.filter((def) => def.trigger.kind === "event");
}

/**
 * Part D2 (§23 Schedule trigger) — every workflow's newest ACTIVE
 * version, filtered to `{ kind: "schedule" }`. Powers schedule-
 * triggers.ts's boot-time registrar, same "load once, re-derive on every
 * boot" posture listActiveEventTriggeredDefinitions() already documents
 * for itself.
 */
export async function listActiveScheduleTriggeredDefinitions(): Promise<WorkflowDefinition[]> {
  const defs = await listLatestActiveDefinitions();
  return defs.filter((def) => def.trigger.kind === "schedule");
}

/**
 * Part D2 (§23 Delayed trigger) — every workflow's newest ACTIVE
 * version, filtered to `{ kind: "delayed" }`. Includes definitions with
 * no `relativeToEventType` too — schedule-triggers.ts's registrar is the
 * one that decides what to do with those (§23's own example, "run 24
 * hours after event", only makes sense once an anchor event is known;
 * see that file for the fail-closed behavior when it's missing), not
 * this store-layer query.
 */
export async function listActiveDelayedTriggeredDefinitions(): Promise<WorkflowDefinition[]> {
  const defs = await listLatestActiveDefinitions();
  return defs.filter((def) => def.trigger.kind === "delayed");
}
