-- 020_finance_attachments.sql
-- Finance module upgrade — Feature: Receipts / Attachments per ledger entry.
-- See lib/db/src/schema/finance.ts for the full design note.

CREATE TABLE IF NOT EXISTS finance_attachments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  entry_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  note TEXT,
  content_base64 TEXT NOT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS finance_attachments_entry_idx ON finance_attachments(entry_id);
CREATE INDEX IF NOT EXISTS finance_attachments_user_idx ON finance_attachments(user_id);
