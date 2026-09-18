# Bounce + Complaint Handling — Phase 3 (account-wide health + admin-tunable thresholds)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Undo Send Phase 1+2, Bounce + Complaint Handling Phase 1+2, now with
Phase 3 merged on top) — extract and overwrite your project, nothing left
to hand-patch.

## The idea

Phase 1/2 only ever reasoned about ONE recipient at a time — is this
address a problem? Phase 3 asks the account-wide question that actually
threatens the shared Resend domain's sending reputation: is *this user's*
sending, in aggregate, starting to look bad? A user can have zero flagged
addresses individually and still be running a genuinely bad bounce rate
across hundreds of different one-off recipients — Phase 1/2's per-address
tracking would never catch that.

## New

- **`migrations/053_ayzen_mailbox_sending_health.sql`**:
  - `ayzen_mailbox_sending_health` — one row per user: a rolling window
    (`sent_in_window`/`bounced_in_window`/`complained_in_window`, default
    30 days) plus lifetime totals, a `status` (`healthy`/`warning`/
    `paused`), and `paused_at`/`paused_reason`.
  - `ayzen_mailbox_sending_config` — a **singleton** row (`id` is always 1,
    enforced by a CHECK constraint) of admin-tunable thresholds: how many
    consecutive bounces flags a recipient (Phase 2's hardcoded
    `BOUNCE_FLAG_THRESHOLD` moved here), the window length, the minimum
    sample size before a rate counts, and the warning/pause rate
    thresholds for bounces and complaints. Rates are stored as basis
    points (500 = 5.00%) for exact integer comparisons.
- **`lib/mail-sending-config.ts`** — `getSendingConfig()` (self-healing —
  creates the singleton row with defaults if it's ever missing, 30s
  in-process cache since this is read on nearly every mail event) /
  `updateSendingConfig()` (admin-only, invalidates the cache).
- **`lib/mail-sending-health.ts`** — the account-wide equivalent of Phase
  1/2's `lib/mail-recipient-reputation.ts`:
  - `recordSend()` / `recordBounce()` / `recordComplaint()` — bump the
    windowed + lifetime counters, then re-evaluate status.
  - Evaluation order: an outright complaint-count hard cap
    (`complaint_hard_cap`, default 5 in the window) fires first — enough
    complaints don't need a rate to justify pausing. Then complaint rate,
    then bounce rate, each checked against pause before warning. Rates
    only apply once `sent_in_window >= min_sample_size` — a couple of bad
    sends out of three shouldn't read as a 33%+ bounce rate.
  - **Never auto-downgrades out of `paused`** — only the user's explicit
    resume (below) or the window rolling over and a fresh evaluation
    coming back clean can move an account off `paused`. A single good
    send right after crossing the line doesn't silently unpause an
    account nobody looked at.
  - `resumeSendingHealth()` — the explicit "I've cleaned up my list, let
    me send again" action. Re-evaluates from current counts rather than
    force-clearing the flag; if the rate is still over the line, it lands
    right back on `paused` and reports `resumed: false` rather than
    letting the user immediately resume into the same problem.
  - `getSendingHealth()` — read-only view (status, rates, totals) for the
    Settings widget and the `POST /send` gate.
  - A `notifications` row fires the moment an account transitions INTO
    `paused` (not on every event after — same "don't re-notify the same
    fact" instinct as Phase 1/2's per-address flag notification).
- **`GET /ayzen-email/mailbox/sending-health`** — current status/rates/
  totals for the logged-in user.
- **`POST /ayzen-email/mailbox/sending-health/resume`** — the resume
  action above.
- **`GET`/`PATCH /admin/mail-sending-config`** — `requireAdmin`-gated
  read/update of the tunable thresholds.
- **Admin → "Mail Sending Health Thresholds"** (`/admin/mail-sending-config`,
  new sidebar entry under Monitoring next to Health Rules) — a form over
  every field in `ayzen_mailbox_sending_config`: bounce flag threshold,
  window length, minimum sample size, and the warning/pause rate
  thresholds (shown as plain percentages — e.g. `5.00`, not `500` — the
  page converts to/from basis points on save/load). Save is disabled until
  something's actually changed.
- **Settings → "Sending Health"** — new section, right above Problematic
  Recipients: a status pill (Healthy/Elevated/Paused), the current
  window's send count and bounce/complaint rates, lifetime totals, and (if
  paused) a **Resume sending** button.

## Changed

- **`lib/mail-send-queue.ts`** — `processQueueRow()` now calls
  `recordSend()` right after a message is confirmed actually dispatched to
  Resend (the "accepted" transition) — the one real choke point every send
  goes through regardless of whether it was sent immediately or via
  Scheduled Send, so this is the single place the account-wide sent-count
  needed to be hooked. Deliberately NOT called on the idempotency-guard
  branch just above it (a crash-recovery replay of a message that already
  went out) — that's not a new send.
- **`routes/resend-webhook.ts`** — `email.bounced`/`email.complained` now
  also call `lib/mail-sending-health.ts`'s `recordBounce()`/
  `recordComplaint()`, alongside the existing per-recipient calls from
  Phase 1/2. Naming collision handled by importing the account-wide
  versions under `recordHealthBounce`/`recordHealthComplaint`.
- **`lib/mail-recipient-reputation.ts`** — `BOUNCE_FLAG_THRESHOLD` is gone;
  `recordBounce()` now reads `bounceFlagThreshold` from
  `getSendingConfig()` on each call instead.
- **`routes/ayzen-mailbox.ts`** — `POST /send` gained a THIRD gate, checked
  before the Phase 2 per-recipient gate (broader check first — no reason
  to evaluate individual recipients if the whole account is paused): if
  `getSendingHealth()` reports `status === "paused"`, the request is
  rejected with `423 { code: "SENDING_PAUSED", pausedReason }` and nothing
  is written. No confirm-and-resend path here, unlike
  `RECIPIENT_FLAGGED` — resuming is a deliberate Settings action, not
  something a retry of the same send can satisfy.
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — `send()`'s error
  handling grew a `SENDING_PAUSED` branch: destructive toast pointing at
  Settings, no retry affordance (matching the "no override in compose"
  design the `RECIPIENT_BLOCKED` branch already used).

## Not done here

- **No digest/batched notifications.** Still flagged from Phase 1/2's own
  "not done" list — every bounce/complaint still notifies individually.
  The one new notification Phase 3 adds (account paused) is a single
  clear event, not a candidate for batching.
- **Pause is per-user, not per-domain.** If multiple AYZEN users happen to
  share the same underlying Resend sending domain, Phase 3 has no
  awareness of THAT aggregate — only each individual user's own rate.
  Whether that matters depends on how your Resend domain setup is actually
  structured, which is outside what this mailbox feature can see.

## Before running

- Run migration 053.
- No new env vars.
- If you want different defaults than the ones migration 053 ships with
  (3 consecutive bounces / 30-day window / 5% warning / 10% pause bounce
  rate / 0.5% pause complaint rate / 5-complaint hard cap / 20 minimum
  sample size), either edit the migration before running it or call
  `PATCH /admin/mail-sending-config` once it's up.
