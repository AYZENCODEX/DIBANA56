# Undo Send — Phase 1 (fixed window, piggybacked on the Send Queue)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Conversation Actions Phase 1+2+3, now with Undo Send Phase 1 merged on
top) — extract and overwrite your project, nothing left to hand-patch.

## The idea

`lib/mail-send-queue.ts`'s worker only ever claims rows where
`next_attempt_at <= now()`. Phase 1/2 of the Send Queue already push that
column forward for retry backoff — so giving a brand-new row a small
forward-dated `next_attempt_at` (instead of "now", the column's default)
opens a window where the send is durably queued but deliberately not yet
claimable. "Undo" is just flipping that row to `cancelled` inside the
window before the worker gets there. No new table, no new column — the
Send Queue (migration 047) already had everything this needed.

## New

- **`PATCH /ayzen-email/mailbox/:id/undo-send`** — the actual undo. Guards
  on the message's `folder === 'outbox'`, then does the real work as an
  atomic `UPDATE ayzen_mailbox_send_queue SET status = 'cancelled' WHERE
  message_id = ? AND status = 'pending'`. If that matches a row, the
  message moves to Drafts (same landing spot `cancel-schedule` and the
  queue's own give-up path already use — one predictable "this didn't go
  out, fix and resend" place regardless of how a send got pulled back) and
  `idempotencyKey` is cleared. If it matches zero rows — the worker already
  claimed it (`status` is `sending`) or it already finished (`sent` /
  `failed`) — returns `409 { code: "UNDO_WINDOW_EXPIRED" }` instead of
  silently doing nothing.

## Changed

- **`lib/mail-send-queue.ts`** — `enqueueSend(tx, messageId, delayMs?)`
  now takes an optional delay (defaults to a new `UNDO_SEND_WINDOW_MS`
  export). `UNDO_SEND_WINDOW_MS` reads `MAIL_UNDO_SEND_WINDOW_MS`, clamped
  to 5000–10000ms either way, defaulting to 8000ms. Nothing else about the
  worker changed — `claimNextBatch()`'s `status = 'pending'` filter already
  excludes `cancelled` the same way it excludes `sent`/`failed`.
- **`routes/ayzen-mailbox.ts`** — `POST /send`'s immediate-send response
  (the `queued: true` branch, unaffected: Scheduled Send branch untouched)
  now also returns `undoWindowMs` and `undoExpiresAt` — server-derived so
  `MAIL_UNDO_SEND_WINDOW_MS` can be tuned without a frontend redeploy.
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** —
  - `ComposeDialog`'s "Queued" toast is now an actionable **"Message
    sent"** toast with a live per-second countdown ("Sending from
    x@ayzen.tech… undo within 6s") and an `Undo` button (new
    `showUndoSendToast()`), calling the new endpoint. Tapping it after the
    window closes just surfaces the 409 as a "Couldn't undo — already
    sent" toast — same graceful-loss-of-race handling the backend does.
  - `onSent`'s signature grew an optional `{ silent?: boolean }` — every
    `onSent()` caller normally fires its own "Check the Sent tab" toast,
    which would instantly replace the new Undo toast (the toast store only
    ever shows one at a time). `send()` now calls `onSent({ silent: true
    })` on the queued-with-undo path so that doesn't happen; all 3
    `ComposeDialog` call sites updated to skip their toast when
    `opts?.silent`.

## Not done here (Phase 2)

- Fixed window only — `MAIL_UNDO_SEND_WINDOW_MS` is an env var, not a
  per-user setting. A Settings toggle (5s/10s/20s/30s, Gmail-style) is a
  Phase 2 item.
- The undo affordance only exists as a toast. If it's dismissed, or the
  tab reloads mid-window, there's no other way to undo — a persistent
  chip on the Outbox row itself (using the same `undoExpiresAt` idea) is a
  Phase 2 item.
- The `draftSeed` `ComposeDialog` call site's `onDraftSaved` is a no-op
  (unchanged from before this work), so a reply/forward's undo doesn't
  force that list to refresh immediately — it'll catch up on the existing
  ~25s background poll. The other two call sites already refresh
  immediately via `onDraftSaved`/`refreshAll`.
- Idempotent Send's replay path (`replaySendResult`) doesn't recompute a
  fresh undo window for a retried request — it reflects whatever the row's
  state already settled to, same as it does for every other field.
- Scheduled Send is untouched — it already has its own, much longer,
  cancel-any-time window via the existing `PATCH /:id/cancel-schedule`.

## Before running

- No migration needed — this reuses migration 047's existing
  `ayzen_mailbox_send_queue` columns (`status`, `next_attempt_at`) as-is.
- No required env var. `MAIL_UNDO_SEND_WINDOW_MS` optionally overrides the
  default 8-second window (clamped 5000–10000).
