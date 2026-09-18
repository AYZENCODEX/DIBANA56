/**
 * lib/event-bus/event-registry.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §6 — maps event types to schemas/owners/deprecation status. In-memory,
 * populated at process startup by each domain module's own registration
 * call (mirrors lib/policy/registry's "rules register themselves, the
 * registry just holds them" posture) — there is no DB table for this on
 * purpose: definitions are code, versioned with the code that publishes
 * and consumes them, not runtime-editable state. (Contrast with
 * event_outbox/event_processed/event_dead_letter, which ARE durable rows —
 * see migrations/110 — because those are per-event facts, not per-type
 * declarations.)
 *
 * §5's naming list is registered by this file's own default-registration
 * call at the bottom as a starting inventory so V1's dispatcher has
 * something real to validate against immediately; individual domain
 * modules (organizations, credits, notifications, ...) are expected to
 * take over registering their own types as they migrate onto the bus,
 * at which point their registerEvent() call is the source of truth and
 * can freely override the default's version/schema/owner here.
 */
import { z } from "zod/v4";
import { logger } from "../logger";
import type { EventDefinition } from "./types";

export class UnknownEventTypeError extends Error {
  constructor(public readonly eventType: string) {
    super(`Event type "${eventType}" is not registered — see event-bus/event-registry.ts's registerEvent()`);
    this.name = "UnknownEventTypeError";
  }
}

const registry = new Map<string, EventDefinition<any>>();

/**
 * §6 — register (or, for a type already present, knowingly re-register —
 * e.g. bumping `version`) an event type. Does NOT throw on overwrite:
 * hot-reload/test environments re-import modules, and "do not casually
 * rename [event names] after consumers exist" (§5) is a code-review
 * concern, not something this function can enforce at runtime.
 */
export function registerEvent<T = unknown>(def: EventDefinition<T>): void {
  registry.set(def.type, def);
}

export function getEventDefinition(type: string): EventDefinition<any> | undefined {
  return registry.get(type);
}

export function listEventDefinitions(): EventDefinition<any>[] {
  return Array.from(registry.values());
}

export function isRegistered(type: string): boolean {
  return registry.has(type);
}

/**
 * §6 "schema validation". Returns the validated (and possibly
 * schema-coerced) payload on success. Types with no `schema` registered
 * pass through unvalidated — the blueprint's registry requirements list
 * schema validation as a capability the registry must SUPPORT, not a
 * requirement that every single type have one from day one (most of §5's
 * default-registered types below don't yet).
 *
 * Throws UnknownEventTypeError for an unregistered type — "unknown event
 * types should be rejected or placed into a controlled failure path" (§6);
 * the publisher (publisher.ts) is that controlled failure path, catching
 * this and refusing to write the outbox row rather than silently accepting
 * an event nothing declared ownership of.
 */
export function validateEventPayload<T = unknown>(type: string, payload: unknown): T {
  const def = registry.get(type);
  if (!def) throw new UnknownEventTypeError(type);
  if (def.deprecated) {
    logger.warn({ eventType: type }, "Publishing a deprecated event type");
  }
  if (!def.schema) return payload as T;

  const result = def.schema.safeParse(payload);
  if (!result.success) {
    throw new Error(`Event "${type}" payload failed schema validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * §5 — the stable event-name inventory as a starting default registry so
 * dispatch can validate against something real from V1. Payloads are left
 * unvalidated (schema: undefined) here on purpose: each type's actual
 * shape belongs to the domain module that owns it, which should call
 * registerEvent() again with a real zod schema once it migrates onto the
 * bus (see this file's header) rather than this list guessing that shape
 * up front.
 */
const DEFAULT_EVENT_TYPES: Array<{ type: string; owner: string }> = [
  { type: "organization.created", owner: "organizations" },
  { type: "organization.member.invited", owner: "organizations" },
  { type: "organization.member.joined", owner: "organizations" },
  { type: "organization.member.removed", owner: "organizations" },

  { type: "vault.share.created", owner: "vault" },
  { type: "vault.share.revoked", owner: "vault" },

  { type: "credit.balance.changed", owner: "credits" },
  { type: "credit.consumption.created", owner: "credits" },
  { type: "credit.action.priced", owner: "credits" },

  { type: "notification.preference.changed", owner: "notifications" },
  { type: "notification.created", owner: "notifications" },
  { type: "notification.delivered", owner: "notifications" },
  { type: "notification.failed", owner: "notifications" },

  { type: "oidc.login.succeeded", owner: "oidc" },
  { type: "oidc.login.failed", owner: "oidc" },
  { type: "oidc.session.revoked", owner: "oidc" },
  { type: "oidc.logout.completed", owner: "oidc" },

  { type: "policy.decision.allowed", owner: "policy" },
  { type: "policy.decision.denied", owner: "policy" },

  { type: "project.created", owner: "projects" },
  { type: "project.deleted", owner: "projects" },
  { type: "project.exported", owner: "projects" },

  { type: "task.created", owner: "tasks" },
  { type: "task.completed", owner: "tasks" },
  { type: "task.failed", owner: "tasks" },

  { type: "marketplace.order.created", owner: "marketplace" },
  { type: "marketplace.order.completed", owner: "marketplace" },

  { type: "telegram.delivery.requested", owner: "telegram" },
  { type: "telegram.delivery.completed", owner: "telegram" },
];

for (const { type, owner } of DEFAULT_EVENT_TYPES) {
  registerEvent({ type, version: 1, owner });
}

// Re-exported so a domain module wanting to write a real schema for one of
// the above doesn't need a second import just for `z`.
export { z };
