# AYZEN Mega Engine — Phase 8 Blueprint, Part A: Core Event Bus

Implements `AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md` §57's
**Part A — Core Event Bus**: `EventEnvelope`, `EventRegistry`, `Publisher`,
`Subscriber`, `Outbox`, `Idempotency`, `Retry`, `Dead Letter`, `Metrics`.

Part B (Scheduler) and Part C (Workflow) are **not** in this change — the
blueprint's own V1 order (§57) builds the Event Bus first since Workflow
and Scheduler both sit downstream of it in the target architecture (§64).

## Where it lives

Not under a new top-level `engine/` folder — the blueprint's §3 package
layout says to extend an existing equivalent folder instead of duplicating
it if one exists, and `lib/policy/` is exactly that: a major subsystem
already organized as nested `lib/<module>/<submodule>/*.ts` folders with a
barrel `index.ts` per level. The Event Bus follows the same shape:

```
artifacts/api-server/src/lib/event-bus/
  types.ts           EventEnvelope, OutboxStatus, EventDefinition, Subscription, ...
  event-registry.ts  registerEvent / validateEventPayload — §6, seeded with §5's naming list
  subscriptions.ts   subscribe / getSubscribers — separate from the registry on purpose (§9)
  publisher.ts        publishEvent(params, tx) — §7/§8 transactional outbox write
  dispatcher.ts        claim/lease/backoff worker — §7/§9, cron-scheduled every 5s
  idempotency.ts        hasProcessed / markProcessed — §10
  retry.ts               bounded exponential backoff — §11
  dead-letter.ts           moveToDeadLetter / replayDeadLetter — §57-E
  metrics.ts                in-process counters — §57-A / §59
  index.ts                   barrel export
```

New DB objects (`migrations/110_ayzen_mega_engine_event_bus_phase_a.sql`,
mirrored in `lib/db/src/schema/event-bus.ts`):

- `event_outbox` — the Transactional Outbox (§8), exactly §8's field list.
- `event_processed` — the idempotency ledger (§10), one row per
  `(event_id, consumer)` successfully handled.
- `event_dead_letter` — where an outbox row lands after
  `MAX_DISPATCH_ATTEMPTS` (8) failed attempts, or immediately for an
  unregistered event type; carries the full envelope for replay.

Like every other new-table migration in this directory (108, 109), this is
a manual, idempotent, run-once-in-Supabase file — it is **not** added to
`lib/schema-migrations.ts`'s auto-run array, matching that file's existing
"only `ALTER ... ADD COLUMN IF NOT EXISTS` patches to already-created
tables go here" convention.

## How it works

**Publish** — `publishEvent(params, tx)` takes the same `tx` handle a
caller's own `db.transaction()` block already has (identical calling
convention to `lib/mail-send-queue.ts`'s `enqueueSend(tx, ...)`), validates
the payload against whatever schema `event-registry.ts` has for that type,
and inserts one `event_outbox` row in the same commit as the caller's
business write. No fire-and-forget path exists (§7 explicitly rules it
out) — `publishEventStandalone(params)` is the only "no tx" option, for
callers with nothing else to piggyback the transaction on.

**Dispatch** — `startEventBusDispatcher()` (wired into
`artifacts/api-server/src/index.ts`'s boot sequence, same place as every
other cron/worker) runs a `node-cron` tick every 5s. Each tick:
`FOR UPDATE SKIP LOCKED`-claims up to 25 due `PENDING`/`FAILED` rows
(exact idiom `mail-send-queue.ts`'s `claimNextBatch()` already uses),
delivers each to every `subscriptions.ts` subscriber for its type —
skipping a `(event, consumer)` pair `idempotency.ts` already has recorded
— and advances the row to `PUBLISHED` (all subscribers OK),
`FAILED` + backoff (`retry.ts`'s jittered exponential delay), or
`DEAD_LETTER` once attempts hit 8. Same startup + per-tick stale-lock
recovery as the send queue, so a worker crash mid-dispatch never strands a
row.

**Delivery guarantees actually provided** (§9, verbatim): at-least-once
delivery, retry, idempotent consumers, dead-letter handling, correlation
IDs, metrics. Per-aggregate ordering is available (the outbox has an
`(aggregate_type, aggregate_id)` index) but not globally enforced across a
claimed batch — a consumer with a hard ordering need should key its own
idempotent apply logic off the aggregate + a sequence field in the
payload, per §9's own "where required" qualifier and §56's "what NOT to
build in V1." Exactly-once is explicitly not promised — `idempotency.ts`
is how exactly-once *business effects* are achieved instead (§9's own
framing).

**Unknown event types** (§6: "should be rejected or placed into a
controlled failure path") go straight to dead letter on first dispatch
attempt rather than retrying — no amount of backoff makes an unregistered
type registered.

## What a domain module does to use this (nothing else in this change calls it yet)

```ts
import { publishEvent, subscribe, registerEvent, z } from "../event-bus";

// Optional — only needed to get schema validation instead of pass-through.
registerEvent({
  type: "organization.member.invited",
  version: 1,
  owner: "organizations",
  schema: z.object({ organizationId: z.number(), invitedUserId: z.number() }),
});

// Inside an existing db.transaction(async (tx) => { ...business writes... }):
await publishEvent({ type: "organization.member.invited", payload: { organizationId, invitedUserId } }, tx);

// Anywhere at module load time:
subscribe("organization.member.invited", "notify-org-invite", async (envelope) => {
  // envelope.payload is typed T if you passed a generic to subscribe<T>(...)
});
```

No existing route or service was changed to call `publishEvent`/`subscribe`
in this change — per the blueprint's Non-Negotiable Rules (§2: "do not
rewrite working route handlers") and Recommended Phase Placement (§65),
Part A lands as new, inert-until-called infrastructure. Wiring individual
domain events (Organizations, Credits, Notifications, OIDC, Vault,
Telegram, Astra — §63's Integration checklist) is Part D/E work, done
incrementally, one producer or consumer at a time, without touching this
change's files again except to add real schemas.

## Definition of Done — Event Bus (§63), this change's scope only

- [x] common event envelope exists
- [x] registry exists (schema validation, handler discovery, ownership, deprecation)
- [x] outbox exists (transactional — insert happens inside the caller's own `tx`)
- [x] idempotency exists (per `(event_id, consumer)`)
- [x] retries exist (bounded exponential backoff, ±20% jitter)
- [x] dead-letter handling exists (move + list + replay + discard)
- [x] metrics exist (in-process counters — `getEventBusMetrics()`)
- [ ] Workflow, Scheduler, cross-engine integration, domain integrations, operations tooling (admin UI, health model) — later phases (§57 B–E), not in this change.
