# What's new in this drop (Whole Conversation Actions — Phase 2)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Conversation Actions Phase 1+2 all merged on top) — extract and overwrite
your project, nothing left to hand-patch.

Phase 2 closes out the three things Phase 1 explicitly deferred: the
Trash-filtering bug, list-row quick actions, and a per-message override.
Optimistic UI for Archive/Move/Delete stays out of scope — flagged below.

## 1. Fixed: opening a trashed message showed the wrong conversation

`GET /mailbox/thread/:threadId` has always excluded Trash rows from the
conversation it returns (by design — a thread split across Inbox/Archive
should still read as one conversation, but already-deleted messages
shouldn't clutter it). The bug: that filter applied unconditionally, even
when the message you *specifically opened* was itself sitting in Trash —
so it would vanish from its own thread's `messages` array, `ThreadDetail`'s
anchor lookup would silently fall back to some other non-trashed message
in the conversation, and every trash-specific control (Restore, Delete
forever) ended up pointed at the wrong row. Phase 1's own changelog called
this out as a known limitation rather than fix it.

Fix: the route now takes an optional `?anchor=<messageId>` query param.
If that message is itself in Trash, Trash rows are **not** filtered out —
you're specifically looking at that conversation as it currently sits,
trash and all. Omit `anchor` (or point it at a non-trashed message) and
behavior is byte-for-byte what it was before. `ThreadDetail` now always
passes its own opened message id as `anchor`.

## 2. New: list-row star/read toggles are conversation-aware too

Same gap Phase 1 fixed for the opened-thread detail view, just one level
up: the mailbox list collapses each conversation to its newest message
(see `GET /mailbox`'s grouping logic), and the row's own star/read quick-
icons only ever touched that one representative message — the other N-1
messages in the conversation kept whatever star/read state they had.

New route: **`PATCH /ayzen-email/mailbox/thread/:threadId/quick-action`**
— body `{ action: "star" | "unstar" | "markRead" | "markUnread" }`.
Deliberately narrower than `/mailbox/bulk`: only the two actions the list's
icons actually trigger, computed server-side from `threadId` so the list
stays a single fast round-trip instead of the frontend first fetching
every message id in the thread just to build a bulk request. Excludes
Trash the same way the thread-GET route's default (no-anchor) behavior
does — a list row is never showing a trashed conversation to begin with.

`toggleStarOnMessage` / `toggleReadOnMessage` in `mailbox.tsx` now call
this instead of the single-message `/mailbox/:id/star` / `/mailbox/:id/read`
routes. The list row itself is still the only thing optimistically
updated (it's the only row the list renders per conversation either way).

## 3. New: per-message override

A 12-message thread sometimes needs one specific reply archived on its
own, not the whole conversation. `ThreadDetail` now has a small toggle —
"Whole conversation" / "This message only" — shown next to the message
count whenever a conversation has more than one message. Flipping it
scopes Star, Mark read/unread, Archive, Move, and Delete down to just the
anchor message, exactly reproducing the pre-Phase-1 single-message
behavior; flipping it back restores the whole-thread default. It resets to
"Whole conversation" every time a different thread is opened, so it's
never silently sticky onto a conversation you didn't mean to scope down.

## Changed files

- **`artifacts/api-server/src/routes/ayzen-mailbox.ts`**:
  - `GET /mailbox/thread/:threadId` — added the `anchor` query param and
    the trash-inclusion logic described above.
  - New `PATCH /mailbox/thread/:threadId/quick-action` route.
  - Added `ne` to the `drizzle-orm` import (needed for the new route's
    `folder != 'trash'` filter).
- **`artifacts/ayzen/src/pages/user/mailbox.tsx`**:
  - `ThreadDetail` — new `wholeConversation` state (defaults to `true`,
    resets on thread change); `scopedMessages`/`scopedIds` replace the old
    unconditional `threadIds`; `toggleStar`, `markThreadRead`, `move`,
    `trashOrDeleteForever`, and the delete-forever confirm dialog all read
    from the scoped set instead of the full thread; toolbar button titles
    and toast copy now say "conversation" or "message" depending on scope.
  - Thread fetch now requests `?anchor=${id}`.
  - `toggleStarOnMessage` / `toggleReadOnMessage` (list rows) now call the
    new quick-action route.

## Still out of scope (as of Phase 2)

~~Optimistic UI for Archive/Move/Delete…~~ **Done in Phase 3** — see
`CHANGES_CONVERSATION_ACTIONS_PHASE3.md`.
