/**
 * lib/mega-engine/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Mega Engine — Phase 8 blueprint, Part E1 (§61 Engine Health Model) and
 * Part E3 (§60 Retention / §57-E "cleanup"). Barrel export — domain
 * modules (e.g. Part E's still-open admin/health route) should import
 * from "../mega-engine" (this file), not reach into engine-health.ts/
 * retention.ts directly, same convention event-bus/index.ts,
 * scheduler/index.ts and workflow/index.ts already establish for their
 * own directories.
 */
export type {
  HealthState, ComponentHealth,
  EventBusHealth, SchedulerSubsystemHealth, WorkflowSubsystemHealth,
  EngineHealth,
} from "./engine-health";

export {
  getEventBusHealth, getSchedulerHealth, getWorkflowHealth, getEngineHealth,
} from "./engine-health";
export { writeEngineAudit } from "./audit";
export { registerMegaEngineAuditIntegration } from "./audit-integration";
export { getEngineLinks } from "./links";
export type { EngineLinks } from "./links";
export { startMegaEngine, stopMegaEngine, validateMegaEngineConfiguration } from "./lifecycle";

// Part E3 — §60 Retention / §57-E "cleanup".
export type { RetentionSweepResult } from "./retention";
export {
  RETENTION_WINDOWS_MS, runRetentionSweep,
  MEGA_ENGINE_RETENTION_JOB_TYPE, registerRetentionSweepHandler, registerRetentionSweepSchedule,
} from "./retention";
