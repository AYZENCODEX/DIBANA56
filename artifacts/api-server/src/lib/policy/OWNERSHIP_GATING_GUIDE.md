# Ownership gating guide

**Route Integration Roadmap — Season C, Phase C33 (Pattern documentation +
CI lint guard), part 1 of 2.** Part 2 is
`scripts/src/check-ownership-gate-coverage.ts` — a CI check that enforces
the convention this doc describes. That script's own header explains
exactly what it can and can't see; this doc explains the judgment calls
that go into satisfying it correctly, which the script itself cannot make
for you.

## Why this doc exists

C19A through C31 gated ~40 `:id` routes against `requireOwnership()`, one
phase at a time, each one manually audited. Nothing in the codebase ever
*required* a new route to follow that pattern — it was convention, carried
phase to phase by whoever happened to read the last phase's CHANGES doc.
That's how routes went ungated for a long time before anyone noticed: not
because the pattern was wrong, but because it was nowhere written down as
the thing to do, only demonstrated. This doc is that missing "the thing to
do" — read it once, wire routes correctly the first time, and
`check-ownership-gate-coverage.ts` (C33 part 2) stops a route without it
from merging silently.

## Step 1 — does this route need a resource builder at all?

Ask: **does this route operate on ONE row that belongs to exactly one
user** (a vault entry, a KYC entry, a local account, a finance entry)?

- **Yes, single-owner row** → you need a `ResourceRefBuilder` +
  `requireOwnership()`. Go to Step 2.
