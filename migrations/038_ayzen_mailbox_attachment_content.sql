-- 038_ayzen_mailbox_attachment_content.sql
-- Extends the native mailbox (036) so OUTBOUND attachments (the ones a user
-- uploads when composing/sending mail) are actually retrievable afterwards.
--
-- Inbound attachments deliberately stay metadata-only in
-- ayzen_mailbox_attachments and are fetched on demand from Resend via
-- resend_attachment_id (see lib/resend-mail.ts getInboundAttachmentContent) —
-- but outbound attachments have no Resend-side id to re-fetch from later, so
-- their base64 bytes need to be stored here (encrypted, same pattern as
-- vault_attachments.encryptedContent) at send time or a sent mail's
-- attachment becomes undownloadable the moment the compose request ends.

ALTER TABLE ayzen_mailbox_attachments ADD COLUMN IF NOT EXISTS encrypted_content TEXT;
