-- 052_ayzen_mailbox_bounce_complaint.sql
-- Bounce + Complaint Handling (Phase 1) — see CHANGES_BOUNCE_COMPLAINT_PHASE1.md.
--
-- Two things:
--
--   1. ayzen_mailbox_messages.complained_at — a spam-complaint arrives via
--      Resend's `email.complained` webhook event, same delivery pipeline
--      migration 050's deliveryStatus already listens on, but a complaint
--      is a *separate* signal from bounced/delivered (Resend fires it any
--      time after email.delivered, once the recipient hits "mark as spam"
--      in their own mail client — it does not replace or follow a bounce).
--      Kept as its own nullable timestamp rather than folded into
--      delivery_status for exactly the reason 050's own comment gives for
--      not mapping email.complained to a status in the first place: a
--      complained message was still delivered, so overwriting
--      delivery_status = 'delivered' with something else would lose that.
--
--   2. ayzen_mailbox_recipient_reputation — one row per (user, recipient
--      email), the outbound mirror of migration 046's
--      ayzen_mailbox_sender_reputation for inbound. Fed by
--      routes/resend-webhook.ts's bounce/complaint/delivered handling via
--      lib/mail-recipient-reputation.ts:
--
--        * bounce_count / consecutive_bounces — every email.bounced event
--          for this (user, recipient) increments both; consecutive_bounces
--          resets to 0 on the next email.delivered for that same recipient
--          (repeated *failures* is the signal — an address that bounced
--          once months ago and has delivered fine since isn't
--          problematic). bounce_count never resets — it's the lifetime
--          count shown alongside the flag.
--        * complaint_count / last_complaint_at — every email.complained
--          event increments this. Unlike bounces, a single complaint is
--          enough to flag (industry-standard suppression-list practice —
--          see lib/mail-recipient-reputation.ts), so there's no
--          "consecutive" counter for complaints.
--        * status — 'ok' | 'flagged' | 'blocked'. 'flagged' = repeated
--          bounces (>= BOUNCE_FLAG_THRESHOLD consecutive), 'blocked' = at
--          least one spam complaint, or a user manually blocking the
--          address. Phase 1 only *records* this; Phase 2 is what makes
--          POST /send actually consult it before sending.
--        * flagged_at — when status last moved off 'ok', so the frontend
--          can show "flagged 3 days ago" instead of just a bare flag.
CREATE TABLE IF NOT EXISTS ayzen_mailbox_recipient_reputation (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  bounce_count INTEGER NOT NULL DEFAULT 0,
  consecutive_bounces INTEGER NOT NULL DEFAULT 0,
  complaint_count INTEGER NOT NULL DEFAULT 0,
  last_bounce_at TIMESTAMP,
  last_complaint_at TIMESTAMP,
  last_delivered_at TIMESTAMP,
  flagged_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One reputation row per (user, recipient) — same convention as migration
-- 046's sender-reputation unique index.
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_recipient_reputation_user_email_idx
  ON ayzen_mailbox_recipient_reputation (user_id, lower(email));

-- Powers a future "problematic recipients" list screen without scanning
-- every neutral recipient a user has ever emailed.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_recipient_reputation_status_idx
  ON ayzen_mailbox_recipient_reputation (user_id, status)
  WHERE status != 'ok';

-- Nullable, no default, no backfill — same convention as delivery_status /
-- bounce_reason in migration 050. Only ever set on outbound rows going
-- forward.
ALTER TABLE ayzen_mailbox_messages ADD COLUMN IF NOT EXISTS complained_at TIMESTAMP;
