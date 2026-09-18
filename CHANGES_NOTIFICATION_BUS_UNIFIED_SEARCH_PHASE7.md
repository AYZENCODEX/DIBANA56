# AYZEN Workspace — Phase 7: Notification Bus + Unified Search (master plan §7 Phase 7)

## Scope
Master plan §6/§11/§7 calls for two things this pass covers:
1. **Notification bus** — "a Ryft repayment, a Skarn claim window, and a
   Verve offer all surface through one consistent in-app + Astra +
   (optionally) Wisp email notification, instead of each app reinventing
   alerts."
2. **Unified search** — `search.ts` "already exists; extend it to federate
   across Sylo/Ryft/Wisp/Verve/Skarn from one search bar in the Workspace
   hub."

Both were genuinely partial before this pass: `search.ts` federated
Sylo (vault entries/local/kyc/game), Skarn (projects/tasks) and Wisp
(mail) but not Ryft or Verve; and notification delivery was three
separately-reinvented per-module systems (`lib/finance-notify.ts`,
`lib/mail-notification-digest.ts`, a raw `INSERT INTO notifications` in
`routes/marketplace.ts`) with no cross-app settings screen and no channel
preference model at all.

## What was added

### Notification Bus
| File | Change |
|---|---|
| `migrations/108_ayzen_notification_bus_preferences.sql` | New `notification_preferences` table — one row per (user, category), four channel booleans (`in_app`, `telegram`, `email`, `astra`). **Opt-out model**: no row for a category = every channel on, so this ships with zero behavior change for every existing user until they actually touch a toggle. |
| `lib/db/src/schema/notification-preferences.ts` | Drizzle schema for the table above, exported via `schema/index.ts`. |
| `lib/email.ts` | Added `sendNotificationEmail()` — one generic template the bus can hand any category/title/message to, so adding a new event type never requires a new bespoke email template. |
| `lib/notification-bus.ts` | **New.** `emitEvent()` is the router: looks up the user's channel flags for the event's category, then fires in-app (`createNotification`), Telegram (`sendToUser`), email (`sendNotificationEmail`), and Astra (`broadcastToUser(userId, "astra_badge", …)` — a distinct SSE event name from the existing `"notification"` one, so the extension can listen for badge counts without also parsing every bell-UI event). Typed producer wrappers: `notifyRyftRepaymentPosted`, `notifyVerveOfferReceived`, `notifyVerveOrderResolved`, `notifyWardeMemberInvited`, `notifySkarnClaimWindowOpening`. |
| `routes/notification-preferences.ts` | **New.** `GET /api/notification-preferences` (all categories, defaults filled in for any the user hasn't touched) + `PUT /api/notification-preferences/:category` (upsert one category's flags). Registered in `routes/index.ts`. |
| `pages/user/settings.tsx` | The "Notification Preferences" section's `notifBroadcast`/`notifTask` toggles rendered but were never persisted or read anywhere server-side — dead UI. Replaced with a real per-category × per-channel matrix (7 categories × 4 channels) backed by the endpoints above. |

### Producers wired to real call sites
| App | Event | Where | Previously |
|---|---|---|---|
| Ryft | `ryft.repayment.posted` | `routes/finance.ts` `POST /finance/entries/:id/repayments` | Silent — only entry *creation* notified (`finance-notify.ts`), a repayment posting against an existing entry told nobody. |
| Verve | `verve.offer.received` | `routes/marketplace-offers.ts` `POST /marketplace/listings/:id/offers` | Silent — the seller had no way to find out short of polling "My Listings." |
| Verve | `verve.order.approved` / `verve.order.rejected` | `routes/marketplace.ts` admin order resolve | Was a raw one-off `INSERT INTO notifications`, in-app only. **Replaced, not duplicated** — kept as one bus call so the buyer doesn't get double-notified on the bell. |
| Warde | `warde.member.invited` | `routes/teams.ts` `POST /teams/:id/invite` | Only a live SSE push (`broadcastToUser`, silent no-op if the invitee isn't on the page right now) — kept, now paired with the bus call for Telegram/email/bell reach. |

**Skarn** (`notifySkarnClaimWindowOpening`) is implemented and callable end
to end, but deliberately left unwired: there is no claim-window scheduler
anywhere in this codebase to call it from (projects/tasks carry deadlines,
but nothing computes "a snapshot/claim window is opening soon" the way
Finance's late-fee cron or the vault health scan do). Wiring it without
that scheduler would mean a stub caller firing a fake event — a follow-up,
not something to fake here.

### Unified Search
| File | Change |
|---|---|
| `routes/search.ts` | Added Ryft (`finance_ledger_entries` by title/kind, `wallets` by label/address/chain/notes) and Verve (`marketplace_listings` by title/description, scoped to the user's own listings + everyone's active ones) sections to the existing federated query. Sylo/Skarn/Wisp sections unchanged. |
| `components/global-search.tsx` | Added Finance/Wallets/Marketplace result sections (⌘K palette used across most of the app). |
| `components/command-search.tsx` | Same three sections added to the second, simpler search widget mounted directly in `App.tsx` — this one flattens results into a single typed list rather than grouped sections, so it got the equivalent `finance`/`wallet`/`marketplace` `ResultType` entries + icons instead. |

Finance/wallet/marketplace results route to their app's dashboard/hub
page rather than a specific record — unlike vault entities/local
accounts, there's no per-record detail route for a ledger entry, a
wallet, or a listing anywhere in the frontend yet, so this doesn't invent
one.

## What wasn't done / open follow-ups
- Skarn claim-window producer has no scheduler to call it (see above).
- No webhook/developer-platform subscriber (master plan §12) consumes
  these event types yet — the bus's typed events are the natural hook
  for that later, not built now.
- No automated test coverage added for `emitEvent()` or the preferences
  endpoints — this pass leaned on the existing per-module test patterns
  not being disturbed (all changes are additive call sites, no existing
  behavior removed except the marketplace order raw-insert, replaced
  1:1) rather than adding new test scaffolding.
- No `pnpm install`/typecheck was run against these changes — this
  sandbox has no network access to install dependencies. Every edit was
  hand-checked against the actual exported symbols/table columns/schema
  shapes in the surrounding code (see each file's imports), and brace/
  paren counts were verified to balance, but a real `tsc` pass is worth
  running before treating this as shippable.
