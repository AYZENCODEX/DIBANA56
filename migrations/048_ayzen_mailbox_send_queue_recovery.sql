-- 048_ayzen_mailbox_send_queue_recovery.sql
-- Robust Send Queue, Phase 2 (retry / exponential backoff / crash recovery).
--
-- All the columns Phase 2 needs (attempts, next_attempt_at, locked_at,
-- locked_by, last_error) already exist from migration 047 — Phase 1 added
-- them up front specifically so this phase wouldn't need a column-adding
-- migration. The one thing 047's indexing didn't cover: its partial index
-- is on (next_attempt_at) WHERE status = 'pending', which speeds up
-- claimNextBatch()'s query but does nothing for Phase 2's stale-lock sweep,
-- which scans WHERE status = 'sending' AND locked_at < <cutoff> — a
-- different status filter entirely, so it was doing a full table scan.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_send_queue_sending_locked_idx
  ON ayzen_mailbox_send_queue (locked_at)
  WHERE status = 'sending';
