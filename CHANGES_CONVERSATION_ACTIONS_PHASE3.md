# What's new in this drop (Whole Conversation Actions — Phase 3, optimistic UI)

This zip is your FULL codebase (send-queue Phase 1+2, Delivery Tracking,
Conversation Actions Phase 1+2+3 all merged on top) — extract and
overwrite your project, nothing left to hand-patch.

Phase 2's changelog flagged one remaining item: Archive/Move/Delete still
waited for the request to round-trip before navigating back to the list,
so there was a visible pause even though the action almost always
succeeds. This closes that out.

## What changed

For **whole-conversation** Archive / Move / Delete (the `wholeConversation`
default from Phase 2 — not the "this message only" override), the flow is
now: drop the row out of the parent list, navigate back to it, *then* let
the actual request finish in the background. The request still runs and
is still checked — a failure shows the same error toast as before and
triggers a background refetch that puts the row back if the optimism
turned out to be wrong — it just no longer blocks the navigation.

This is safe to do unconditionally for whole-conversation actions
specifically because there's no ambiguity to wait on: archiving, moving,
or trashing the *entire* conversation guarantees it's leaving whatever
folder is currently being viewed, so removing its row is always the
correct outcome to assume.

**"This message only" stays non-optimistic, deliberately.** Archiving one
reply out of a 12-message thread doesn't tell you whether the
conversation's own row should disappear from the current folder — the
other 11 messages might still be sitting right there. That genuinely needs
the server's answer before the list can know what to show, so it keeps
the original wait-then-navigate behavior.

## How it's implemented

- **`mailbox.tsx` (parent list component)** — new `optimisticallyRemoveThread(threadId)`,
  same pattern as the existing `toggleStarOnMessage`/`toggleReadOnMessage`
  optimistic updates: filters the row out of local `messages` state
  immediately, no round-trip required. Passed down to `ThreadDetail` as a
  new `onOptimisticRemoveThread` prop.
- **`ThreadDetail`** — `move()`, `trashOrDeleteForever()`, and
  `deleteForever()` now branch on `wholeConversation`: when true, call
  `onOptimisticRemoveThread(threadId)` + `onBack()` immediately, then
  `await runThreadAction(...)` in the background (its own success/failure
  toast still fires whenever the request actually resolves); when false
  (message-only scope), unchanged from Phase 2 — await first, navigate on
  success.
- **`runThreadAction`** — now calls `onChanged()` (triggers the parent's
  `refreshAll()`) on failure too, not just success, so a failed
  whole-conversation action that already had its row optimistically
  removed gets that row put back by the resync rather than left stale.

## Changed files

- **`artifacts/ayzen/src/pages/user/mailbox.tsx`** — `optimisticallyRemoveThread`
  added to the parent component and wired into `<ThreadDetail
  onOptimisticRemoveThread={...} />`; `ThreadDetail`'s `move`/
  `trashOrDeleteForever`/`deleteForever`/`runThreadAction` updated as
  described above.

No backend changes this round — Phase 3 is purely a frontend sequencing
change on top of the same `PATCH /mailbox/bulk` call Phase 1/2 already use.
