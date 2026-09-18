# AYZEN Credits — Consumption Layer (master plan §5/§7 Phase 5)

## Scope
Master plan §7, Phase 5: "AYZEN Credits consumption layer wired into
Zynth/Skarn/Verve/Wisp/Astra/Ryft metered actions, tier = credit grant."
§5 already specifies the billing model (usage-based, not feature-gated)
and lists candidate metered actions per app — this pass builds the actual
deduction mechanism and wires it into the real endpoints that exist today.

Confirmed before writing any code, same as the subdomain-split passes did:
which of the six apps' "metered action" actually has a shippable endpoint
right now, versus which one is still ahead on the roadmap. Two of six
(Skarn, Astra) turned out to be the latter — see "What was NOT wired, and
why" below. Wiring a charge into an action that can't happen yet would
just be dead code with no way to verify it's correct.

## The core mechanism — `services/credit-meter.ts` (new)
One file, reused by every app, instead of six separate metering
implementations:

- **`METERED_ACTIONS`** — a single registry mapping an action key
  (`"zynth.ai_query"`, `"ryft.report_export"`, etc.) to its app, label, and
  cost in credits. This is the one-file edit the pricing pass §8 calls out
  as still open will actually touch — no route file needs to change to
  reprice an action.
- **`requireCreditBalance(actionKey)`** — pre-flight middleware. Blocks
  with `402 OUT_OF_CREDITS` (balance, cost, and a `topUp` pointer at
  `POST /credits/purchase`) before a request that can't be paid for does
  any work. Supports `exemptRoles` for the admin/ops case (see `ai.ts`
  below).
- **`chargeCredits(userId, actionKey)`** — the actual deduction. Same
  atomic `UPDATE credits SET balance = balance - cost WHERE balance >=
  cost` pattern `routes/credits.ts`'s `/credits/swap` and
  `/credits/buy-subscription` already use (both of those have their own
  code comments explaining why: two concurrent requests reading a stale
  balance into JS and writing back independently is a real race that lets
  a balance go negative — computing the new value in SQL instead of JS
  closes it). Every charge writes a normal `credit_transactions` row
  (`type: "usage_debit"`), so usage shows up in `GET /credits`'s existing
  transaction history for free, no new endpoint needed.
- **`hasCreditBalance(userId, actionKey)`** — the same pre-flight check as
  a plain function, for routes where whether an action is metered at all
  depends on something only known inside the handler (e.g. `/finance/
  reports/custom`: JSON view is free, CSV/PDF export is metered).
- **`refundCredits(userId, txId)`** — inserts a compensating
  `"usage_refund"` row rather than mutating the original charge, keeping
  the ledger an honest append-only log (available for a handler that finds
  out an action needs unwinding after the charge already landed; none of
  the integrations below currently need it, since all of them charge
  strictly after success — see next section).

