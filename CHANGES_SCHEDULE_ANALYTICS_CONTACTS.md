# What's new in this drop (Scheduled Send + Mail Analytics + Contact Intelligence)

⚠️ **Read this before overwriting anything.** Unlike the earlier CHANGES_*.md
drops in this repo, this zip is NOT guaranteed to be your full current
codebase. It's the last full snapshot I have (Attachment System 2.0) with
this session's mailbox work merged in on top. If you've made other changes
directly on your server/repo since that snapshot (anywhere outside the
mailbox files listed below), those changes are NOT reflected here — diff
before you overwrite, don't just extract-and-replace blindly like the
native-mailbox drop said to.

## Changed / new files in this drop
- lib/db/src/schema/ayzen-mailbox.ts — updated to your newer version (scheduledSendAt/scheduleAttempts columns, "scheduled" system folder, new ayzenContactsTable)
- migrations/045_ayzen_mailbox_schedule_analytics.sql — new: the columns/table/indexes above
- artifacts/api-server/src/lib/mail-attachment-content.ts — new: resolveAttachmentContent extracted out of routes/ayzen-mailbox.ts so the cron can share it
- artifacts/api-server/src/lib/mail-schedule-cron.ts — new: the Scheduled Send sweep (runs every minute, sends due messages via Resend, retries on failure, gives up to Drafts after 5 attempts)
- artifacts/api-server/src/routes/ayzen-mailbox.ts — updated:
  - POST /send accepts `scheduledSendAt` (queues to the Scheduled folder instead of sending immediately)
  - new PATCH /:id/reschedule, PATCH /:id/cancel-schedule
  - new GET /mailbox/analytics (received/sent/unread/attachments/avg response time/top correspondents)
  - new GET /mailbox/contacts/:email, POST /mailbox/contacts
- artifacts/ayzen/src/pages/user/mailbox.tsx — updated to your newer version (Schedule send menu, Analytics dialog, Contact Intelligence popover — this UI already existed on your side; included here so the zip is self-consistent)

## Before running
1. Run migration 045 against your DB (Supabase SQL Editor, same as prior mailbox migrations — these were never in index.ts's boot-time MIGRATIONS array either, see note below).
2. **Manual step I couldn't do for you**: I don't have your current index.ts in
   this session (it wasn't part of this drop), so I couldn't safely edit it.
   You need to, in your own index.ts:
   - `import { startMailScheduleCron } from "./lib/mail-schedule-cron";`
   - call `startMailScheduleCron();` in the `app.listen(...)` callback, alongside your other `start*Cron()` calls.
   (If you already did this in a prior session, skip it — check first.)
3. Resend must already be configured (same requirement as native mailbox send) — Scheduled Send just delays that same call.

## Note on migrations 036–044
These also aren't in index.ts's boot-time MIGRATIONS array — only as
standalone migrations/*.sql files, meaning they were applied by running the
SQL directly against Supabase at some point. Migration 045 follows that same
pattern rather than guessing at auto-wiring it into a boot array I can't see.
