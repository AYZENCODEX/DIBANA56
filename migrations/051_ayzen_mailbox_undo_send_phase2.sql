-- 051_ayzen_mailbox_undo_send_phase2.sql
-- Undo Send, Phase 2. Two independent additions, both foreshadowed in
-- CHANGES_UNDO_SEND_PHASE1.md's "Not done here" section:
--
-- 1. mail_undo_send_window_ms (users) — Phase 1's window was a single
--    operator-set env var (MAIL_UNDO_SEND_WINDOW_MS) applied to every user.
--    This makes it a per-user preference instead (Settings, Gmail-style:
--    5/10/20/30s) while keeping the env var alive as the default new users
--    get and the value used if a row somehow ends up out of range. NOT NULL
--    with a default so every existing user picks up the same 8s behavior
--    they already had, with nothing to backfill.
--
-- 2. undo_expires_at (ayzen_mailbox_messages) — Phase 1's undo affordance
--    only ever lived in the toast that popped up at send time; dismiss it,
--    or reload the tab, and the window was still technically open (the
--    send-queue row was still 'pending' for a few more seconds) but there
--    was no way left in the UI to use it. Stamping the same undoExpiresAt
--    the /send response already computes onto the message row itself means
--    the Outbox list can render its own persistent "Undo (Ns)" chip off
--    ordinary GET /ayzen-email/mailbox data — no extra endpoint, and it
--    survives exactly as long as the underlying send-queue row does.
--    Nullable, same "only meaningful while folder === 'outbox'" convention
--    scheduledSendAt/snoozedUntil already follow — cleared the moment the
--    message leaves outbox for any reason (sent, undone, or given up on
--    after MAX_SEND_ATTEMPTS).

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mail_undo_send_window_ms integer NOT NULL DEFAULT 8000;

ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS undo_expires_at timestamp;

-- No DB-level CHECK constraint on mail_undo_send_window_ms (kept idempotent
-- for the startup-migration array in index.ts, same reasoning as
-- migrations/015's digest_frequency). Valid values (5000 | 10000 | 20000 |
-- 30000) are enforced in routes/mail-undo-send-settings.ts; a value outside
-- lib/mail-send-queue.ts's MIN/MAX_UNDO_SEND_WINDOW_MS clamp is defensively
-- re-clamped there too, so a hand-edited row can't produce a window longer
-- than the send queue's own claim semantics were designed for.
