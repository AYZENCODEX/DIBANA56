-- 044_ayzen_mailbox_attachment_search.sql
-- Supports the new GET /ayzen-email/mailbox/attachments/search route
-- (Attachment System 2.0) — no new columns, just indexes so filename
-- search and the join back to the owning message stay fast as a mailbox's
-- attachment count grows.

-- The search route joins attachments -> messages on message_id and filters
-- messages by user_id; this index makes that join an index lookup instead
-- of a sequential scan of ayzen_mailbox_attachments.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_attachments_message_id_idx
  ON ayzen_mailbox_attachments (message_id);

-- ILIKE '%q%' can't use a plain btree for the leading wildcard, but
-- lower(filename) still helps the common case (a suffix/whole-word match
-- via pg_trgm isn't available on every Postgres install, so we keep this
-- dependency-free) and keeps a covering index Postgres can use for the
-- filename equality/prefix portion of a query plan.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_attachments_filename_lower_idx
  ON ayzen_mailbox_attachments (lower(filename));
