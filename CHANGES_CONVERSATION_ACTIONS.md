# What's new in this drop (Whole Conversation Actions — Phase 1)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
now with Whole Conversation Actions Phase 1 merged on top) — extract and
overwrite your project, nothing left to hand-patch.

## The problem this fixes

`ThreadDetail`'s own comment said it plainly: "Top-bar actions
(star/archive/move/trash) act on the specific message that was actually
opened from the list … since folder membership is still per-message, same
as before threading existed." So opening a 10-message conversation and
hitting Archive only archived the one message you happened to click into
— the other 9 stayed wherever they were. Gmail/Outlook archive, move,
delete, star, and mark-read/unread the *whole conversation* from that view.

## Scope of Phase 1

Five actions become whole-conversation, exactly the set asked for:

- **Star** — Gmail-style rollup: if any message in the thread is already
  starred, the icon shows filled and clicking clears the star from every
  message; if none are starred, clicking stars all of them.
- **Archive**
- **Move** (the folder-picker menu)
- **Delete** (Move to Trash / Delete forever — two-stage, see below)
- **Mark read / unread** — new control, didn't exist in this toolbar
  before. Rolls up the same way Star does: any unread inbound message in
  the thread shows the conversation as unread.

**Deliberately still per-message** (anchor-scoped, unchanged): Snooze,
Reschedule, Cancel send, Report spam / Not spam, Restore, and Labels. Each
of these only makes sense for one message's own state — a scheduledSendAt,
a folder-conditional restore target, a label set — not a whole thread's.
Bulk-moving an entire conversation to Spam, for instance, would also drag
along the user's own outbound replies sitting in it, which was never how
Gmail's "report spam" worked either — it only ever targets the one message
that triggered it.

## How it's implemented

No new backend route. `PATCH /ayzen-email/mailbox/bulk` already existed
(driving the list's own multi-select bulk-action bar) and already does
exactly what whole-conversation actions need: takes an `ids: number[]` +
`action`, re-validates ownership, and applies the change to every id in
one request. `ThreadDetail` now just passes every message id currently
loaded for the thread (`messages.map(m => m.id)`) instead of a single
anchor id — same endpoint, same validation, same two-stage delete logic
(only messages already in Trash get permanently removed; everything else
in the selection just moves to Trash), all reused as-is.

## Changed files

- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — `ThreadDetail`:
  added `threadIds` / `runThreadAction()` (thin wrapper around the bulk
  endpoint); `toggleStar`, `markThreadRead` (new), `move`, and
  `trashOrDeleteForever`/`deleteForever` now act on every id in the
  thread. Added a Mark read/unread toolbar button. Split `moveAnchor()`
  back out as a single-message mover for Report spam / Not spam / Restore,
  so those three keep their original per-message semantics.

## Known limitation, deferred to Phase 2

~~`GET /mailbox/thread/:threadId` filters out every message currently
sitting in Trash…~~ **Fixed in Phase 2** — see
`CHANGES_CONVERSATION_ACTIONS_PHASE2.md`.
