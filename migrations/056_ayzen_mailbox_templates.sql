-- 056_ayzen_mailbox_templates.sql
-- Compose Templates ("canned responses") for the native ayzen.tech mailbox.
--
-- A user can save any number of named templates (subject + rich-text body)
-- and insert one into the compose box (New Message, Reply, or Forward) via
-- a picker, or save the message currently being composed as a new template.
-- Distinct from the single per-user signature already on users.* — that one
-- auto-inserts into every fresh message; templates are picked explicitly,
-- and there can be many of them (an invoice-follow-up template, an
-- onboarding-email template, etc).
--
-- body_html is stored as plaintext TEXT here (same as every other schema
-- column in this file) but is written/read through encryptField/
-- decryptField in routes/ayzen-mailbox.ts, exactly like
-- ayzen_mailbox_messages.text_body/html_body — see that table's comment in
-- lib/db/src/schema/ayzen-mailbox.ts for why (arbitrary user-authored
-- content, same sensitivity as a mail body).
CREATE TABLE IF NOT EXISTS ayzen_mailbox_templates (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject TEXT,
  body_html TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One name per user, case-insensitive — same shape as
-- ayzen_mailbox_labels_user_name_key, so "Follow up" and "follow up" can't
-- coexist and the picker never shows two entries a user can't tell apart.
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_templates_user_name_key
  ON ayzen_mailbox_templates (user_id, lower(name));

-- Backs both "list my templates" (picker + manage dialog) and ordering by
-- most-recently-updated first.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_templates_user_idx
  ON ayzen_mailbox_templates (user_id, updated_at DESC);