- **The resource has two roles that both count as "owner"** (e.g.
  `ayzen_mail`'s sender/receiver — either party can act on a message) →
  you still use `requireOwnership()`, but the builder itself folds the OR
  logic into a single `ownerId` (see "Dual-role resources" below).
- **Admin-only, no per-user ownership concept** (e.g.
  `/admin/oidc-clients/:clientId`) → gate with `requireAdmin`/`requireRole`
  instead; `requireOwnership()` doesn't apply. `check-ownership-gate-
  coverage.ts` will still flag these as "unwired" by its own narrow
  definition (it only looks for the `requireOwnership()`/`authorizeMany()`
  family) — that's expected, not a bug to fix; see that script's own
  "Known limitations" section.
- **Public / token-possession-is-auth** (e.g. `/finance/receipt/:token`,
  `/r/:code`) → no per-user ownership check applies; the token itself is
  the credential. Same as above, this will show up in the lint baseline,
  correctly.
- **Bulk endpoint, array of ids in the body, not a URL `:id`** → different
  shape entirely, use `authorizeMany()` (Phase C13/C27's pattern,
  `ayzenMailboxBulkOwnershipEngine` is the reference implementation) — a
  single `ResourceRefBuilder` checks one resource per request; a bulk
  endpoint needs to check N rows before acting on any of them.

If you're unsure which bucket a route falls into, that's a **design
decision**, not a coding question — see C28/C29 for how this series
handled that (both paused code and got an explicit owner sign-off before
writing a builder). Don't guess; a `ResourceRefBuilder` you write today
because "it's probably user-owned" is a security promise the DB schema
needs to actually back up (see Step 2's "no schema guess" rule).

## Step 2 — writing the `ResourceRefBuilder`

```ts
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const FOO_OWNER_SENTINEL_NONE = -1;

const fooResource: ResourceRefBuilder = async (req) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) {
    return { type: "foo", id: req.params.id, ownerId: FOO_OWNER_SENTINEL_NONE };
  }
  const [row] = await db.select({ userId: fooTable.userId })
    .from(fooTable).where(eq(fooTable.id, id)).limit(1);
  return { type: "foo", id, ownerId: row?.userId ?? FOO_OWNER_SENTINEL_NONE };
};
```

Rules, all non-negotiable, taken directly from every builder in this
series (`vaultEntryResource`, `kycEntryResource`, `localAccountResource`):

- **Exactly one DB read.** A builder resolves one fact — who owns this
  row — and nothing else. If your route needs more context than that to
  decide access, that's a sign you need a different/additional
  `PolicyRule` (ABAC, ReBAC — see `lib/policy/abac/`, `lib/policy/rebac/`),
  not more logic stuffed into a `ResourceRefBuilder`.
- **A non-numeric/malformed id and a row-not-found both resolve to the
  SAME sentinel** (`ownerId: FOO_OWNER_SENTINEL_NONE`, conventionally
  `-1`), never `undefined`/`null`/throwing. `requireOwnership()` compares
  `ownerId === subject.userId` — a sentinel that can never equal a real
  user id is what makes "malformed input" and "doesn't exist" both
  correctly fall through to DENY, with no special-casing needed anywhere
  else in the chain.
- **Never guess the owner column from the table/route name.** Read the
  actual schema (`lib/db/src/schema/*.ts`) or the raw-SQL table's real
  columns before writing the `SELECT`. `vault_entries`/`local_accounts`
  use `user_id`; `kyc_entries` (a legacy table not in the drizzle schema)
  also uses `user_id` but needs the raw-SQL shape below because it isn't
  drizzle-modeled. Don't assume; check.
- **Two DB-call shapes exist in this codebase** — use whichever matches
  the table:
  - Drizzle-modeled table: `db.select({ userId: table.userId }).from(table)
    .where(eq(table.id, id)).limit(1)`, row shape `{ userId }`.
  - Legacy/unmodeled table: `db.execute(sql\`SELECT user_id FROM foo WHERE
    id = ${id} LIMIT 1\`)`, row shape `result.rows[0].user_id` (snake_case
    — raw SQL, no drizzle column mapping).

### Dual-role resources

If a resource has two columns that can each count as "owner" (see
`ayzen-mail.ts`'s `ayzenMailPartyResource` — `to_user_id` OR
`from_user_id`), fold the OR into the builder itself rather than writing a
new `PolicyRule`:

```ts
const ownerId = (row?.toUserId === subject.userId || row?.fromUserId === subject.userId)
  ? subject.userId
  : SENTINEL_NONE;
```

`requireOwnership()`'s single `ownerId === subject.userId` comparison is
still the only check that runs — the builder just decides, per request,
whether that comparison should succeed. If the handler downstream needs to
know *which* role matched (e.g. to pick a sender-branch vs receiver-branch
of business logic), keep two separate DISTINCT sentinels (one per losing
case) so `onDeny` — or the handler, reading `req.authorization`, see
`pep/types.ts`'s `AuthorizeOutcome` — can still tell them apart if it
needs to render a different body per case (see "Choosing `onDeny`" below,
the "compound deny" case).

## Step 3 — wiring it up

Most files define a thin, local, one-line wrapper rather than calling
`requireOwnership()` inline at every route:

```ts
function requireFooOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, fooResource, { onDecision: pepDecisionObserver, onDeny });
}
```

Always pass `onDecision: pepDecisionObserver` (from `middlewares/auth.ts`)
— that's what makes the decision show up in the durable
`authorization_audit_log` table and in Phase 17's observability surface.
Every migrated route in this series does this; omitting it doesn't break
the ALLOW/DENY outcome but silently drops that route out of the audit
trail every other gated route has.

**Export the wrapper (and the underlying `ResourceRefBuilder`, if the
wrapper itself isn't exported) only when another file genuinely needs the
same table/owner shape** — `vaultEntryResource`
(`vault-entity-links.ts`) and `kycEntryResource` (`kyc.ts`) are the only
two `ResourceRefBuilder`s in the whole `routes/` tree reused across files,
precisely because `entities.ts`/`value-history.ts`/`vault.ts` all gate the
same `vault_entries` table, and `exchange-api.ts` gates the same
`kyc_entries` table `kyc.ts` already does. If nothing else needs your
table/owner shape, keep the builder and wrapper file-local (unexported) —
that's the default every other file in this series uses, not a
short-cut.

`check-ownership-gate-coverage.ts` recognizes a wrapper as valid wiring
whether it's file-local or imported from another file (see that script's
own header for exactly how it resolves that) — you don't need to export
anything purely to satisfy the lint check, only when a second file
actually reuses the shape.

## Choosing `onDeny`

Every migrated route in this series uses one of three deny shapes. Pick
based on what the route told callers *before* it was gated — this series'
own rule has always been "preserve pre-existing behavior exactly," never
silently "upgrade" a deny body while adding the gate:

1. **Explicit 404, `{ error: "X not found" }`** — the default for reads
   and most writes. Tells the caller "this id doesn't resolve for you,"
   without distinguishing "doesn't exist" from "not yours" (which is the
   point — see the sentinel rule above; both cases produce the identical
   response, so an attacker enumerating ids learns nothing extra from a
   404 alone).
   ```ts
   requireFooOwnership("foo.read", (_req, res) => { res.status(404).json({ error: "Foo not found" }); })
   ```

2. **Silent no-op, 200 with an empty/success-shaped body** — for routes
   whose PRE-GATING behavior was already "return something inert for a
   non-owned/nonexistent id," not an error. `value-history.ts`'s `GET
   /vault/:id/value-history` returns `res.json([])` (an empty history list
   reads identically to "no history yet" whether the id isn't yours or
   doesn't exist); `kyc.ts`'s `DELETE /kyc-entries/:id` returns
   `res.json({ success: true })` (deleting something that isn't yours
   reports back as "already gone," not as an error that would tell an
   attacker their guessed id exists). **Never introduce this shape when
   gating a route that previously had no ownership check at all** — that
   would be new behavior, not preservation. Only use it when the route's
   own pre-gating code already replied this way for a bad id.

3. **Compound / role-aware deny** — for dual-role resources where the
   deny body itself needs to differ by *why* it denied (not just
   owner-vs-nonexistent). `ayzen-mail.ts`'s `DELETE /ayzen-mail/:id` is
   the one example in this codebase: nonexistent id → `404 "Not found"`,
   existing-but-not-your-mail id → `403 "Forbidden"`. This needs the
   4-argument `onDeny: (req, res, next, outcome) => void` signature (see
   `pep/types.ts`'s `PepResponseOptions`) instead of the short 2-arg form,
   reading `outcome.request?.resource.ownerId` to tell which sentinel
   fired and choosing the response accordingly. Reach for this only when
   the pre-existing behavior genuinely had two distinct deny bodies for
   two distinct reasons — don't add this complexity to a route that was
   fine with one deny body before gating.

**In all three cases: read the route's CURRENT deny behavior before
gating it, and reproduce it exactly.** Every phase in this series has
treated a body/status change as a scope creep to avoid, not a chance to
"improve" error messages — that's a separate, deliberate decision (like
C28/C29's), not a side effect of adding a gate.

## Checklist before you open a PR

- [ ] Read the real schema/table columns — no guessed owner column name.
- [ ] Builder: one DB call, correct shape (drizzle `.select().limit(1)` vs
      raw `db.execute(sql\`...\`)`), single sentinel for both
      malformed-id and not-found.
- [ ] `onDecision: pepDecisionObserver` passed through.
- [ ] `onDeny` reproduces the route's pre-existing deny status/body
      exactly — checked against the actual current handler, not assumed.
- [ ] Builder/wrapper exported ONLY if a second file will reuse the exact
      same table/owner shape.
- [ ] `npx tsx scripts/src/check-ownership-gate-coverage.ts` passes
      without needing `--update-baseline` (if it doesn't, either wire the
      route or, if it's a deliberate non-ownership route per Step 1,
      re-run with `--update-baseline` in its own commit with a reason in
      the message).
