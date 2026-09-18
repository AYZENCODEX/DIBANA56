-- 039_ayzen_mailbox_folders.sql
-- Full folder system for the native ayzen.tech mailbox (036_ayzen_native_mailbox.sql):
-- adds Drafts, Archive, and Trash as real folders (Trash replaces the old
-- deleted_at soft-delete, which just hid a message with no way to see or
-- restore it) plus user-created custom folders.

CREATE TABLE IF NOT EXISTS ayzen_mailbox_folders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
-- Case-insensitive uniqueness per user so "Clients" and "clients" can't both exist.
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_folders_user_name_key
  ON ayzen_mailbox_folders (user_id, lower(name));

ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'inbox',
  ADD COLUMN IF NOT EXISTS folder_id INTEGER REFERENCES ayzen_mailbox_folders(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_draft BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill existing rows: previously the only signals were `direction` and
-- `deleted_at`, so reconstruct folder from those. Order matters — trash
-- check first since a deleted outbound message should land in Trash, not Sent.
UPDATE ayzen_mailbox_messages SET folder = 'trash'
  WHERE deleted_at IS NOT NULL AND folder = 'inbox';
UPDATE ayzen_mailbox_messages SET folder = 'sent'
  WHERE direction = 'outbound' AND deleted_at IS NULL AND folder = 'inbox';

CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_folder_idx
  ON ayzen_mailbox_messages (user_id, folder, created_at DESC);
CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_folder_id_idx
  ON ayzen_mailbox_messages (folder_id) WHERE folder_id IS NOT NULL;

-- The old (user_id, direction, created_at) index from 036 is now redundant
-- with the folder index above for every query routes/ayzen-mailbox.ts makes;
-- drop it to avoid maintaining two overlapping indexes on every write.
DROP INDEX IF EXISTS ayzen_mailbox_messages_user_idx;
