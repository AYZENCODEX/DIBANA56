-- 087_ayzen_oidc_backchannel_logout_queue.sql
-- OIDC Roadmap — Season 3, Phase 6e-c: Failure Handling.
-- Run this once in Supabase SQL Editor. Run AFTER 086.
--
-- 6e-a's own header reserved this exact shape for later ("Deliberately has
-- no `attempt`/`retryAfter`-style fields yet — that's 6e-c's own shape to
-- add, not speculated here"); 6e-b's own header reserved it again
-- ("Retry/backoff policy is explicitly 6e-c's own scope"). This table is
-- that shape, finally added.
--
-- Before this migration, dispatchBackchannelLogoutForUser()
-- (lib/oidc-logout-propagation.ts) made exactly ONE HTTP POST attempt per
-- registered target and, on failure, logged a warning and moved on — no
-- durable record survived a process restart, so a Sylo outage at the wrong
-- moment permanently desynced that user's Sylo session from their actual
-- Central logout/revoke with zero trace.
--
-- Deliberately mirrors migrations/047_ayzen_mailbox_send_queue.sql +
-- 048_ayzen_mailbox_send_queue_recovery.sql's own proven durable-outbox
-- shape (see lib/mail-send-queue.ts) rather than inventing a second retry
-- convention in this codebase — same status/attempts/next_attempt_at/
-- locked_at/locked_by/last_error column set, same FOR UPDATE SKIP LOCKED
-- claim pattern, same exponential-backoff-then-give-up lifecycle. The one
-- shape difference: this table stores `user_id` + `client_id` +
-- `backchannel_logout_uri` (the BINDING a retry needs), never a signed
-- Logout Token string — see lib/oidc-logout-propagation.ts's own comment
-- on why a queued row mints a FRESH token per retry attempt rather than
-- replaying a stored one (LOGOUT_TOKEN_TTL_SECONDS is only 2 minutes; a
-- backoff-delayed retry's stored token would already be expired by the
-- time it ran).
--
--   * status                  — 'pending' | 'sending' | 'delivered' |
--                                'dead_letter'. claimNextBackchannelLogoutBatch()
--                                moves pending -> sending atomically (FOR
--                                UPDATE SKIP LOCKED) so more than one
--                                worker instance can run without double-
--                                delivering the same row. 'dead_letter' is
--                                terminal — a row that exhausted
--                                MAX_BACKCHANNEL_LOGOUT_ATTEMPTS, requiring
--                                the same kind of operator attention
--                                mail_send_queue's 'failed' rows do today
--                                (6e-d's future monitoring/alerting would
--                                key off this exact status, not built here).
--   * user_id                 — FK to users(id), CASCADE: no point
--                                retrying a logout notification for an
--                                account that no longer exists.
--   * client_id                — the target oidc_clients.client_id (e.g.
--                                'sylo'). No FK — same reasoning migration
--                                086 already gives for user_sessions.origin_client_id:
--                                a historical tag on a queued attempt, not
--                                a live join target, so a client row that
--                                could theoretically be deleted later must
--                                never block this table.
--   * backchannel_logout_uri  — snapshot of the target's URI AS OF the
--                                first failed attempt, not re-resolved on
--                                every retry. See lib/oidc-logout-propagation.ts's
--                                enqueueBackchannelLogoutRetry() for why a
--                                fixed snapshot (not a live re-lookup) is
--                                the deliberate choice here.
--   * next_attempt_at         — worker only claims rows where this has
--                                passed; pushed forward on each failed
--                                retry for backoff.
--   * locked_at/locked_by     — set when a row moves to 'sending'; used to
--                                recover rows abandoned by a worker that
--                                crashed mid-attempt.
--   * attempts                — retry attempts so far, INCLUDING the
--                                inline first attempt that failed and
--                                caused this row to be enqueued at all
--                                (that row starts at attempts = 1, not 0 —
--                                see enqueueBackchannelLogoutRetry()).
--   * last_error               — most recent failure detail, for
--                                logger/logBus output and any future
--                                operator-facing surface.
CREATE TABLE IF NOT EXISTS ayzen_oidc_backchannel_logout_queue (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  backchannel_logout_uri TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT now(),
  locked_at TIMESTAMP,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Same "partial index on the sweep's WHERE clause" pattern migration 047
-- used — keeps the worker's claim query cheap as the table grows, since
-- delivered/dead_letter rows never need to be scanned again.
CREATE INDEX IF NOT EXISTS ayzen_oidc_backchannel_logout_queue_pending_idx
  ON ayzen_oidc_backchannel_logout_queue (next_attempt_at)
  WHERE status = 'pending';

-- Mirrors migration 048's own follow-up index — speeds up the stale-lock
-- recovery sweep's `WHERE status = 'sending' AND locked_at < <cutoff>`
-- query, a different status filter than the pending index above covers.
CREATE INDEX IF NOT EXISTS ayzen_oidc_backchannel_logout_queue_sending_locked_idx
  ON ayzen_oidc_backchannel_logout_queue (locked_at)
  WHERE status = 'sending';

CREATE INDEX IF NOT EXISTS ayzen_oidc_backchannel_logout_queue_user_id_idx
  ON ayzen_oidc_backchannel_logout_queue (user_id);
