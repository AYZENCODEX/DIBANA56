-- 047_ayzen_mailbox_send_queue.sql
-- Robust Send Queue, Phase 1 (durable outbox + worker). Replaces the
-- inline sendAsAyzenUser() call POST /ayzen-email/mailbox/send used to make
-- synchronously in the request handler — that path had no durability: a
-- Resend timeout, a mid-call crash, or a failed post-send DB write could
-- lose or duplicate a message with zero record of the attempt.
--
-- One row per outbound message that goes through the queue (immediate
-- sends for now; Scheduled Send keeps its own lib/mail-schedule-cron.ts
-- path until/unless it's folded in later).
--
--   * status          — 'pending' | 'sending' | 'sent' | 'failed'.
--                        lib/mail-send-queue.ts's claimNextBatch() moves
--                        pending -> sending atomically (FOR UPDATE SKIP
--                        LOCKED) so more than one worker instance can run
--                        without double-sending the same row.
--   * next_attempt_at  — worker only claims rows where this has passed.
--                        Phase 1 always claims immediately (now()); Phase 2
--                        pushes this forward on failure for backoff.
--   * locked_at/locked_by — set when a row moves to 'sending'; Phase 2
--                        uses locked_at to recover rows abandoned by a
--                        worker that crashed mid-send.
--   * attempts         — how many send attempts this row has had. Stays 0
--                        through Phase 1 (no retry yet); Phase 2 increments
--                        it and caps it.
--   * last_error        — most recent failure message, surfaced to the user
--                        once Phase 2 adds a landing spot for it.
CREATE TABLE IF NOT EXISTS ayzen_mailbox_send_queue (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES ayzen_mailbox_messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT now(),
  locked_at TIMESTAMP,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- Same "partial index on the sweep's WHERE clause" pattern migration 045
-- used for the scheduled-send sweep — keeps the worker's claim query cheap
-- as the table grows, since sent/failed rows never need to be scanned.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_send_queue_pending_idx
  ON ayzen_mailbox_send_queue (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS ayzen_mailbox_send_queue_message_id_idx
  ON ayzen_mailbox_send_queue (message_id);
