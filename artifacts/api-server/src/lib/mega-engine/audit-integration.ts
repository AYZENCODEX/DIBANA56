import { subscribe } from "../event-bus";
import type { EventEnvelope } from "../event-bus";
import { writeEngineAudit } from "./audit";
import { logger } from "../logger";

const AUDITED_EVENTS = [
  "workflow.started", "workflow.completed", "workflow.failed", "workflow.cancelled", "workflow.timed_out",
  "scheduler.job.completed", "scheduler.job.failed", "scheduler.job.deadlettered",
  "job.created", "job.cancelled", "job.failed",
  "organization.member.changed", "vault.share.changed", "oidc.session.changed",
  "policy.decision.denied", "dead_letter.replayed",
];

export function registerMegaEngineAuditIntegration(): void {
  for (const eventType of AUDITED_EVENTS) {
    subscribe(eventType, "mega-engine-audit", async (envelope: EventEnvelope) => {
      try {
        await writeEngineAudit({ action: eventType, envelope });
      } catch (err) {
        logger.error({ err, eventId: envelope.id, eventType }, "Mega Engine audit write failed");
        throw err;
      }
    });
  }
}