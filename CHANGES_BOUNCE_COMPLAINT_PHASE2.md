# Bounce + Complaint Handling — Phase 2 (send-time enforcement + management UI)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Undo Send Phase 1+2, Bounce + Complaint Handling Phase 1, now with Phase 2
merged on top) — extract and overwrite your project, nothing left to
hand-patch.

## The idea

Phase 1 recorded bounces/complaints and flagged/blocked the recipient, but
`POST /send` never looked at that before sending — you could keep emailing
an address that had already complained about you. Phase 2 closes that
loop, and gives the user somewhere to actually see and manage the list
Phase 1 was quietly building.

Two different gates, on purpose:

- **`blocked`** (a spam complaint, ever) — hard stop, no override in the
  send flow. The only way past it is `DELETE /problematic-recipients/:email`
  from Settings, a deliberate separate action.
- **`flagged`** (3+ bounces in a row) — soft stop. The first attempt is
  rejected with the specifics; the compose UI shows what happened and lets
  the user explicitly say "send anyway", which resubmits with that
  confirmation attached.

## New

- **`lib/mail-spam.ts`** — `extractAllEmails(raw)`: like the existing
  `extractEmail()` but returns every address out of a comma-separated
  To/Cc/Bcc field instead of just the first. `extractEmail()` was written
  for single-sender inbound mail, where that was fine; outbound `to`/`cc`/
  `bcc` can legitimately have more than one recipient, and Phase 2 needs to
  check all of them, not just whichever came first.
- **`lib/mail-recipient-reputation.ts`** — `checkOutboundRecipients(userId,
  emails[])`: dedupes the address list (the same person can be in both To
  and Cc) and returns which are `blocked` vs `flagged`. This is the one new
  function `POST /send` actually calls — everything else it needs
  (`recordBounce`/`recordComplaint`/`recordDelivery`) already existed from
  Phase 1.
- **Settings → "Problematic Recipients"** — a new section (right under
  Undo Send) listing every flagged/blocked address for the logged-in user,
  with bounce/complaint counts and a **Clear** button per row that calls
  `DELETE /problematic-recipients/:email`. First real frontend surface for
  the list Phase 1's `GET /problematic-recipients` route had no UI calling
  it yet.

## Changed

- **`routes/ayzen-mailbox.ts`** — `POST /send`:
  - Body grew `confirmFlaggedRecipients?: boolean`.
  - Right after the existing Idempotent Send replay check (deliberately
    *after* it — a retry of an already-sent message replays that outcome
    rather than getting newly blocked because the recipient's status
    changed since the original send went through) and before both the
    Scheduled Send and immediate-send branches, every To/Cc/Bcc address is
    checked via `checkOutboundRecipients()`:
    - Any `blocked` address → `422 { code: "RECIPIENT_BLOCKED",
      blockedRecipients: [...] }`. Nothing is written — no message row, no
      queue row.
    - Any `flagged` address, and `confirmFlaggedRecipients` isn't set →
      `409 { code: "RECIPIENT_FLAGGED", flaggedRecipients: [{ email,
      bounceCount, consecutiveBounces }] }`.
    - Otherwise falls through to the existing send logic, completely
      unchanged.
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — `ComposeDialog`'s
  `send()`:
  - Took a second parameter, `confirmFlagged` (default `false`), threaded
    into the request body as `confirmFlaggedRecipients`.
  - A `RECIPIENT_BLOCKED` response now shows a destructive toast
    explaining the address was blocked and stops there — no retry
    affordance in the compose box itself, matching the "no override"
    design.
  - A `RECIPIENT_FLAGGED` response (only when this call didn't already set
    `confirmFlagged`) shows a toast with a **"Send anyway"** action button,
    which calls `send(scheduledAt, true)` — same message, same
    `scheduledAt`, just now with the confirmation flag set so the second
    attempt clears the gate.
- **`artifacts/ayzen/src/pages/user/settings.tsx`** — new state/fetch/
  clear logic for the Problematic Recipients section above (`useCallback`
  fetch-on-mount, optimistic row removal on Clear, same
  loading/error-toast shape every other settings section here already
  uses).

## Not done here (Phase 3, if wanted)

- **Account-level complaint-rate health.** Phase 2 still only reasons
  per-recipient. A dashboard (or automatic sending pause) for *this user's*
  aggregate bounce/complaint rate — the thing that actually threatens the
  shared Resend domain's sending reputation — isn't built.
- **Digest/rollup notifications.** Every bounce and every complaint still
  fires its own notification (from Phase 1) — batching into a daily digest
  once volume crosses some threshold is still outstanding.
- **Admin-configurable thresholds.** `BOUNCE_FLAG_THRESHOLD` (3 consecutive
  bounces) is a constant in `lib/mail-recipient-reputation.ts`, not a
  per-user or admin-tunable setting.
- **Cc/Bcc get the same hard/soft gate as To**, but the compose UI's
  "Send anyway" flow doesn't visually distinguish *which* field a flagged
  address came from — the toast just lists the email addresses.

## Before running

- No new migration — Phase 2 is pure application logic on top of Phase 1's
  `ayzen_mailbox_recipient_reputation` table (migration 052).
- No new env vars.
