/**
 * lib/event-bus/subscriptions.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * §9's "handler discovery" half of delivery — separate from
 * event-registry.ts on purpose: a type can be *registered* (declared,
 * schema-validated) with zero subscribers (a pure "this happened, some
 * future consumer may care" fact — §5's whole naming list starts this
 * way), and a subscriber only ever needs to know the event *type* string,
 * not the full EventDefinition.
 *
 * In-memory, populated by each consumer module's own subscribe() call at
 * import time — same "code registers itself" posture as
 * event-registry.ts's registerEvent(). Multiple subscribers per type are
 * normal (§1's diagram: Workflow / Notify / Audit all hang off the same
 * bus) and are dispatched independently — one subscriber's failure/retry
 * does not block another subscriber on the same event (see
 * dispatcher.ts).
 */
import type { EventHandler, Subscription } from "./types";

const subscriptions = new Map<string, Subscription[]>();

/**
 * Registers `handler` as `consumer` for `eventType`. `consumer` MUST be a
 * stable, unique name for this specific handler (e.g. "notify-org-invite",
 * not "handler1") — it's the idempotency key event-bus/idempotency.ts
 * dedupes redelivery against, so renaming it resets that consumer's
 * processed-history for every event still moving through the bus.
 */
export function subscribe<T = unknown>(eventType: string, consumer: string, handler: EventHandler<T>): void {
  const existing = subscriptions.get(eventType) ?? [];
  if (existing.some((s) => s.consumer === consumer)) {
    // Re-subscribing the same (type, consumer) pair (hot reload, re-import)
    // replaces the handler rather than double-registering it — otherwise
    // every event would fire the same consumer's logic twice per tick.
    subscriptions.set(eventType, existing.map((s) => (s.consumer === consumer ? { eventType, consumer, handler } : s)));
    return;
  }
  subscriptions.set(eventType, [...existing, { eventType, consumer, handler }]);
}

export function getSubscribers(eventType: string): Subscription[] {
  return subscriptions.get(eventType) ?? [];
}

export function listSubscriptions(): Subscription[] {
  return Array.from(subscriptions.values()).flat();
}
