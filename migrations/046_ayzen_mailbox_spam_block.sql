-- 046_ayzen_mailbox_spam_block.sql
-- Sender reputation for the native mailbox's Spam + Block feature. One row
-- per (user, sender email), since Block/Allow sender, "Mark spam"
-- reporting, and basic inbound rate control all read/write the same
-- per-sender state and are always touched together — no reason to split
-- them into separate tables.
--
--   * status        — 'neutral' | 'blocked' | 'allowed'. Set by
--                      POST /mailbox/senders/block and /allow
--                      (routes/ayzen-mailbox.ts). Consulted by
--                      lib/mail-spam.ts evaluateInboundReputation(), called
--                      from routes/resend-webhook.ts before a new inbound
--                      message is stored: 'blocked' senders' mail is filed
--                      straight into Spam, 'allowed' senders always land in
--                      Inbox and skip the heuristics below.
--   * spam_reports   — how many times this user has hit "Mark spam" on a
--                      message from this sender. Once it crosses
--                      AUTO_SPAM_REPORT_THRESHOLD (lib/mail-spam.ts), this
--                      sender's *future* inbound auto-routes to Spam too,
--                      even without an explicit Block.
--   * received_in_window / window_started_at — basic flood control: counts
--                      inbound messages from this sender inside a rolling
--                      window (lib/mail-spam.ts RATE_WINDOW_MS); crossing
--                      RATE_LIMIT_MAX_PER_WINDOW auto-routes to Spam too.
--                      Self-resetting (checked/reset on each inbound
--                      message), so this needs no cron sweep of its own.
CREATE TABLE IF NOT EXISTS ayzen_mailbox_sender_reputation (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'neutral',
  spam_reports INTEGER NOT NULL DEFAULT 0,
  received_in_window INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMP,
  last_received_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One reputation row per (user, sender) — re-blocking/re-allowing/re-seeing
-- mail from the same address updates this row rather than piling up dupes.
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_sender_reputation_user_email_idx
  ON ayzen_mailbox_sender_reputation (user_id, lower(email));

-- Powers GET /mailbox/senders?status=blocked|allowed (the Block/Allow list
-- screens) without scanning every neutral sender a user has ever received
-- mail from.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_sender_reputation_status_idx
  ON ayzen_mailbox_sender_reputation (user_id, status)
  WHERE status != 'neutral';