## Charge-on-success, not charge-then-refund
Every integration below charges **after** the metered action has actually
succeeded (AI reply received, report actually built, mail actually
accepted by SMTP, listing actually boosted) — never before. A user is
never billed for a request that 500s downstream. This is why
`requireCreditBalance` only *checks* balance; the charge itself is a
separate call the handler makes once it knows the action worked. Where a
route only conditionally meters (Ryft's JSON-vs-export split), the check
is inlined with `hasCreditBalance` instead of the blanket middleware, for
the same reason.

## What was wired, per app

| App | Route | Action key | Cost | Notes |
|---|---|---|---|---|
| **Zynth** | `POST /ai/chat` | `zynth.ai_query` | 5 | Admin/operator console use of this same endpoint (`buildAdminContext()`) is exempted via `exemptRoles` — that's AYZEN ops tooling, not a user spending their own pool. |
| **Ryft** | `GET /finance/reports/custom` (CSV/PDF only) | `ryft.report_export` | 15 | Viewing the same report as JSON stays free — "basic ledger stays free" per §5. `/finance/export` and the four canned report routes (trial-balance, balance-sheet, income-statement, cash-flow) were deliberately left unmetered this pass — see open items. |
| **Verve** | `GET /marketplace/analytics/revenue`, `GET /marketplace/analytics/top-listings` | `verve.premium_analytics` | 8 | `/marketplace/analytics/overview` (basic seller stats) stays free. |
| **Verve** | `POST /marketplace/listings/:id/boost` (new route) | `verve.boosted_listing` | 50 | Self-serve seller-facing boost, separate from the existing admin-only `PATCH /admin/marketplace/listings/:id/feature`. Sets `is_featured=TRUE` + a 7-day `featured_until` (new column) rather than a permanent flip — a paid boost rotates off, an admin feature doesn't. `/marketplace/listings/featured` and `/marketplace/search`'s `ORDER BY` were both updated to respect the expiry. |
| **Wisp** | `POST /email-accounts/:id/send` | `wisp.custom_send` | 2 | Personal AYZEN mail (`POST /ayzen-mail`) is untouched and stays free — this route is specifically the external-SMTP-relay / custom-routing case §5 calls out. |

`GET /credits` (`routes/credits.ts`) now also returns `meteredActions:
Object.values(METERED_ACTIONS)` alongside the existing balance/packages/
rates payload, so the Workspace hub and Astra toolbar can show "costs N
credits" next to an action before the user triggers it, without a second
round trip.

## What was NOT wired, and why

- **Skarn — `skarn.automation_run`.** `CHANGES_SKARN_SUBDOMAIN_SPLIT.md`'s
  own finding, re-confirmed by reading `routes/tasks.ts` / `ad-tasks.ts` /
  `game-entries.ts` again for this pass: Skarn ("Protocols") today is
  entity-tracked, human-submitted task completion — there is no automated
  claim-execution engine to meter yet. §5's own table draws this exact
  line ("Manual monitoring stays free, automation costs credits") — there
  being nothing to charge for right now is consistent with that, not a
  gap. The registry entry exists (`METERED_ACTIONS["skarn.automation_run"]`,
  10 credits) so wiring it in later is a one-line `chargeCredits()` call at
  the point an automation engine actually executes a claim, not a redesign.
- **Astra — `astra.premium_widget`.** `CHANGES_ASTRA_V1_EXTENSION.md`
  confirms Astra v1 shipped is autofill-only, matching the master plan's
  own phase split — Ryft Connect / Skarn Watch / Zynth Ask / Verve Price
  Ping (the actual premium widgets) are explicitly **Astra v2, Phase 6**,
  not yet built. Same situation as Skarn: registry entry ready (3 credits),
  no endpoint yet to attach it to.

Both are left as registry-only entries on purpose rather than stubbed
against something that doesn't exist — that would be a charge nobody could
ever trigger, which is worse than no charge at all (dead code pretending
to be tested).

## Schema change
One column, appended to `lib/schema-migrations.ts`'s existing
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` list (same additive-migration
convention every prior phase in this codebase uses — no new numbered
`.sql` file, no destructive change):

```
ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS featured_until TIMESTAMP
```

Nothing on `credits` / `credit_transactions` needed to change — `type` is
a free-text column with no CHECK constraint, so `"usage_debit"` /
`"usage_refund"` slot in next to the existing `"purchase"` / `"swap_to_azn"`
/ `"azn_subscription"` values without a migration.

## What was tested
- Brace/paren/bracket balance checked on every edited file (no
  `node_modules` in this sandbox — same constraint every prior pass in
  this series has noted).
- Ran `tsc --noEmit` (skipLibCheck, no path aliases resolvable without the
  real workspace `node_modules`) against every new/edited file. Every
  reported error is an unresolvable-module / missing-`@types/node` error
  identical in kind to what the same command reports against untouched
  files in this codebase (e.g. `lib/auth-utils.ts`) — i.e. expected given
  the sandbox, not something introduced by this pass. Zero `TS1xxx` parse
  errors anywhere.
- Not tested: an actual DB round-trip (charge → balance decrement →
  transaction row → `GET /credits` reflecting it), or the boost endpoint's
  `featured_until` expiry against a live Postgres `NOW()`. Both need a
  real database connection this sandbox doesn't have.

## What's still open
- **Pricing pass** (§8, already an open item before this phase): the seven
  costs in `METERED_ACTIONS` are a first pass, not a finance-reviewed
  number. Centralized in one file specifically so this is cheap to revisit.
- **Ryft's other report/export routes** (`/finance/export`, and the four
  canned reports) are still free. Only `/finance/reports/custom`'s CSV/PDF
  path is metered this pass — worth a follow-up decision on whether the
  canned reports count as "advanced" too, or stay part of the free basic
  ledger.
- **Skarn automation + Astra v2 widgets** — registry entries only, per
  above; wiring them in is blocked on those features existing, not on
  anything in this consumption layer.
- **Refund-on-partial-failure** isn't exercised anywhere yet (every current
  integration charges strictly after success, so there's nothing to refund
  from) — `refundCredits()` exists and is ready whenever a future metered
  action's "success" boundary is fuzzier than these five.
