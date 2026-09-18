-- 054_ayzen_mailbox_notification_digest.sql
-- Bounce + Complaint Handling (Phase 4) — see CHANGES_BOUNCE_COMPLAINT_PHASE4.md.
--
-- Phase 1 made every single bounce/complaint fire its own notification.
-- Fine for an occasional bounce, noisy for a high-volume sender having a
-- genuinely bad stretch — exactly the situation Phase 3's account pause
-- already detects, so this reuses that same per-user row
-- (ayzen_mailbox_sending_health) rather than adding a new table:
--
--   * burst_notif_count / burst_window_started_at — how many INDIVIDUAL
--     bounce/complaint notifications this user has had in the current
--     short burst window (digest_burst_minutes below, default 15). Once
--     that count crosses digest_trigger_count (default 5), further
--     events in the same burst stop notifying individually and instead
--     accumulate into:
--   * digest_pending_bounces / digest_pending_complaints — counted but
--     not yet notified about individually.
--   * last_digest_sent_at — when a batched summary notification last
--     went out for this user, cleared back to 0 pending afterward. Purely
--     informational (shown in the Settings health widget) — the flush
--     cadence itself is just "the digest cron's tick", not gated on this
--     column, since a fixed-interval cron already controls cadence.
--
-- lib/mail-notification-digest.ts is what reads/writes these; see that
-- file for the actual burst/flush logic.
ALTER TABLE ayzen_mailbox_sending_health ADD COLUMN IF NOT EXISTS burst_notif_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ayzen_mailbox_sending_health ADD COLUMN IF NOT EXISTS burst_window_started_at TIMESTAMP;
ALTER TABLE ayzen_mailbox_sending_health ADD COLUMN IF NOT EXISTS digest_pending_bounces INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ayzen_mailbox_sending_health ADD COLUMN IF NOT EXISTS digest_pending_complaints INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ayzen_mailbox_sending_health ADD COLUMN IF NOT EXISTS last_digest_sent_at TIMESTAMP;

-- Admin-tunable (same singleton row Phase 3 already added thresholds to).
-- Flush CADENCE itself is env-var-driven (MAIL_DIGEST_CRON), same as the
-- existing Scheduled Send backstop's MAIL_SCHEDULE_CRON — a live
-- node-cron schedule can't be re-read from the DB without a process
-- restart, so there's deliberately no digest_flush_minutes column here;
-- these two are the actual per-event decision the digest logic makes.
ALTER TABLE ayzen_mailbox_sending_config ADD COLUMN IF NOT EXISTS digest_trigger_count INTEGER NOT NULL DEFAULT 5;
ALTER TABLE ayzen_mailbox_sending_config ADD COLUMN IF NOT EXISTS digest_burst_minutes INTEGER NOT NULL DEFAULT 15;

-- Powers the digest cron's sweep: "which users actually have something
-- pending to flush right now" without scanning every sending-health row.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_sending_health_pending_digest_idx
  ON ayzen_mailbox_sending_health (user_id)
  WHERE digest_pending_bounces > 0 OR digest_pending_complaints > 0;
