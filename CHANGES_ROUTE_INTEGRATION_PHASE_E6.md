# Route Integration Roadmap — Season E, Phase E6: long-tail triage — remaining ~34 files, ~80 routes

## Scope, as roadmapped
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`'s E6 — findings doc first, per
that file's own instruction. The question for every route below was never
"is this safe" (D4, Season D, already confirmed every one of these is
raw-SQL-scoped-safe or otherwise non-ownership-shaped) but **"does wiring
it through `requireOwnership()` add anything, at a cost proportionate to
the file's size"** — large shared-shape clusters get a builder; isolated
routes get an explicit, reviewed "not wired, and here's why" note instead
of a fresh `ResourceRefBuilder` per file.

Every one of the 96 baseline entries this phase started from (post-E5) was
read against its actual current handler — not against the roadmap's own
preliminary bucket guesses, which this phase (like E3/E4/E5 before it)
revises down for several files.

## Promoted (7 routes, 3 files) — genuine gaps with an existing or trivially-shared builder

| Route | File | Builder used | `onDeny` |
|---|---|---|---|
| `GET /marketplace/listings/:id/offers` | `marketplace-offers.ts` | `marketplaceListingResource` (imported, newly exported from `marketplace.ts`) | `res.json([])` — reproduces the pre-existing "JOIN matches nothing" empty-array behavior for a non-owner/nonexistent listing |
| `GET /vault/snapshots/:id/download` | `vault-snapshot.ts` | new `vaultSnapshotResource` | 404 `{ error: "Snapshot not found" }` (strict-id: 400 `{ error: "Invalid snapshot id" }` for a non-numeric id) |
| `PATCH /vault/snapshots/:id` | `vault-snapshot.ts` | same | same strict-id split, 404 body `{ error: "Snapshot not found" }` |
| `DELETE /vault/snapshots/:id` | `vault-snapshot.ts` | same | same strict-id split, 404 body `{ error: "Snapshot not found" }` |
| `POST /vault/snapshots/:id/restore` | `vault-snapshot.ts` | same | same strict-id split, 404 body `{ error: "Trashed backup not found" }` |
| `DELETE /vault/snapshots/trash/:id` | `vault-snapshot.ts` | same | same strict-id split, 404 body `{ error: "Trashed backup not found" }` |
| `GET /exchange-balance/:id` (was `:kycId`) | `exchange-api.ts` | `kycEntryResource` (imported from `kyc.ts`, already exported there in C19B) | 404 `{ error: "KYC entry not found" }` (strict-id: 400 `{ error: "Invalid KYC ID" }`) |

### `marketplace-offers.ts` — reused, not rebuilt
`marketplace.ts` already has `marketplaceListingResource`/
`requireMarketplaceListingOwnership` (Phase C16) for the exact same
`marketplace_listings`/`seller_id` shape this route needs (a seller
viewing offers on their own listing). Exported it (same reuse precedent
as `kyc.ts`'s `kycEntryResource`, per the Guide's "Wiring it up" section)
instead of hand-rolling a second copy. No new `ResourceRefBuilder` in this
file.

### `vault-snapshot.ts` — new builder, deliberately deletedAt-agnostic
`vault_snapshots` has one owner column (`user_id`), same shape as every
other single-owner resource in this series — but the file's 5 routes
split into two deletedAt-conditioned groups (download/PATCH/DELETE require
live; restore/purge require trashed). Rather than write two builders (or
one that inspects a specific route's business rule — the Guide's Step 2
forbids stuffing extra logic into a builder), `vaultSnapshotResource`
resolves only ownership, ignoring `deletedAt` entirely; each handler's own
already-correct deletedAt-conditioned query still runs afterward and
produces the identical pre-existing 404 for the wrong-state case. Verified
by hand: owner + right state → unchanged 200; owner + wrong state → same
404 the handler already gave; non-owner/nonexistent → same 404, now via
the gate.

### `exchange-api.ts` — path param renamed, no URL change
`:kycId` → `:id` so this route matches `kycEntryResource`'s hardcoded
`req.params.id` read, same as `kyc.ts`'s own `PATCH
/kyc-entries/:id/exchange-keys` (already wired, C19B) does. Renaming an
Express route param name changes nothing about the URL a client requests.

### The "strict id" wrapper, three times
`vault-snapshot.ts` (all 5 routes) and `exchange-api.ts` each had a
pre-existing `Number.isFinite`/`isNaN` check ahead of any DB call, replying
a distinct `400 "Invalid ... id"` — different from the "not found" 404. A
plain sentinel-and-onDeny would have collapsed that into the wrong status,
a real behavior change. Same fix as Phase C11's
`requireAyzenMailboxMessageOwnershipStrictId`: `onDeny` itself re-checks
the id's validity and reproduces the exact prior split. `marketplace-
offers.ts`'s route had no such pre-existing check (a malformed id there
just silently matched nothing in the JOIN), so its wrapper is the plain
form.

## Reviewed, deliberately NOT wired (82 routes) — reasons, by shape

Every route below was read against its actual handler, not assumed safe
from the roadmap's file list alone. None of them is a "someday" gap for a
future phase to pick up (except the two explicitly flagged as reserved
below) — each is a permanent, correct member of the baseline for the
stated reason, same posture C33's baseline-generation comment and D4's own
close-out both already established for this category.

### Public / no ownership concept applies (read is open to anyone, or the resource itself has no owner)
`marketplace.ts` (`GET /listings/:id`, `GET /listings/:id/history`),
`marketplace-bundles.ts` (`GET /bundles/:id`), `marketplace-discovery.ts`
(`GET /listings/:id/similar`), `marketplace-analytics.ts` (`GET
/listings/:id/views`), `marketplace-reviews.ts` (`GET /sellers/:id/
reviews`, `GET /sellers/:id/rating`), `marketplace-spot.ts` (`GET
/orderbook/:pair`, `GET /trades/:pair`, `GET /candles/:pair` — `:pair` is
a trading-pair string, not a per-user row), `tools.ts` (`GET /gas/
:network` — public network data; `GET /streak/:userId` — a viewable
profile stat, not private data, same as any other user's public profile
fields), `polymarket.ts` (`GET /markets/:id` — external market data,
login-gated but not owned by any single user), `oidc-rollout-flag.ts`
(`GET /rollout-flags/:appId` — public feature flag, no auth at all),
`layout.ts` (`GET /layout/:pageKey` — shared page-layout config, same
per-page data for every viewer), `content.ts` (`GET /generated/
:projectId`, `GET /memory/:projectId` — `projects`/`generated_content`
have no owner column at all; **C28's own owner sign-off already decided
this**, re-confirmed here, not re-litigated), `email-routing.ts` (`GET
/check/:username` — a username-availability check, the whole point of
which is to be checkable by anyone), `oidc-register.ts` (`GET`/`PUT
/register/:client_id` — RFC7592 registration-access-token possession IS
the credential, same bucket as `/finance/receipt/:token`).

### Cross-user by design (the caller is deliberately NOT the resource's owner)
`marketplace.ts` (`POST /listings/:id/buy` — buyer acting on someone
else's listing, `seller_id === userId` is explicitly rejected inline;
`POST`/`DELETE /listings/:id/favorite` — favoriting someone else's
listing), `marketplace-bundles.ts` (`POST /bundles/:id/buy`),
`marketplace-nft.ts` (`POST /nft/listings/:id/like`), `marketplace-
reports.ts` (`POST /listings/:id/report`, `POST /sellers/:id/report` —
reporting someone else's listing/seller), `marketplace-offers.ts` (`POST
/listings/:id/offers` — buyer making an offer on someone else's active
listing; `seller_id === userId` is explicitly rejected inline, same as
`buy` above), `finance-invoices.ts` (`POST /invoices/public/:token/
submit-payment` — a debtor submitting a payment claim on a creditor's
invoice via the invoice's own public token, not their own row),
`nft-subscriptions.ts` (`POST /:id/buy`), `ad-tasks.ts` (`POST /:id/
complete` — completing a shared, admin-managed ad task, not a row the
caller owns), `reward-links.ts` (`POST /:id/complete` — same shape as
`ad-tasks.ts`), `tasks.ts` (`GET /:id`, `GET /:id/steps`, `POST /:id/
visit`, `GET /:id/visit`, `POST /:id/submit` — `tasks` is an
admin-managed shared catalog (`PATCH`/`DELETE /:id` are already
`requireAdmin`-gated); every one of these five records the CALLER's own
row in a side table (`task_link_visits`, `task_submissions`) scoped by
`user_id`, never checks ownership of the task itself, because there is
none to check), `messages.ts` (`GET /:otherUserId`, `POST /:toUserId` —
the param is the OTHER party to a conversation, not a resource the caller
owns; every query already includes the caller's own `userId` on one side
of an OR).

### Self-scoped — own-row action, no separate resource-id to compare against
`local-accounts.ts` (`POST`/`DELETE /category-receipt/:category`, `POST
/category-receipt/:category/email` — `:category` is a string key, every
query scoped directly by `user_id = <caller>`, same shape D6/E4 already
established for `teams.ts`'s 6 entries), `marketplace-wallet.ts` (`POST
/wallet/:type/deposit`, `POST /wallet/:type/withdraw` — `:type` is one of
4 fixed enum values, always the caller's own wallet row), `bulk.ts` (`GET
/csv/export/:resource` — `:resource` is an enum key, always scoped to the
caller), `finance.ts` (`PUT /currencies/:currency` — `:currency` is a
currency code, upserted on `(userId, currency)`, always the caller's own
row), `watchlist.ts` (`POST`/`DELETE /:projectId` — the caller's own
watchlist entry, keyed by project but never looking up another user's
row), `oidc-connected-apps.ts` (`POST /connected-apps/:clientId/revoke`
— revokes the caller's own `(userId, clientId)` consent pair, no
foreign-row lookup).

### Compound/business-logic shape a single `ownerId` check can't express
`vault-shares.ts` (`GET /entity/:entityType/:entityId` — this route's own
job is to return a *different response shape* depending on whether the
caller is the owner, a field-scoped sharee, or neither; collapsing that
into an allow/deny gate would be the wrong abstraction, per the Guide's
own Step 2 note: "If your route needs more context than that to decide
access, that's a sign you need a different/additional `PolicyRule`, not
more logic stuffed into a `ResourceRefBuilder`." `GET /fields/:entityType`
is a public schema-metadata read, not ownership-shaped at all).

### Explicitly reserved for a different, already-named phase — not this one's to touch
`wallets.ts` (`GET`/`POST /:id/phrase`) — the file's OWN pre-existing
comment (predating this phase) already explains why: revealing a wallet's
seed phrase is gated by a step-up/reveal-token check that runs first, and
"reordering an ownership check ahead of an existing step-up check would
change which failure a caller without a reveal token sees first — that's
a judgment call for whoever picks up Phase B2, not a mechanical one."
E6 is a mechanical sweep; touching this pair would be exactly the kind of
non-mechanical judgment call that comment reserves for a different,
named phase. Left untouched, on purpose, deferring to that existing note
rather than re-deciding it here.

### Already covered by a prior, unrelated decision
`project-dates.ts` (`GET /:id/dates`) — C29's own decision-pending note,
unchanged; `teams.ts`'s 6 entries — E4's own reviewed disposition,
unchanged; `projects.ts`'s remaining entries — E3's own re-triaged
disposition (public/self-scoped bucket), unchanged. Listed here only for
completeness of "why the 96→89 delta is exactly 7, not more" — no new
review performed on these three groups in E6.

### `auth.ts` (2 routes) — one public/token, one self-scoped-by-parameter
`GET /login/step-up/:token` — token-possession-is-auth, same bucket as
`oidc-register.ts` above. `POST /sessions/:id/revoke` — `revokeSession
(result.userId, sessionId)` (`lib/...`) already takes the caller's own
`userId` as a parameter and scopes internally; there is no separate
raw-SQL lookup a `ResourceRefBuilder` could get more right than the
function signature already guarantees. Building one here would duplicate,
not add, a safety property this route already has by construction.

## Baseline
`tsx scripts/src/check-ownership-gate-coverage.ts` (same globally-installed
`typescript`/`tsx`, temporary local `node_modules/typescript` symlink,
same setup every prior phase used) confirmed, before any edit, the
starting count:

```
Scanned 138 route files, 487 param routes total, 96 unwired,
20 public/token-audit-only (Phase F1, not counted as a gap).
```

After the 3 files' edits, a clean run (no `--update-baseline`) showed
exactly the 7 promoted routes as stale baseline entries and confirmed no
new gap was introduced:

```
OK — no new unwired param routes (96 pre-existing gap(s) in baseline, unchanged).

