-- 110_ayzen_mega_engine_event_bus_phase_a.sql
-- AYZEN Mega Engine — Phase 8 blueprint, Part A: Core Event Bus
-- (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md §3/§4/§8/§10/§57-A).
-- Run this once in Supabase SQL Editor. Run AFTER 109.
--
-- IDEMPOTENT — every statement is safe to re-run (IF NOT EXISTS), matching
-- every other migration in this directory.
--
-- Three tables, one per Event Bus primitive the blueprint calls
-- non-negotiable for v1 (§9/§10/§57-A) — deliberately NOT a new database
-- (Non-Negotiable Rule §2: "do not create a second database"), just three
-- more tables in the existing one, same posture as every other engine in
-- this codebase (send queue, DR evidence collector, vault backup):
--
--   event_outbox        — the Transactional Outbox (§8). A business
--                          operation's own DB transaction inserts a row
--                          here in the SAME commit as its business writes,
--                          so "transaction succeeded but the process
--                          crashed before publishing" (§7) can't lose an
--                          event — the row is durably there to be picked
--                          up by the dispatcher's claim/lease sweep the
--                          moment it boots again. Columns are exactly
--                          §8's field list.
--
--   event_processed      — the idempotency ledger (§10). One row per
--                          (event_id, consumer) pair a subscriber has
--                          successfully handled, so a redelivered event
--                          (retry, crash-recovery reclaim, at-least-once
--                          semantics per §9) is detected and skipped
--                          rather than re-applied.
--
--   event_dead_letter    — where an event lands once its outbox row has
--                          exhausted retries (§11/DLQ in §61's health
--                          model), carrying the full envelope so an
--                          operator can inspect and replay it (§57-E,
--                          "dead-letter tools").
--
-- No DB-level FOREIGN KEY constraints — matches this schema directory's
-- existing posture (see schema/relationships.ts's header for the same
-- reasoning): an event's aggregate can reference any resource type across
-- any domain module, so there is no single table to point a FK at.

CREATE TABLE IF NOT EXISTS event_outbox (
  id                TEXT PRIMARY KEY,                 -- envelope.id (globally unique, caller-generated UUID)
  event_type        TEXT NOT NULL,                    -- e.g. 'organization.member.invited'
  event_version     INTEGER NOT NULL DEFAULT 1,
  occurred_at       TIMESTAMP NOT NULL DEFAULT now(),
  published_at      TIMESTAMP,

  actor             JSONB,                            -- { userId?, organizationId?, sessionId?, source? }
  correlation_id    TEXT,
  causation_id      TEXT,
  aggregate_type    TEXT,
  aggregate_id      TEXT,

  payload           JSONB NOT NULL,
  metadata          JSONB,

  status            TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | PROCESSING | PUBLISHED | FAILED | DEAD_LETTER
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMP NOT NULL DEFAULT now(),
  locked_by         TEXT,
  locked_at         TIMESTAMP,

  created_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- Dispatcher's claim query: due, unlocked rows ordered oldest-first.
CREATE INDEX IF NOT EXISTS idx_event_outbox_claim
  ON event_outbox(status, next_attempt_at);

-- "ordering per aggregate where required" (§9) — a consumer that needs
-- an aggregate's events in order reads this index, not event_type alone.
CREATE INDEX IF NOT EXISTS idx_event_outbox_aggregate
  ON event_outbox(aggregate_type, aggregate_id)
  WHERE aggregate_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_event_outbox_correlation
  ON event_outbox(correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS event_processed (
  id            SERIAL PRIMARY KEY,
  event_id      TEXT NOT NULL,
  consumer      TEXT NOT NULL,                        -- subscriber/handler name that processed it
  processed_at  TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(event_id, consumer)
);

CREATE INDEX IF NOT EXISTS idx_event_processed_event ON event_processed(event_id);

CREATE TABLE IF NOT EXISTS event_dead_letter (
  id             SERIAL PRIMARY KEY,
  event_id       TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  consumer       TEXT,                                -- NULL = dispatch-level failure (e.g. unregistered type), not a specific subscriber
  envelope       JSONB NOT NULL,                       -- full EventEnvelope, so replay doesn't need to reconstruct it
  attempt_count  INTEGER NOT NULL,
  last_error     TEXT,
  status         TEXT NOT NULL DEFAULT 'PENDING',      -- PENDING | REPLAYED | DISCARDED
  failed_at      TIMESTAMP NOT NULL DEFAULT now(),
  resolved_at    TIMESTAMP,
  UNIQUE(event_id, consumer)
);

CREATE INDEX IF NOT EXISTS idx_event_dead_letter_type ON event_dead_letter(event_type);
CREATE INDEX IF NOT EXISTS idx_event_dead_letter_status ON event_dead_letter(status);
