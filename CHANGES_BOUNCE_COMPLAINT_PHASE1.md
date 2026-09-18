# Bounce + Complaint Handling — Phase 1 (detection, recording, notification)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Undo Send Phase 1+2, now with Bounce + Complaint Handling Phase 1 merged on
top) — extract and overwrite your project, nothing left to hand-patch.

## The problem this fixes

Delivery Tracking (migration 050) already flips a message's `deliveryStatus`
to `bounced` off Resend's `email.bounced` webhook event — but that was the
whole story. There was no equivalent for `email.complained` (a recipient
marking the mail as spam — silently logged and dropped), no way to tell a
one-off bounce from an address that keeps bouncing, no user-facing
notification for either, and nothing remembering which recipient addresses
have turned problematic so a future send could be warned or limited.

## The pipeline (from the spec)

```
Send
 ↓
Provider
 ↓
 ├─ Delivered ✅
 ├─ Bounced ❌
 └─ Complaint 🚨
```

Phase 1 covers the left-hand side of this — detecting bounce/complaint,
updating message status, notifying the user, flagging the problematic
address, and tracking repeated failures. The right-hand side — actually
warning or limiting a *future* send to a flagged/blocked address — is
Phase 2 (see below); Phase 1 lays down everything Phase 2 needs to act on.

## New

- **`migrations/052_ayzen_mailbox_bounce_complaint.sql`** —
  - `ayzen_mailbox_recipient_reputation`: one row per (user, recipient
    email), the outbound mirror of migration 046's sender-reputation table
    for inbound. `status` ('ok' | 'flagged' | 'blocked'), `bounce_count` /
    `consecutive_bounces`, `complaint_count`, and the timestamps behind
    them.
  - `ayzen_mailbox_messages.complained_at` — nullable, no default, no
    backfill, same convention as `bounce_reason`.
- **`lib/mail-recipient-reputation.ts`** — the logic behind that table,
  same "fixed thresholds, not a scored classifier" spirit as
  `lib/mail-spam.ts`:
  - `recordBounce()` — bumps `bounce_count` and the `consecutive_bounces`
    streak; flags the address once the streak hits 3 (a single bounce is
    often transient — mailbox full, receiving server hiccup — so this
    waits for a pattern, not one blip).
  - `recordComplaint()` — always escalates straight to `blocked`, even on
    the first complaint. Unlike bounces, one spam complaint is treated as
    a hard, unambiguous signal — the same way real ESPs/mailbox providers
    suppress an address the moment it complains, no pattern needed.
  - `recordDelivery()` — resets `consecutive_bounces` to 0 on a successful
    delivery to that recipient. "Repeated failures" tracks a *current*
    streak, not a lifetime tally — an address that bounced a few times
    months ago and has delivered cleanly since isn't currently
    problematic.
  - `clearRecipientFlag()` / `getRecipientStatus()` /
    `listProblematicRecipients()` — the read/manual-clear side; also what
    Phase 2's send-time check will call.
- **`GET /ayzen-email/mailbox/problematic-recipients`** — every address
  this user has flagged or blocked, with its counts and timestamps.
- **`DELETE /ayzen-email/mailbox/problematic-recipients/:email`** —
  manually clears a flag/block back to `ok` (resets the counters too, not
  just the status).

## Changed

- **`routes/resend-webhook.ts`** — `handleDeliveryEvent()`:
  - `email.complained` now does real work instead of just a log line:
    stamps `complainedAt` on the message, calls `recordComplaint()`, and
    inserts a `notifications` row ("Spam complaint received") — every
    time, since a complaint is rare enough that each one is worth its own
    notice.
  - `email.bounced` now also calls `recordBounce()` and inserts a
    per-message "Message bounced" notification (every bounce, mirroring
    the complaint branch), plus a second, separate "Recipient address
    flagged" notification the moment `recordBounce()` reports the streak
    just crossed the threshold — so the user gets both "this one email
    failed" and, once it's actually a pattern, "this address is now a
    problem" as two distinct pieces of information rather than one
    conflated with the other.
  - `email.delivered` now also calls `recordDelivery()` to reset that
    recipient's bounce streak.
- **`routes/ayzen-mailbox.ts`** — `fmt()` now returns `complainedAt`;
  added the two `problematic-recipients` routes above (registered ahead of
  `GET /:id`, same routing-order reason `/senders` already is).
- **`lib/db/src/schema/ayzen-mailbox.ts`** — added
  `ayzenMailboxRecipientReputationTable` + `AYZEN_RECIPIENT_STATUSES`, and
  `complainedAt` on `ayzenMailboxMessagesTable`.
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — a message that's been
  reported as spam now shows an amber "Marked as spam by recipient" panel
  in the expanded view (separate from, and shown alongside, the existing
  red "Message bounced" panel — a complained message was still delivered,
  so both can legitimately be true), plus a small "Spam report" badge next
  to the existing delivery-status badge in both message-list views.

## Not done here (Phase 2)

- **Enforcement at send time.** Phase 1 only records and notifies —
  `POST /send` doesn't yet call `getRecipientStatus()` before sending, so
  nothing today actually stops or warns about a send to a flagged/blocked
  address. That's the entire point of Phase 2: a confirm-to-proceed dialog
  for `flagged`, a hard block (or admin-configurable soft limit) for
  `blocked`.
- **A Settings screen for the problematic-recipients list.** The backend
  routes exist (`GET`/`DELETE /problematic-recipients`) but nothing in the
  frontend calls them yet outside the per-message badges — a dedicated
  "Problematic addresses" page (mirroring the existing Block/Allow sender
  list screens) is Phase 2.
- **Account-level complaint-rate health.** Phase 1 tracks reputation per
  recipient, not an aggregate view of *this user's* overall bounce/
  complaint rate (which is what actually threatens Resend/domain sending
  reputation) — a dashboard or automatic sending pause if a user's own
  rate crosses a threshold is Phase 2 scope, not Phase 1.
- **Digest/rollup notifications.** Every bounce and every complaint fires
  its own notification right now; a high-volume sender could get noisy.
  Batching into a daily digest once volume crosses some threshold is a
  Phase 2 nice-to-have, not required for Phase 1 correctness.

## Before running

- Run migration 052.
- No new env vars — reuses the same Resend webhook endpoint and
  `RESEND_WEBHOOK_SECRET` Delivery Tracking already relies on.
- Confirm your Resend webhook config actually sends `email.complained` (and
  still `email.bounced`/`email.delivered`) to the same endpoint already
  registered — Resend lets you pick which event types a given webhook
  subscribes to, so if `email.complained` was never ticked, complaints
  will just never arrive here.