Note: 7 baseline entries no longer match an unwired route ...
  exchange-api.ts:GET /exchange-balance/:kycId
  marketplace-offers.ts:GET /marketplace/listings/:id/offers
  vault-snapshot.ts:DELETE /vault/snapshots/:id
  vault-snapshot.ts:DELETE /vault/snapshots/trash/:id
  vault-snapshot.ts:GET /vault/snapshots/:id/download
  vault-snapshot.ts:PATCH /vault/snapshots/:id
  vault-snapshot.ts:POST /vault/snapshots/:id/restore
```

`--update-baseline` applied: **96 → 89**. Re-run clean, 89 unchanged.

All 4 touched files (`marketplace.ts`, `marketplace-offers.ts`,
`vault-snapshot.ts`, `exchange-api.ts`) independently syntax-parsed via
the TypeScript compiler API (`ts.createSourceFile`) — 0 parse diagnostics
across all four.

**Real `tsc --noEmit` still not run** — same sandbox limitation every
phase since D6 has flagged (`@workspace/db`/`express`/`drizzle-orm` have
no installed `node_modules` here, no network). Run `pnpm --filter
@workspace/api-server typecheck` in the real toolchain before merge —
`vault-snapshot.ts`'s and `exchange-api.ts`'s edits are new code (a new
builder, a renamed route param), the two categories this series has
consistently flagged as most needing that real check to run.

## Result
| Item | Count |
|---|---|
| Routes promoted | 7 |
| Files touched | 4 (`marketplace.ts` export-only, `marketplace-offers.ts`, `vault-snapshot.ts`, `exchange-api.ts`) |
| New `ResourceRefBuilder`s | 1 (`vaultSnapshotResource`) |
| Existing builders reused via new export/import | 2 (`marketplaceListingResource`, `kycEntryResource`) |
| Routes reviewed and left deliberately unwired, with a stated reason | 82 |
| Baseline shrink | 96 → 89 |
| SQL/behavior change (besides the 2 documented 400→same-400 strict-id preservations, which are NOT behavior changes) | 0 |
| Roadmap's own preliminary estimate for this phase | ~80 (partial), revised down to 7 promoted / 82 reviewed-and-kept, per hand-triage — same pattern every phase since E3 has shown |

## Next
Per `ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`, next is **E7** — close-out:
run `--update-baseline` one final time (already effectively current after
this phase), confirm `auditFinanceOwnership()`/`auditProjectsOwnership()`
are dead code and remove them if so, and add a "Season E — সম্পূর্ণ
disposition" section to `CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`'s
reference table alongside Season D's.
