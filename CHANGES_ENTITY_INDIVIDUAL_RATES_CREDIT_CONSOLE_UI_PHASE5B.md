# PHASE 5b — Entity individual rates + Credit Console UI (admin + user)

Builds on `services/credit-meter.ts` (Phase 5) and
`routes/admin-credit-console.ts` (Phase 5 follow-up). Request, in order:

1. Vault entity create/edit — local, KYC, game, "Entity individual rate"
2. Ryft finance features — confirmed already shipped, listed below
3. Invoice/receipt — confirmed already shipped, listed below
4. Credit rate configurable — confirmed already shipped (Phase 5 follow-up);
   now actually reachable from a UI (below)
5. Admin credit console — confirmed already shipped as an API; now has a UI
6. User credit console — confirmed already shipped as an API; now shows
   the metered-action rate list in its UI

## 1. "Entity individual rate" — what it turned out to mean

Before writing code: grepped the whole api-server for any existing
per-record rate concept (`individual_rate`, `entity_rate`, `custom_rate`)
— none existed. Sylo has four entity kinds, all with their own
create/edit routes already (`vault.ts`, `local-accounts.ts`, `kyc.ts`,
`game-entries.ts`, matching `lib/schema-migrations.ts`'s own
`local_accounts` / `kyc_entries` / `game_entries` CREATE TABLE comments:
"same shape as vault_entries" / "same shape as kyc_entries"). But only
`vault_entries` had a metered view action
(`sylo.vault_entity_view`) — local accounts, KYC entities, and game
entries were completely unmetered. Read as: give each entity kind its
own **individually configurable** rate, the way vault entries already
had, rather than one blanket Sylo-wide price.

### `services/credit-meter.ts`
Three new registry entries, same shape as the existing
`sylo.vault_entity_view` (1cr each, code default):
- `sylo.local_account_view`
- `sylo.kyc_entry_view`
- `sylo.game_entry_view`

No schema migration needed — `credit_action_pricing` (migration 107)
already stores per-action-key overrides generically, and
`GET/PATCH/DELETE /admin/credits/actions` already work for any key in
`METERED_ACTIONS`. Adding these three rows is a pure code change on top
of infrastructure that already exists — the console reprices them with
zero console-side changes.

### Wired in, charge-on-success (same two-step pattern as every prior
Phase 5 integration: `requireCreditBalance` pre-flight, `chargeCredits`
only after the row was actually found — a 404 never touches the ledger):

| Route | Action key | Notes |
|---|---|---|
| `GET /local-accounts/:id` | `sylo.local_account_view` | Existing route, now metered |
| `GET /kyc-entries/:id` | `sylo.kyc_entry_view` | Existing route, now metered |
| `GET /game-entries/:id` | `sylo.game_entry_view` | **New route** — game-entries.ts had list/create/update/delete but no single-fetch at all; added it, mirroring local-accounts.ts's/kyc.ts's existing GET/:id shape, metered from day one |

Each response now includes the same `_credits: { charged, newBalance } | null`
field `vault.ts`'s `GET /vault/:id` already returns, for frontend
consistency.

## 2 & 3. Ryft finance + invoice/receipt — confirmed, not rebuilt

Re-read `finance.ts` (73 routes) and `finance-invoices.ts` before touching
anything, per this series' own "confirm before building" convention.
Both are already comprehensive:

- **Finance (Ryft):** books, parties, ledger entries + repayments,
  attachments, ledger-entry receipts (public token + PDF), assets,
  investments, net worth (+ history/snapshots), goals, budgets, recurring
  rules, currencies, CSV import/export, analytics/insights, chart of
  accounts + journal entries, trial balance / balance sheet / income
  statement / cash flow / custom reports, report schedules, amortization,
  depreciation.
- **Invoices:** payment methods, invoices (create/line-items/PDF/send/
  cancel/reopen), public invoice links, invoice branding, passkey-witnessed
  Payment Agreements with dispute handling and evidence PDFs.
- **Vault-entity receipts:** `vault.ts` already has its own
  `POST/DELETE /vault/:id/receipt` + public token/PDF pair, separate from
  the finance-ledger-entry receipt above (a vault entity sale receipt vs.
  a ledger-entry receipt — different subjects, same pattern).

Nothing here needed a code change — flagged in case the request meant
something more specific than what's live; happy to build a named gap if
one turns up.

## 4, 5 & 6. Credit rate configurable + Admin/User Credit Console — UI added

The backend for all three was already done (Phase 5 follow-up); this
pass is UI only, in `artifacts/ayzen/src/pages/`.

### `pages/admin/credits.tsx`
Was a single-purpose top-up Approvals panel (`GET/POST /admin/credits/
:id/approve|reject`). Added a tab switcher:
- **Top-up Approvals** — unchanged, existing behavior.
- **Metered Actions** (new) — every action from `GET /admin/credits/
  actions`, grouped by app, each row showing: label, key, code default,
  live usage stats from `GET /admin/credits/usage` (charge count + total
  credits spent — so a reprice decision is based on real volume, not a
  guess), an editable cost field (`PATCH .../actions/:key`), a Billed/
  Waived switch (`enabled` — waiving never blocks the action, per the
  master plan §5 "tiers aren't feature walls"), the current effective
  cost, and a Reset button (`DELETE .../actions/:key`) that only appears
  once an override exists.
- Generic over `METERED_ACTIONS` — the three new `sylo.*_view` actions
  from §1 above show up here automatically, no console-side code needed
  for them specifically.

### `pages/user/credits.tsx`
Added a sixth tab, **Rates**, next to Buy/Swap/Sell/Send/History. Reads
the `meteredActions` array `GET /credits` already returns (Phase 5),
grouped by app, each with a FREE/`N CR` badge — so a user can see what
viewing a Vault/Local/KYC/Game entity, an AI query, a wallet transaction,
etc. currently costs, before triggering it, matching the "costs N
credits" affordance the original Phase 5 doc called out as the reason
`GET /credits` returns this list in the first place.

## What was tested
- Brace/paren/bracket balance on every edited file.
- `tsc --noEmit` (skipLibCheck, isolated from the real workspace — same
  sandbox constraint every prior pass in this series has hit) against
  every new/edited file, both backend and frontend. Zero `TS1xxx` parse
  errors. Remaining errors are unresolvable-module / missing-`@types`
  errors, same kind reported against untouched files in this codebase.
- Not tested: an actual DB round-trip, or the admin console UI against a
  live `/admin/credits/actions` response (no server/DB in this sandbox).

## What's still open
- `sylo.local_account_view` / `sylo.kyc_entry_view` / `sylo.game_entry_view`
  are priced at 1cr (matching `sylo.vault_entity_view`'s existing default)
  — a first pass, same pricing-pass caveat every action in this registry
  already carries (master plan §8).
- If "Entity individual rate" was actually meant as a **per-specific-
  entity** override (e.g. entity #482 costs 3cr to view, distinct from
  every other local account) rather than per-entity-*type*, that's a
  different, larger feature (a new `vault_entity_credit_rates`-style
  table keyed by entity id, resolved *before* the action-level
  `credit_action_pricing` override in `getMeteredAction()`) — not built
  here; flagging so it's an explicit choice, not a missed requirement.
