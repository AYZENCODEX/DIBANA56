# Bounce + Complaint Handling — Phase 4 (digest/batched notifications)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Undo Send Phase 1+2, Bounce + Complaint Handling Phase 1+2+3, now with
Phase 4 merged on top) — extract and overwrite your project, nothing left
to hand-patch.

## The idea

Phase 1 made every single bounce and every single complaint fire its own
in-app notification. Fine for an occasional bounce — noisy for a
high-volume sender having a genuinely bad stretch, exactly the situation
Phase 3's account-pause logic already detects. Phase 4 batches those two
specific notification types once a user is clearly in that situation,
without touching anything else.

## What does and doesn't get batched

- **Batched:** the per-message "Message bounced" / "Spam complaint
  received" notifications from Phase 1 (`routes/resend-webhook.ts`) —
  these are the ones that fire once per event, so they're the ones that
  pile up.
- **NOT batched:** the per-recipient "address flagged"/"address blocked"
  notification (Phase 1/2) and the account-wide "sending paused"
  notification (Phase 3). Both already only fire once per threshold
  crossing, not once per event — they were never the noisy ones.

## New

- **`migrations/054_ayzen_mailbox_notification_digest.sql`** — extends
  Phase 3's existing per-user `ayzen_mailbox_sending_health` row (no new
  table) with `burst_notif_count`/`burst_window_started_at` (how many
  individual notifications this user has had in the current short burst)
  and `digest_pending_bounces`/`digest_pending_complaints`/
  `last_digest_sent_at` (what's accumulated but not yet sent as a
  summary). Also adds `digest_trigger_count` (default 5) and
  `digest_burst_minutes` (default 15) to Phase 3's admin-tunable
  `ayzen_mailbox_sending_config` singleton.
- **`lib/mail-notification-digest.ts`**:
  - `shouldNotifyIndividually(userId, kind)` — called right before
    `routes/resend-webhook.ts` would insert an individual notification.
    Bumps the burst counter (resetting it first if the burst window has
    aged out); while the count is at/under `digest_trigger_count`, returns
    `true` (send it normally). Once a burst crosses that count, further
    events in the same window return `false` and instead increment the
    matching `digest_pending_*` counter.
  - `flushPendingDigests()` — one pass: every user with something pending
    gets exactly ONE "Bounce/complaint summary" notification listing the
    counts, then both the pending counters AND the burst counter reset to
    zero — so a user who's gone quiet drops back into "every bounce
    notifies individually" rather than staying in digest mode from one
    old burst forever.
  - `startMailDigestCron()` — same `node-cron` pattern as
    `lib/mail-schedule-cron.ts`'s existing backstop sweep (guard against
    double-init, `MAIL_DIGEST_CRON` env override, validated before
    scheduling). Defaults to every 15 minutes. Registered in `index.ts`
    alongside `startMailScheduleCron()`.
- **Admin → Mail Sending Health Thresholds** gained two more fields:
  Digest trigger count and Digest burst window. (Deliberately no "flush
  cadence" field — the cron's own interval is env-var-driven, same as the
  existing Scheduled Send backstop, since a live `node-cron` schedule
  can't be re-read from the database without a process restart. Adding a
  DB column nobody actually reads would just be a fake control.)
- **Settings → Sending Health** widget now shows an amber note — "Volume
  is high — N notifications batched, arriving as a summary shortly" —
  whenever a digest is currently pending for that user.

## Changed

- **`routes/resend-webhook.ts`** — both the bounce and complaint branches
  now wrap their per-message notification insert in
  `if (await shouldNotifyIndividually(...))`. Everything else in those
  branches (the message status update, the per-recipient reputation call,
  the Phase 3 account-health call) is unconditional — only the individual
  notification is what digesting skips.
- **`lib/mail-sending-health.ts`** — `getOrCreateHealth()` is now exported
  (was a private helper) so `mail-notification-digest.ts` can reuse the
  same row-fetch instead of duplicating it. `getSendingHealth()`'s return
  shape grew `digestPendingBounces`/`digestPendingComplaints`/
  `lastDigestSentAt` for the Settings widget above.
- **`routes/ayzen-mailbox.ts`** — `GET /sending-health` now returns the
  three new digest fields; `PATCH /admin/mail-sending-config`'s allow-list
  grew `digestTriggerCount`/`digestBurstMinutes`.
- **`index.ts`** — `startMailDigestCron()` added next to the existing
  `startMailScheduleCron()` call at boot.

## Not done here

- **Pause is still per-user, not per-domain** — unchanged from Phase 3's
  own "not done" note, still out of scope for the same reason.
- **The digest summary is a flat count, not a breakdown.** "5 messages
  bounced and 2 spam complaints" — it doesn't list which recipients, since
  those are already visible individually in Settings → Problematic
  Recipients. Fine for "there's activity, go look," not meant to replace
  that page.
- **No per-user override of the digest thresholds** — `digestTriggerCount`
  and `digestBurstMinutes` are platform-wide (the same
  `ayzen_mailbox_sending_config` singleton every other Phase 3 threshold
  lives on), not something an individual user can tune for themselves.

## Before running

- Run migration 054 (adds columns to two existing tables — no new table
  this phase).
- Optional: set `MAIL_DIGEST_CRON` if you want a cadence other than every
  15 minutes (`*/15 * * * *`) for the flush sweep.
