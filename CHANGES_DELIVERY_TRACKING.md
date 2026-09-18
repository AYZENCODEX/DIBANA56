# What's new in this drop (outbound delivery tracking)

This zip is your FULL codebase (send-queue Phase 1 + 2, now with Delivery
Tracking merged on top) — extract and overwrite your project, nothing left
to hand-patch.

## The problem this fixes

Before this, an outbound message's only visible state was `folder`
(outbox → sent, or outbox → drafts on give-up) — accurate for *where* the
message lives, but no way to show a user whether their email is still in
flight, was accepted by the receiving mail server, actually landed in the
inbox, or bounced.

## The pipeline

```
Queued → Sending → Accepted → Delivered → Bounced / Failed
```

- `queued` / `sending` / `accepted` / `failed` are set by
  `lib/mail-send-queue.ts` (Phase 1/2's own worker) — it's the only place
  that knows a send is about to be attempted, actually succeeded, or has
  been given up on.
- `delivered` / `bounced` only ever come from Resend's own outbound
  webhook events (`email.delivered` / `email.bounced`), handled by
  `routes/resend-webhook.ts`.

## New / changed files

- **`migrations/050_ayzen_mailbox_delivery_tracking.sql`** — new:
  `delivery_status`, `delivery_status_at`, `bounce_reason` on
  `ayzen_mailbox_messages` (nullable, no default, no backfill — same
  convention as `idempotency_key`); partial index on
  `(user_id, delivery_status) WHERE direction = 'outbound' AND
  delivery_status IS NOT NULL`.
- **`lib/db/src/schema/ayzen-mailbox.ts`** — added `deliveryStatus`,
  `deliveryStatusAt`, `bounceReason` to `ayzenMailboxMessagesTable`. This
  was the one piece missing from the drop: migration 050 and every
  consumer (webhook, send-queue, route, frontend) already assumed these
  columns existed on the Drizzle table, but the schema itself was never
  updated to match, so nothing referencing them would have type-checked.
- **`routes/resend-webhook.ts`** — now dispatches on `event.type` for
  both inbound mail (`email.received`, unchanged) and the new outbound
  lifecycle events. `email.sent → accepted`, `email.delivered →
  delivered`, `email.bounced → bounced` (+ reason, hedged across a few
  possible Resend payload shapes); `email.delivery_delayed` /
  `email.complained` are logged via `logBus` but don't touch
  `deliveryStatus`. A `STATUS_RANK` guard stops an out-of-order webhook
  from regressing an already-`delivered` message back to `accepted`.
  Deduped on the `svix-id` header (not `data.email_id` — the same
  outbound email fires multiple event types over its lifetime, so
  `email_id` can't be the dedup key here the way it is for inbound).
- **`lib/mail-send-queue.ts`** — `processQueueRow()` now also drives
  `deliveryStatus`: `sending` the instant a row is claimed (before the
  Resend call, so a slow/hung call shows "Sending" rather than lingering
  on "Queued"), `accepted` on success, `queued` on a retryable failure,
  `failed` on final give-up (same moment the message drops to Drafts).
- **`routes/ayzen-mailbox.ts`** — `POST /send` (both the immediate-send
  and Scheduled Send branches) sets `deliveryStatus: 'queued'` at insert
  time; the message serializer now includes `deliveryStatus` /
  `deliveryStatusAt` / `bounceReason` on every returned row.
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — `DELIVERY_STATUS_META`
  badge (icon + label) shown on outbound messages wherever `deliveryStatus`
  is known; a dedicated "Message bounced" panel (with reason, when Resend
  gave one) in the expanded message view, distinct from the existing
  send-queue-gave-up panel — one means Resend never got the message at
  all, the other means Resend accepted it but the recipient's server later
  rejected it.

## Before running

- Run migration 050.
- No new env vars. Uses the same `RESEND_WEBHOOK_SECRET` / signing setup
  the inbound webhook already relies on — no separate secret for the
  outbound events, since it's the same webhook URL and endpoint.
- Confirm your Resend webhook config actually sends the outbound events
  (`email.sent`, `email.delivered`, `email.bounced` — optionally
  `email.delivery_delayed` / `email.complained`) to the same endpoint
  already registered for `email.received`. Resend lets you pick which
  event types a given webhook subscribes to; if only inbound was ticked
  originally, delivered/bounced will just never arrive.
