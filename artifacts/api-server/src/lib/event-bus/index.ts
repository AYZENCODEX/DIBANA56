/**
 * lib/event-bus/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Mega Engine — Phase 8 blueprint, Part A: Core Event Bus. Barrel export —
 * domain modules publishing/subscribing should import from
 * "../event-bus" (this file), not reach into individual files here,
 * except event-registry's `z` re-export which is fine either way.
 */
export type {
  EventEnvelope,
  EventDefinition,
  EventHandler,
  Subscription,
  PublishEventParams,
  OutboxStatus,
  DeadLetterStatus,
  EventBusMetricsSnapshot,
} from "./types";

export { registerEvent, getEventDefinition, listEventDefinitions, isRegistered, validateEventPayload, UnknownEventTypeError } from "./event-registry";
export { subscribe, getSubscribers, listSubscriptions } from "./subscriptions";
export { publishEvent, publishEventStandalone } from "./publisher";
export { hasProcessed, markProcessed } from "./idempotency";
export { nextAttemptDelayMs, shouldDeadLetter, MAX_DISPATCH_ATTEMPTS } from "./retry";
export { moveToDeadLetter, listDeadLetters, replayDeadLetter, discardDeadLetter } from "./dead-letter";
export { getEventBusMetrics } from "./metrics";
export { runEventBusDispatchSweep, startEventBusDispatcher, stopEventBusDispatcher } from "./dispatcher";
