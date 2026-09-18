-- 043_ayzen_mailbox_spam_snooze.sql
-- Adds Spam and Snoozed as first-class system folders on top of the folder
-- system from 039_ayzen_mailbox_folders.sql.
--
-- Spam needs no new column — it's just a 6th value the existing `folder`
-- text column already accepts ('spam'), same as archive/trash before it.
--
-- Snooze needs one: snoozed_until. A snoozed message physically moves into
-- folder = 'snoozed' (same exclusive-folder model the schema already uses
-- for trash/archive — see lib/db/src/schema/ayzen-mailbox.ts) and carries
-- the timestamp it's due back. routes/ayzen-mailbox.ts sweeps expired rows
-- (folder = 'snoozed' AND snoozed_until <= now()) back to 'inbox' on every
-- mailbox read for that user — no cron job needed.

ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMP;

-- Powers both the sweep (find expired snoozes for a user fast) and the
-- Snoozed folder's own list view (ordered by when each message is due
-- back, not by created_at like every other folder).
CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_snoozed_idx
  ON ayzen_mailbox_messages (user_id, snoozed_until)
  WHERE folder = 'snoozed';
