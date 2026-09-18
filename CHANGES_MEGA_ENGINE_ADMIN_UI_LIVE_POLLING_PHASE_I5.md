# AYZEN Mega Engine — Phase I5: Live-Poll the Open Run Detail View

## Scope
Closes the item Phase I4 named in its own "Still open" list: *"No
auto-refresh/polling on either view — an operator watching a `RUNNING`
run's step history has to close and reopen the dialog (or hit the
page-level Refresh button) to see new rows; a reasonable small
follow-up, not part of this phase's own narrow scope."* Same shape of
follow-up I1 → I2 already was for this letter — a phase explicitly
declines a small adjacent item as out of scope, and the very next phase
is that item.

Deliberately narrower than "auto-refresh/polling on either view" as I4
phrased it: only the **detail dialog** polls, and only while it's
**open** and the run it's showing is **non-terminal**. The list view
does not gain a poll in this phase — nothing in I4's own problem
description ("watching a RUNNING run's step history") was about the
list, and a list-level poll would re-sort/re-page rows out from under
an operator mid-scan for a benefit (seeing a brand-new run appear a few
seconds sooner) nobody asked for. That stays open, see below.

## What was built

**`src/pages/admin/mega-engine.tsx`**
- New `NON_TERMINAL` status set — mirrors `state-machine.ts`'s own
  `isTerminalRunStatus()` (the four statuses whose `RUN_TRANSITIONS`
  entry is `[]`, negated), rather than inventing a separate notion of
  "still interesting to watch". Kept as a literal set here instead of
  importing `isTerminalRunStatus()` itself — this file already
  duplicates `CANCELLABLE`/`REPLAYABLE` as literal sets mirroring
  `run-store.ts`/`replay.ts` server-side logic for the same reason I4
  established: a frontend page has no access to the backend's own
  modules, only to the JSON shapes its routes return.
- New `DETAIL_POLL_MS` constant (3000) — one fixed interval, not a
  per-operator setting; this is an internal operator console, not a
  dashboard product with varied audiences.
- New `useEffect` that starts a `setInterval` calling the existing
  `refreshDetail(id)` — no new fetch logic, the exact same `GET
  /api/admin/mega-engine/workflow/runs/:id` call the dialog already
  made once on open — whenever the dialog is open (`selectedRunId` set)
  and the currently-loaded run's status is in `NON_TERMINAL`. Cleans up
  the interval on every dependency change (`selectedRunId`,
  `detail?.run.status`) and on unmount, same as any `setInterval` inside
  a `useEffect` must. The effect keys off `detail?.run.status` rather
  than a boolean "isPolling" flag specifically so that the moment a poll
  observes the run has gone terminal (e.g. `RUNNING` → `COMPLETED`), the
  effect re-runs, its cleanup fires, and the next `setInterval` call is
  simply skipped by the guard at the top — polling a run that just
  finished for one more tick before self-stopping would show up as a
  brief "why did it fetch again" flicker with no purpose behind it.
- Closing the dialog (`onOpenChange`) already cleared `selectedRunId` in
  I4; that alone was already enough to stop the poll once this phase's
  effect existed — no additional cleanup wiring needed there.

No backend changes — this phase calls nothing that wasn't already
called once per dialog-open in I4; it's the same request on a timer.

## Still open (carried forward, untouched by I5)
- The **list view** still has no auto-refresh — an operator watching
  the list itself (not inside a run's detail dialog) still needs the
  page-level Refresh button to see a brand-new run appear or an
  existing row's status change. Deliberately left out of this phase's
  own narrow scope (see "Scope" above); a reasonable next follow-up if
  it's ever actually asked for.
- No polling pause when the browser tab is backgrounded
  (`document.visibilityState`) — a dialog left open in a hidden tab
  keeps polling every `DETAIL_POLL_MS` at the same rate as a visible
  one. Harmless (one GET every 3s to an admin-only route) but not
  bandwidth/battery-optimal; not worth this phase's own fix for an
  internal operator console.
- Health/metrics/dead-letters (events + jobs)/retention still have no
  screen of their own at all — unchanged from I4.
- The in-flight action non-interruptibility (I1), the two negligible
  I1-named races, step-level `timeoutMs`, `traceId` propagation, §40
  Audit Integration, `workflow.timed_out` as a bus event, the
  `tx`-supplied caller edge case (H1) — all still carried forward
  untouched.
