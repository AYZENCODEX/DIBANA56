-- 016_vault_attachments.sql
-- Feature 12: Document/File Attachments — encrypted file storage per Vault
-- entity (ID scan, contract, screenshot, etc). See
-- lib/db/src/schema/vault-attachments.ts for the full design note.

CREATE TABLE IF NOT EXISTS vault_attachments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  vault_entry_id INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  note TEXT,
  encrypted_content TEXT NOT NULL,
  uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS vault_attachments_entry_idx ON vault_attachments(vault_entry_id);
CREATE INDEX IF NOT EXISTS vault_attachments_user_idx ON vault_attachments(user_id);
