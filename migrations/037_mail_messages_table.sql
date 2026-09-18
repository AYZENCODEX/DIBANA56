-- 037_mail_messages_table.sql
-- Bug fix (unrelated to native mailbox work, found while auditing the mail
-- code): routes/email-accounts.ts, lib/mail-sync.ts and lib/imap-fetch.ts
-- all read/write a `mail_messages` table via raw SQL, but no migration or
-- Drizzle schema for that table exists anywhere in the codebase — every
-- IMAP "Email Manager" sync/search/read call has been failing against a
-- table that was never created. This creates it to match exactly what that
-- code already expects.

CREATE TABLE IF NOT EXISTS mail_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  source_category TEXT NOT NULL DEFAULT 'other', -- 'entity' | 'local' | 'kyc' | 'game' | 'other'
  source_id TEXT,
  uid INTEGER NOT NULL,
  seqno INTEGER,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  message_date TIMESTAMP,
  body_text TEXT, -- encrypted at rest via lib/vault-crypto encryptField, filled lazily on first open
  fetched_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  search_vector TSVECTOR
);

CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_account_uid_key ON mail_messages (email_account_id, uid);
CREATE INDEX IF NOT EXISTS mail_messages_user_idx ON mail_messages (user_id, message_date DESC);
CREATE INDEX IF NOT EXISTS mail_messages_search_idx ON mail_messages USING GIN (search_vector);

CREATE OR REPLACE FUNCTION mail_messages_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.subject, '') || ' ' || coalesce(NEW.from_addr, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mail_messages_search_update ON mail_messages;
CREATE TRIGGER mail_messages_search_update
  BEFORE INSERT OR UPDATE ON mail_messages
  FOR EACH ROW EXECUTE FUNCTION mail_messages_search_trigger();
