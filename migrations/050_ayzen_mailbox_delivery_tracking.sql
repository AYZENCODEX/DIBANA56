-- 050_ayzen_mailbox_delivery_tracking.sql
-- Delivery Tracking for the native mailbox's outbound mail.
--
-- Before this, an outbound message's only visible state was `folder`
-- (outbox -> sent, or outbox -> drafts on give-up) — accurate for where the
-- message lives, but it collapses everything Resend actually tells us
-- about the send into a single "sent" folder move, with no way to show a
-- user whether their email is still in flight, was accepted by the
-- receiving mail server, actually landed in the inbox, or bounced.
--
-- delivery_status gives that finer pipeline, populated from two different
-- places depending on the stage:
--   'queued'    — set the moment a message is created for sending (both the
--                 immediate-send transaction and the Scheduled Send branch
--                 in routes/ayzen-mailbox.ts), and again if a failed
--                 attempt goes back to the queue for retry.
--   'sending'   — set by lib/mail-send-queue.ts's processQueueRow() the
--                 instant it claims the row and starts the actual Resend
--                 call.
--   'accepted'  — set by the same function once that Resend call succeeds
--                 (same moment folder flips to 'sent'). This is Resend
--                 confirming it queued the email for delivery — not
--                 confirmation the recipient's server has it yet.
--   'delivered' — set by routes/resend-webhook.ts on Resend's own
--                 email.delivered event, i.e. the recipient's mail server
--                 actually accepted it.
--   'bounced'   — set by routes/resend-webhook.ts on Resend's email.bounced
--                 event; bounce_reason carries whatever detail Resend sent.
--   'failed'    — set by lib/mail-send-queue.ts when the queue gives up
--                 after MAX_SEND_ATTEMPTS (same moment folder drops back to
--                 'drafts'). Distinct from 'bounced': this is our own send
--                 attempt never reaching Resend successfully at all, not a
--                 rejection by the recipient's server.
--
-- Nullable, no default: only ever set on outbound rows going forward.
-- Inbound mail and outbound rows sent before this migration stay null —
-- same "don't backfill, just start tracking from here" convention as
-- idempotency_key in migration 049.
ALTER TABLE ayzen_mailbox_messages
  ADD COLUMN IF NOT EXISTS delivery_status TEXT,
  ADD COLUMN IF NOT EXISTS delivery_status_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS bounce_reason TEXT;

-- Powers "show me everything that bounced" / "what's still in flight"
-- views without a full table scan. Partial + scoped to outbound since
-- inbound rows never set delivery_status at all.
CREATE INDEX IF NOT EXISTS ayzen_mailbox_messages_delivery_status_idx
  ON ayzen_mailbox_messages (user_id, delivery_status)
  WHERE direction = 'outbound' AND delivery_status IS NOT NULL;
