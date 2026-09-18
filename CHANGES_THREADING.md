# What's new in this drop (conversation threading + reply-all/forward)

This zip is your FULL codebase with proper email threading merged into the
native ayzen.tech mailbox on top of the folders drop — extract and overwrite
your project, nothing left to hand-patch.

## The problem this fixes
- The inbox listed one row per email, with no concept of a conversation —
  a 10-message back-and-forth showed up as 10 separate rows.
- Reply only worked on inbound mail, there was no Reply All, and there was
  no Forward at all.
- Replies didn't quote the original message.
- Outbound messages never got a Message-ID, so if someone replied to *your*
  reply, that new message couldn't be matched back to anything — threading
  broke one hop in.
- No References header was ever sent or stored, so even recipients using
  Gmail/Outlook wouldn't reliably thread a multi-message exchange with you.

## Changed / new files
- lib/db/src/schema/ayzen-mailbox.ts — + `referencesHeader`, `threadId`
  columns on messages
- migrations/040_ayzen_mailbox_threading.sql — new: adds those columns,
  backfills every existing row into a thread (best-effort chain resolution,
  20-pass bounded propagation), indexes `(user_id, thread_id, created_at)`
- artifacts/api-server/src/lib/mail-threading.ts — new: `resolveThreadId()`,
  shared by the inbound webhook and outbound send/draft routes so a thread
  can't fork depending on which side triggered the write
- artifacts/api-server/src/lib/resend-mail.ts — captures the inbound
  References header; sends both In-Reply-To and References on outbound mail
  (so external clients thread correctly too); `sendAsAyzenUser` now accepts
  `cc` and returns a synthetic Message-ID for our own sent mail (Resend's
  send API doesn't hand one back, and without it a reply-to-our-reply had
  nothing to match against)
- artifacts/api-server/src/routes/resend-webhook.ts — inbound messages now
  resolve and store `threadId`
- artifacts/api-server/src/routes/ayzen-mailbox.ts —
  - `GET /mailbox` now returns one row per **conversation** (latest message
    stands in for the thread, with `messageCount`/`threadUnread`)
  - new `GET /mailbox/thread/:threadId` — full conversation, oldest first,
    across every folder except Trash; marks the whole thread read
  - send/draft routes accept `cc` and `references`, and resolve the right
    `threadId` for a reply vs. a new thread vs. a forward
- artifacts/ayzen/src/pages/user/mailbox.tsx —
  - list view shows a `(3)`-style conversation count instead of one row per
    email
  - `MessageDetail` → `ThreadDetail`: Gmail-style stacked conversation view,
    collapsed messages show a snippet, latest expanded by default
  - every message now has Reply, Reply All, and Forward (previously only
    Reply, and only on inbound mail)
  - replies auto-quote the original (`On <date>, X wrote: > ...`); forwards
    use the standard `---------- Forwarded message ----------` block and
    carry the original attachments along
  - ComposeDialog gained a Cc field; reply-all excludes your own address

## Behavior notes / known simplifications
- Folder membership is still per-message (unchanged from the folders drop),
  so top-bar actions (Archive/Move/Trash/Star) in the thread view apply to
  the specific message you opened from the list, not the whole
  conversation — same as before, just now shown inside the thread. A
  "archive this entire conversation" bulk action isn't in this drop.
- A thread is scoped per user: two different users emailing back and forth
  each see their own copy of the conversation grouped independently, which
  matches how the mailbox already isolates everything by `user_id`.
- Threads whose root message predates this migration are backfilled
  best-effort from whatever In-Reply-To chains already exist in the data —
  a chain deeper than 20 hops (extremely unlikely) would need the backfill
  loop's iteration count bumped.

## Before running
1. Run migration 040 (after 039) via your usual flow.
2. No new env vars, plugin config, or webhook changes — this is additive on
   top of the existing Resend Email setup from the earlier drops.

## Verified
- `pnpm run typecheck:libs` — clean
- `tsc --noEmit` in `artifacts/api-server` — no new errors (4 pre-existing,
  unrelated errors remain: a Cloudflare DNS helper untouched by this change,
  and a missing `pg` type declaration in `routes/marketplace-spot.ts`)
- `tsc --noEmit` in `artifacts/ayzen` — clean
