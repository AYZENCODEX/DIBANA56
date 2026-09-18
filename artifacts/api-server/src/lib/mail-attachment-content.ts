/**
 * lib/mail-attachment-content.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracted out of routes/ayzen-mailbox.ts so lib/mail-schedule-cron.ts can
 * resolve a Scheduled Send message's attachments the exact same way the
 * immediate-send route and the attachment-download routes already do,
 * instead of duplicating (and risking drifting) the outbound/inbound branch
 * logic in a second place.
 */
import { ayzenMailboxAttachmentsTable, ayzenMailboxMessagesTable } from "@workspace/db";
import { getResendConfig, getInboundAttachmentContent } from "./resend-mail";
import { decryptField } from "./vault-crypto";

// Outbound attachments were stored (encrypted) at send/draft time; inbound
// ones are fetched from Resend on demand via the parent message's
// resendEmailId, since we never duplicate inbound bytes into our own store.
// Throws on failure — callers turn that into the appropriate HTTP response
// (routes/ayzen-mailbox.ts) or a scheduling failure/retry (mail-schedule-cron.ts).
export async function resolveAttachmentContent(
  message: typeof ayzenMailboxMessagesTable.$inferSelect,
  attachment: typeof ayzenMailboxAttachmentsTable.$inferSelect,
): Promise<{ filename: string; contentType: string; dataBase64: string }> {
  let filename = attachment.filename ?? "attachment";
  let contentType = attachment.contentType ?? "application/octet-stream";

  if (attachment.encryptedContent) {
    // Outbound — bytes are ours, just decrypt.
    return { filename, contentType, dataBase64: decryptField(attachment.encryptedContent)! };
  }
  if (attachment.resendAttachmentId && message.resendEmailId) {
    // Inbound — pull from Resend using the parent email's id.
    const cfg = await getResendConfig();
    if (!cfg) throw Object.assign(new Error("Resend Email isn't configured"), { status: 503 });
    const fetched = await getInboundAttachmentContent(cfg, message.resendEmailId, attachment.resendAttachmentId);
    filename = fetched.filename || filename;
    contentType = fetched.contentType || contentType;
    return { filename, contentType, dataBase64: fetched.content };
  }
  throw Object.assign(new Error("Attachment content is unavailable"), { status: 404 });
}
