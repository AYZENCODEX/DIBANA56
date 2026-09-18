# Undo Send — Phase 2 (per-user window, persistent chip, unified with Scheduled Send)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Conversation Actions Phase 1+2+3, Undo Send Phase 1+2 merged on top) —
extract and overwrite your project, nothing left to hand-patch.

Closes out all three "Not done here (Phase 2)" items from
CHANGES_UNDO_SEND_PHASE1.md.

## New

- **Per-user Undo Send window.** `users.mailUndoSendWindowMs`
  (migrations/051, NOT NULL DEFAULT 8000) replaces the single
  operator-set `MAIL_UNDO_SEND_WINDOW_MS` env var every user was stuck
  with in Phase 1. `MIN/MAX_UNDO_SEND_WINDOW_MS` in
  `lib/mail-send-queue.ts` widened from Phase 1's 5-10s to 5-30s so the
  Gmail-style choices fit (`UNDO_SEND_WINDOW_CHOICES_MS = [5000, 10000,
  20000, 30000]`). The env var still exists — it's now just the default a
  brand-new user's row starts at, and the fallback `clampUndoSendWindowMs()`
  re-clamps to if a row is ever out of range.
  - **`GET/PATCH /users/me/undo-send-window`** (new
    `routes/mail-undo-send-settings.ts`, mirrors `digest-settings.ts`'s
    shape exactly). GET returns the current value plus the choice list
    (server-derived so the frontend never hardcodes it); PATCH only
    accepts the 4 exact choices.
  - **Settings page** — new "Undo Send" section (`user/settings.tsx`),
    same optimistic-update-then-revert-on-failure pattern as the existing
    Vault Digest frequency picker right above it.
  - **`POST /send`** now reads `user.mailUndoSendWindowMs` (clamped)
    instead of the flat `UNDO_SEND_WINDOW_MS` constant when computing the
    window it hands to `enqueueSend()` and echoes back in the response.

- **Persistent Outbox undo chip.** `ayzen_mailbox_messages.undoExpiresAt`
  (migrations/051, nullable — same "only meaningful while folder === X"
  convention as `scheduledSendAt`/`snoozedUntil`) is now stamped onto the
  message row itself at send time, not just returned in the `/send`
  response for a toast to consume. The Outbox list (`mailbox.tsx`'s new
  `OutboxUndoChip`) reads it straight off ordinary `GET
  /ayzen-email/mailbox` data and renders its own live "Undo (Ns)" chip —
  no separate endpoint, and unlike Phase 1's toast it survives a dismissal
  or a mid-window reload, since the underlying send-queue row (and now the
  message row) is the actual source of truth either way. `fmt()` in
  `routes/ayzen-mailbox.ts` returns it; cleared back to `null` on every
  path that leaves the undoable state (sent, undone, retried, or
  abandoned to Drafts after `MAX_SEND_ATTEMPTS`) so a stale chip can never
  show.

- **Scheduled Send folded into the same queue.** `POST /send`'s scheduled
  branch now calls `enqueueSend(tx, msg.id, scheduledSendAt - now)` at
  schedule time — same helper, same transaction pattern the immediate-send
  branch already used — instead of leaving the message with no queue row
  until the old once-a-minute cron noticed it was due. This means:
  - A scheduled message has a real `'pending'` send-queue row from the
    moment it's scheduled, and the send queue's existing 5-second worker
    picks it up the instant it's due — down from up to a minute of
    latency on the old cron.
  - **`PATCH /:id/reschedule`** now pushes that row's `next_attempt_at`
    forward (and resets `attempts`/`last_error`) in the same transaction
    as the message update, guarded on `status = 'pending'` — if the
    worker already claimed it, this 409s with `UNDO_WINDOW_EXPIRED`
    instead of silently updating a message that's already out of the
    queue's hands.
  - **`PATCH /:id/cancel-schedule`** now cancels that row
    (`status = 'cancelled' WHERE status = 'pending'`) before moving the
    message to Drafts — the exact same race guard `PATCH /:id/undo-send`
    already used for immediate sends. One unified "is it still safe to
    pull this back" implementation for both send paths instead of two
    bespoke ones.
  - **`lib/mail-schedule-cron.ts`** is no longer the primary detection
    path. It's kept as a backstop sweep (default cadence dropped from
    every minute to every 5 minutes) that only re-enqueues a scheduled
    message if it's somehow due with *no* live send-queue row behind it
    (e.g. a row from before this change, or a restored snapshot) — on the
    normal path it should find nothing.

## Changed

- `lib/mail-send-queue.ts` — `MIN_UNDO_SEND_WINDOW_MS`/
  `MAX_UNDO_SEND_WINDOW_MS` widened to 5000/30000; new exported
  `UNDO_SEND_WINDOW_CHOICES_MS` and `clampUndoSendWindowMs()`. Every place
  a message row leaves the "undoable" state (`processQueueRow`'s success,
  retry, and give-up branches) now also clears `undoExpiresAt`.
- `routes/ayzen-mailbox.ts` — `fmt()` returns `undoExpiresAt`. `POST
  /send`'s immediate branch stamps it on the row and derives its window
  from the user's setting; its scheduled branch is now wrapped in a
  transaction and calls `enqueueSend`. `reschedule`/`cancel-schedule`
  rewritten as above. `undo-send` also clears `undoExpiresAt` on undo.
- `routes/index.ts` — mounts the new `mail-undo-send-settings` router.
- `lib/db/src/schema/users.ts` / `schema/ayzen-mailbox.ts` — the two new
  columns.
- `artifacts/ayzen/src/pages/user/mailbox.tsx` — new `OutboxUndoChip`;
  `MailboxMessage` gained `undoExpiresAt`.
- `artifacts/ayzen/src/pages/user/settings.tsx` — new "Undo Send" section.

## Not done here

- Phase 1's toast (`showUndoSendToast` in `ComposeDialog`) is untouched —
  it still fires on send and still works exactly as before; the chip is
  an *additional*, persistent affordance in the Outbox list, not a
  replacement.
- The `draftSeed` `ComposeDialog` call site's reply/forward undo still
  doesn't force an immediate list refresh (relies on the existing ~25s
  poll) — unrelated to this phase, and the persistent chip doesn't need
  it anyway since it reads off whatever the list already has.
- Idempotent Send's replay path still doesn't recompute a fresh undo
  window for a retried request.

## Before running

- Schema changes are picked up by `pnpm --filter db push` (drizzle push),
  same as the rest of this codebase — `migrations/051_...sql` is the
  human-readable changelog copy, not something to run by hand.
- No required env var changes. `MAIL_UNDO_SEND_WINDOW_MS` still works as
  the default for new users; `MAIL_SCHEDULE_CRON`'s default cadence
  changed (every 5 min instead of every min) since it's now a backstop —
  override it if you want the old cadence back for some reason.
