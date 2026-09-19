import { randomUUID } from "node:crypto";
import type { SioraDecision, SioraSeverity, SioraSignal } from "./contracts";

export type SioraIncident = {
  id: string;
  status: "open" | "acknowledged" | "resolved";
  severity: SioraSeverity;
  title: string;
  reasonCodes: string[];
  traceId?: string;
  createdAt: string;
  updatedAt: string;
};

export type SioraResponseAction = {
  id: string;
  action: "require_step_up" | "revoke_session" | "restrict_action" | "increase_monitoring" | "create_incident";
  status: "recommended" | "requested" | "completed" | "failed";
  idempotencyKey: string;
  reason: string;
  createdAt: string;
};

export class SioraOperations {
  private readonly incidents = new Map<string, SioraIncident>();
  private readonly actions = new Map<string, SioraResponseAction>();

  createIncident(input: { severity: SioraSeverity; title: string; reasonCodes: string[]; traceId?: string }): SioraIncident {
    const now = new Date().toISOString();
    const incident: SioraIncident = { id: randomUUID(), status: "open", ...input, createdAt: now, updatedAt: now };
    this.incidents.set(incident.id, incident);
    return { ...incident, reasonCodes: [...incident.reasonCodes] };
  }

  updateIncident(id: string, status: SioraIncident["status"]): SioraIncident {
    const incident = this.incidents.get(id);
    if (!incident) throw new Error("Incident not found");
    const next = { ...incident, status, updatedAt: new Date().toISOString() };
    this.incidents.set(id, next);
    return { ...next, reasonCodes: [...next.reasonCodes] };
  }

  requestAction(input: Omit<SioraResponseAction, "id" | "createdAt" | "status">): SioraResponseAction {
    const existing = this.actions.get(input.idempotencyKey);
    if (existing) return { ...existing };
    const action: SioraResponseAction = { id: randomUUID(), status: "requested", createdAt: new Date().toISOString(), ...input };
    this.actions.set(action.idempotencyKey, action);
    return { ...action };
  }

  listIncidents(): SioraIncident[] { return [...this.incidents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  listActions(): SioraResponseAction[] { return [...this.actions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  recommend(signals: SioraSignal[], decision: SioraDecision, traceId?: string): SioraResponseAction | null {
    const severe = signals.find((signal) => signal.severity === "critical" || signal.severity === "high");
    if (!severe && decision === "allow") return null;
    const action = decision === "step_up" ? "require_step_up" : decision === "restrict" || decision === "deny" ? "restrict_action" : "increase_monitoring";
    return this.requestAction({
      action,
      idempotencyKey: `${traceId ?? "no-trace"}:${action}`,
      reason: severe?.reason ?? `SIORA decision: ${decision}`,
    });
  }
}

export const sioraOperations = new SioraOperations();