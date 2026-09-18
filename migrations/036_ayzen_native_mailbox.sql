-- 036_ayzen_native_mailbox.sql
-- Adds a real, stored mailbox for username@ayzen.tech addresses, instead of
-- Cloudflare Email Routing's forward-only behaviour (see
-- 035_ayzen_email_verification.sql / routes/email-routing.ts).
--
-- Design: inbound mail for ayzen.tech is now received via Resend's Inbound
-- feature (MX -> Resend, email.received webhook -> routes/resend-webhook.ts)
-- instead of Cloudflare Email Routing. Cloudflare stays the DNS host (zone),
-- and its Email Routing forwarding rules keep working unmodified for any
-- user still in "forward" mode. A user can only be in one mode at a time —
-- see ayzen_email_mode below — because a domain's MX records can only point
-- at one mail system. Users who switch to "native" get a real inbox stored
-- here; if they also keep ayzen_email_forward_to set, the inbound webhook
-- relays a copy out via Resend send, so "routing" behavior is preserved on
-- top of native storage rather than replaced.

ALTER TABLE users ADD COLUMN IF NOT EXISTS ayzen_email_mode TEXT NOT NULL DEFAULT 'forward';
-- 'forward' = legacy Cloudflare Email Routing forward-only (unchanged)
-- 'native'  = mail is received + stored in ayzen_mailbox_messages below

CREATE TABLE IF NOT EXISTS ayzen_mailbox_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL DEFAULT 'inbound', -- 'inbound' | 'outbound'
  resend_email_id TEXT,       -- Resend's id for this email (inbound or outbound send)
  message_id TEXT,            -- RFC 5322 Message-ID header, for threading
  in_reply_to TEXT,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  cc_addr TEXT,
  subject TEXT,
  text_body TEXT,             -- encrypted at rest via lib/vault-crypto encryptField
  html_body TEXT,             -- encrypted at rest via lib/vault-crypto encryptField
  has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  is_starred BOOLEAN NOT NULL DEFAULT FALSE,
  forwarded_to TEXT,           -- set if this inbound mail was also relayed to ayzen_email_forward_to
  deleted_at TIMESTAMP,
  received_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  search_vector TSVECTOR
);

CREATE UNIQUE INDEX IF NOT EXISTS ayzen_mailbox_messages_resend_email_id_key
  ON ayzen_mailbox_messages (resend_email_id) WHERE resend_email_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_user_idx ON ayzen_mailbox_messages (user_id, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_search_idx ON ayzen_mailbox_messages USING GIN (search_vector);

CREATE OR REPLACE FUNCTION ayzen_mailbox_messages_search_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := to_tsvector('english', coalesce(NEW.subject, '') || ' ' || coalesce(NEW.from_addr, '') || ' ' || coalesce(NEW.to_addr, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ayzen_mailbox_messages_search_update ON ayzen_mailbox_messages;
CREATE TRIGGER ayzen_mailbox_messages_search_update
  BEFORE INSERT OR UPDATE ON ayzen_mailbox_messages
  FOR EACH ROW EXECUTE FUNCTION ayzen_mailbox_messages_search_trigger();

CREATE TABLE IF NOT EXISTS ayzen_mailbox_attachments (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES ayzen_mailbox_messages(id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  resend_attachment_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ayzen_mailbox_attachments_message_idx ON ayzen_mailbox_attachments (message_id);

-- Idempotency guard for the inbound webhook — Resend/Svix can redeliver the
-- same event, and the unique index above already protects the message row,
-- but we also record every event id seen so retries short-circuit before
-- doing any Resend API calls at all.
CREATE TABLE IF NOT EXISTS resend_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT,
  received_at TIMESTAMP NOT NULL DEFAULT NOW()
);
