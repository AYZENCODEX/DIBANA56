-- 042_ayzen_mailbox_labels_filters_rules.sql
-- Adds three things to the native ayzen.tech mailbox, on top of 036-041:
--
--   1. Colored labels — Gmail-style tags a message can carry *in addition*
--      to its folder. Unlike folders (migrations/039), which are exclusive
--      (a message lives in exactly one), a message can carry any number of
--      labels at once, so this is a many-to-many join table rather than a
--      column on ayzen_mailbox_messages.
--   2. Filters — no new schema needed. "Filters" (Unread / Starred / Has
--      attachment / a specific label, combinable with folder + search) are
--      just extra WHERE clauses the list/search routes already support the
--      columns for (is_read, is_starred, has_attachments) or now do via the
--      label join table added here.
--   3. Rules — saved "when an inbound message matches X, do Y" automations
--      (add a label / move to a folder / mark read / star), evaluated once
--      per inbound message right after routes/resend-webhook.ts stores it.

-- ─── Labels ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ayzen_mailbox_labels (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- A key into a fixed palette (lib/mail-labels.ts on the frontend), not a
  -- raw hex value — keeps every label visually consistent with the rest of
  -- the app's dark theme instead of letting users pick colors that don't
  -- have matching bg/border/text Tailwind classes.
  color TEXT NOT NULL DEFAULT 'sky',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_labels_user_name_key
  ON ayzen_mailbox_labels (user_id, lower(name));

CREATE TABLE IF NOT EXISTS ayzen_mailbox_message_labels (
  message_id INTEGER NOT NULL REFERENCES ayzen_mailbox_messages(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES ayzen_mailbox_labels(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, label_id)
);
-- The PK above already indexes (message_id, label_id) for "labels on this
-- message" lookups; this covers the other direction ("messages with this
-- label", used by the label filter and the Labels rail's per-label counts).
CREATE INDEX IF NOT EXISTS ayzen_mailbox_message_labels_label_idx
  ON ayzen_mailbox_message_labels (label_id);

-- ─── Rules ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ayzen_mailbox_rules (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- What to match against. 'from' and 'subject' cover the common cases
  -- ("mail from my bank", "anything with INVOICE in the subject"); 'to'
  -- matters once a user has more than one alias/forward pointing here.
  field TEXT NOT NULL DEFAULT 'from', -- 'from' | 'to' | 'subject'
  match_type TEXT NOT NULL DEFAULT 'contains', -- 'contains' | 'equals'
  value TEXT NOT NULL,
  -- Actions — all optional, all applied together when a rule matches (a
  -- rule can e.g. both label AND archive a message in one shot).
  action_label_id INTEGER REFERENCES ayzen_mailbox_labels(id) ON DELETE SET NULL,
  action_folder TEXT, -- one of AYZEN_MAILBOX_SYSTEM_FOLDERS, 'custom', or NULL (don't move)
  action_folder_id INTEGER REFERENCES ayzen_mailbox_folders(id) ON DELETE SET NULL,
  action_mark_read BOOLEAN NOT NULL DEFAULT FALSE,
  action_star BOOLEAN NOT NULL DEFAULT FALSE,
  -- Evaluation order (ascending). All *matching* rules apply, in this
  -- order, to a single inbound message — later rules' folder moves win if
  -- two rules disagree, but label/star/read actions accumulate.
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ayzen_mailbox_rules_user_idx
  ON ayzen_mailbox_rules (user_id, position);

-- ─── Search ──────────────────────────────────────────────────────────────
-- The search_vector column, GIN index, and trigger already exist from
-- migration 036 — this just widens what the trigger indexes to include Cc
-- and Bcc (useful search targets, and cheap since neither is encrypted).
-- text_body/html_body are NOT indexed and can't be: they're encrypted at
-- rest (lib/vault-crypto encryptField), so there's no plaintext for
-- Postgres to build a tsvector from without decrypting every row up front.
-- Search therefore covers subject/from/to/cc/bcc, not message body text —
-- documented in routes/ayzen-mailbox.ts on the new /mailbox/search route.
CREATE OR REPLACE FUNCTION ayzen_mailbox_messages_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english',
    coalesce(NEW.subject, '') || ' ' ||
    coalesce(NEW.from_addr, '') || ' ' ||
    coalesce(NEW.to_addr, '') || ' ' ||
    coalesce(NEW.cc_addr, '') || ' ' ||
    coalesce(NEW.bcc_addr, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- Backfill existing rows so cc/bcc are searchable retroactively too — the
-- trigger above only fires on future INSERT/UPDATE.
UPDATE ayzen_mailbox_messages SET search_vector = to_tsvector('english',
  coalesce(subject, '') || ' ' || coalesce(from_addr, '') || ' ' ||
  coalesce(to_addr, '') || ' ' || coalesce(cc_addr, '') || ' ' || coalesce(bcc_addr, ''));
