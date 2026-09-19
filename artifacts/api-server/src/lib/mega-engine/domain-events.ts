/**
 * AYZEN domain -> Mega Engine event boundary.
 *
 * Domain routes keep ownership of business mutations. This adapter only
 * defines the stable, metadata-only event vocabulary and puts actor,
 * organization, aggregate, and trace context into the common envelope.
 * Payloads are intentionally narrow so credentials, tokens, and vault
 * values cannot enter the orchestration bus by accident.
 */
import { publishEvent, registerEvent } from "../event-bus";
import type { PublishEventParams } from "../event-bus";
import { getCurrentTraceContext } from "../trace-context";

export const AYZEN_DOMAIN_EVENT_TYPES = [
  "organization.member.invited",
  "organization.member.joined",
  "organization.member.role_changed",
  "organization.member.removed",
  "organization.ownership.transferred",
  "credits.consumed",
  "credits.consumption_failed",
  "notification.requested",
  "notification.delivered",
  "notification.failed",
  "oidc.login",
  "oidc.session.created",
  "oidc.session.revoked",
  "oidc.logout",
  "vault.share.created",
  "vault.share.revoked",
  "telegram.notification.requested",
  "astra.session.synchronized",
  "project.lifecycle.changed",
  "task.reminder.requested",
] as const;

export type AyzenDomainEventType = (typeof AYZEN_DOMAIN_EVENT_TYPES)[number];

export function registerAyzenDomainEvents(): void {
  for (const type of AYZEN_DOMAIN_EVENT_TYPES) {
    registerEvent({ type, version: 1, owner: "ayzen-domain", description: "Metadata-only domain lifecycle event" });
  }
}

export interface PublishAyzenDomainEventParams<T extends Record<string, unknown>> {
  type: AyzenDomainEventType;
  payload: T;
  actorUserId?: number;
  organizationId?: number;
  aggregate?: { type: string; id: string };
  causationId?: string;
}

export async function publishAyzenDomainEvent<T extends Record<string, unknown>>(
  params: PublishAyzenDomainEventParams<T>,
): Promise<{ id: string }> {
  const context = getCurrentTraceContext();
  const event: PublishEventParams<T> = {
    type: params.type,
    payload: params.payload,
    actor: params.actorUserId || params.organizationId
      ? { userId: params.actorUserId, organizationId: params.organizationId, source: "ayzen-domain" }
      : undefined,
    aggregate: params.aggregate,
    traceId: context?.traceId,
    correlationId: context?.correlationId,
    causationId: params.causationId ?? context?.causationId,
  };
  return publishEvent(event);
}