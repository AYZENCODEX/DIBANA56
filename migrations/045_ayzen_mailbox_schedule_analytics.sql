-- 045_ayzen_mailbox_schedule_analytics.sql
-- Three independent additions bundled together since they shipped in the
-- same pass: Scheduled Send, Mail Analytics, and Contact Intelligence.
--
-- Scheduled Send needs a 7th first-class folder ('scheduled', same
-- exclusive-folder model as spam/snoozed before it — no new column for the
-- folder value itself) plus two columns that are only meaningful while a
-- message sits in that folder: scheduled_send_at (when
-- lib/mail-schedule-cron.ts should fire it) and schedule_attempts (how many
-- times the cron has already tried and failed, so it can give up after
-- MAX_SCHEDULE_ATTEMPTS instead of retrying a permanently-broken send
-- forever — see lib/mail-schedule-cron.ts).
--
-- Mail Analytics and Contact Intelligence's "attachments/emails exchanged"
-- counts read off the existing ayzen_mailbox_messages/attachments tables
-- directly — no new columns needed there.
--
-- Contact Intelligence's "Add contact" button needs its own table
-- (ayzen_contacts): a saved, user-named pin on an address, distinct from
-- the mailbox's own on-the-fly correspondent lookup (GET
-- /mailbox/contacts/:email), which works for any address that's ever
-- appeared in mail whether or not it's saved here.

ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS scheduled_send_at TIMESTAMP;
ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS schedule_attempts INTEGER NOT NULL DEFAULT 0;

-- The cron sweep's own query (WHERE folder = 'scheduled' AND
-- scheduled_send_at <= now()) — a partial index scoped to the folder this
-- runs on every minute, rather than a full index over every message's
-- (mostly-null) scheduled_send_at.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_scheduled_due_idx
  ON ayzen_mailbox_messages (scheduled_send_at)
  WHERE folder = 'scheduled';

CREATE TABLE IF NOT EXISTS ayzen_contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One saved contact per (user, address) — re-saving the same address just
-- means "already a contact" rather than piling up duplicate rows.
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_contacts_user_email_idx
  ON ayzen_contacts (user_id, lower(email));
