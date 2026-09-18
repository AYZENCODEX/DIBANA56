-- 041_ayzen_mailbox_compose_upgrade.sql
-- Compose upgrade for the native ayzen.tech mailbox: Bcc, a per-user
-- signature, and a rich (HTML) editor for the compose box.
--   - bcc_addr: mirrors cc_addr — stored on the message row so a sent/draft
--     message can show the sender who they Bcc'd; never sent back out to
--     other recipients (Bcc is stripped from what they see by definition —
--     Resend just needs it on the one outbound API call).
--   - ayzen_mailbox_signature: raw HTML signature the compose box inserts
--     into new messages (not replies/forwards, same as Gmail's default).
--   - ayzen_mailbox_signature_enabled: lets a user keep a saved signature
--     around but turn off auto-insertion without deleting it.

ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS bcc_addr TEXT;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ayzen_mailbox_signature TEXT,
  ADD COLUMN IF NOT EXISTS ayzen_mailbox_signature_enabled BOOLEAN NOT NULL DEFAULT true;
