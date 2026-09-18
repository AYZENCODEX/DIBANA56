# Route Integration Roadmap — Season E, Phase E5: new resource builder — `vault-attachments.ts` (+ `ayzen-mailbox.ts` re-triage)

## Scope, as roadmapped
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`'s E5 — the file-header itself
requires "আগে হাতে-পড়ে প্রতিটা route-এর owner-column শেপ confirm করে তারপর
builder লেখা" (hand-confirm every route's owner-column shape BEFORE writing
a builder) before touching either of this phase's two files
(`ayzen-mailbox.ts`'s 5 flagged routes, `vault-attachments.ts`'s 5). That
hand-triage changed the outcome for one of the two files.

## Hand-triage result — the two files are NOT the same shape

### `vault-attachments.ts` — genuine single-owner shape, builder written
Every one of the 5 routes gates on `:id` = a `vault_entries` row, and
`vaultEntriesTable.userId` is a real, distinct owner column a caller could
mismatch against — the file's own `assertEntityOwnership()` has always
computed exactly this fact, just as a bespoke inline `async boolean`
helper predating this codebase's `ResourceRefBuilder`/`requireOwnership()`
pattern, which is why `check-ownership-gate-coverage.ts` never recognized
it as wiring. Same shape as every `*Resource`/`requireXOwnership()` pair in
`finance.ts`/`projects.ts` — genuinely promote-worthy, matching the
roadmap's own prediction for this file.

### `ayzen-mailbox.ts` — re-triage found all 5 already genuinely self-scoped, not promote-worthy
This is the phase's real finding, and it revises the roadmap's own
assumption. The file's OWN pre-existing header comment (Season C,
Phase C11+C12, written well before this roadmap) already explains, for the
`thread/:threadId` pair, exactly why they were deliberately left unwired:
`threadId` is not a single-row primary key with one distinct owner column
— a `resolveThreadId()` value is derived from the RFC Message-ID header
chain (`lib/mail-threading.ts`), meaning the SAME `threadId` string can
legitimately exist across multiple users' independent copies of the same
conversation (e.g. two people CC'd on the same email each store their own
`ayzen_mailbox_messages` row with a matching `thread_id`). It is a GROUPING
filter across however many of the caller's own rows share that value,
already applied directly in the query (`eq(userId, userId) AND
eq(threadId, threadId)`) — not a lookup-then-compare against a row that
could belong to someone else. There is no non-tautological ownership fact
to check, the exact "self-scoped, no separate resource-id" shape D6/E4
already established for `teams.ts`.

The other 3 routes (`contacts/:email`, `senders/:email` DELETE,
`problematic-recipients/:email` DELETE) are the same shape one level
simpler: `:email` is never a foreign row's primary key at all — it's an
address string, always paired with `userId` in every query
(`ayzenContactsTable`, `mail-spam`/`mail-recipient-reputation`'s own
per-user tables), used to look up or upsert the CALLER's own per-account
record for that address. No row keyed by that email could belong to a
different user in a way that matters here — same "own-row, no separate
owner" shape as `contacts`/`senders`/`problematic-recipients` being
inherently per-account settings, not a shared/owned entity.

**Conclusion: 0 of the 5 `ayzen-mailbox.ts` baseline entries are
promote-worthy.** `makeAyzenMailboxOwnerResource()`, as the roadmap
pre-named it, is not built — there is no genuine owner-column fact for it
to check. This mirrors E3's and E4's own pattern of the roadmap's
preliminary bucket counts being revised down after hand-verification (the
roadmap's own methodology note already flagged its E2-E7 counts as
"preliminary, not final truth"). No code touched in this file; its 5
baseline entries stay, now carrying this doc as their reviewed rationale
(same convention E4 established for `teams.ts`'s 6).

## Code change — `vault-attachments.ts` only

New `ResourceRefBuilder`, reusing `assertEntityOwnership()`'s exact query
(including the `deletedAt IS NULL` condition — a soft-deleted entity must
deny the same way a nonexistent one does):

```ts
const VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE = -1;

const vaultAttachmentEntityResource: ResourceRefBuilder = async (req) => {
  const raw = req.params.id;
  const id = parseInt(String(raw), 10);
  if (!Number.isFinite(id)) {
    return { type: "vault_entry", id: raw, ownerId: VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE };
  }
  const [row] = await db.select({ userId: vaultEntriesTable.userId })
    .from(vaultEntriesTable)
    .where(and(eq(vaultEntriesTable.id, id), sql`${vaultEntriesTable.deletedAt} IS NULL`))
    .limit(1);
  return { type: "vault_entry", id, ownerId: row?.userId ?? VAULT_ATTACHMENT_ENTITY_OWNER_SENTINEL_NONE };
};
```

All 5 routes share one resource type and one pre-existing 404 body
(`{ error: "Entity not found" }`), so one parametrized factory covers all
of them (same shape as `ayzen-mailbox.ts`'s own
`requireAyzenMailboxSubOwnership`):

```ts
function requireVaultAttachmentEntityOwnership(action: string) {
  return requireOwnership(action, vaultAttachmentEntityResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req, res) => { res.status(404).json({ error: "Entity not found" }); },
  });
}
```

Wired as router-level middleware, one call per route, action name per verb:

| Route | action |
|---|---|
| `GET /vault/:id/attachments` | `vault_entry.attachments.list` |
| `POST /vault/:id/attachments` | `vault_entry.attachments.upload` |
| `GET /vault/:id/attachments/:attachmentId` | `vault_entry.attachments.download` |
| `PATCH /vault/:id/attachments/:attachmentId` | `vault_entry.attachments.update` |
| `DELETE /vault/:id/attachments/:attachmentId` | `vault_entry.attachments.delete` |

`POST`'s gate is placed BEFORE `uploadBodyParser`/`sensitiveWriteLimiter`
in the middleware chain (auth → ownership → body-size/rate-limit
middleware → handler) — the ownership check only reads `req.params.id`, so
running it first means a non-owner's request fails fast without the server
ever parsing a large multi-MB body, a small but free improvement, not a
behavior change for legitimate callers.

**`assertEntityOwnership()` itself was NOT removed** — every handler below
keeps its own inline call exactly as before, as defense-in-depth. Same
"keep the working inline check alongside the new router-level gate"
precedent E1's book/entry-derived groups already established for
`finance.ts` (their own inline `assertEntryOwnership()`/scoped-SQL checks
stayed too).

**No SQL/behavior change** — same query, same 404 shape, same soft-delete
handling. What changed: the ownership decision now also runs, and blocks,
at router-level middleware, and is now observable via `pepDecisionObserver`
the same way every other gated route in this codebase is.

## Verification
`tsx scripts/src/check-ownership-gate-coverage.ts` (globally-installed
`typescript`/`tsx`, temporary local `node_modules/typescript` symlink, same
setup every prior phase used):

```
Scanned 138 route files, 487 param routes total, 96 unwired,
20 public/token-audit-only (Phase F1, not counted as a gap).

OK — no new unwired param routes (96 pre-existing gap(s) in baseline, unchanged).

Note: 5 baseline entries no longer match an unwired route ...
  vault-attachments.ts:DELETE /vault/:id/attachments/:attachmentId
  vault-attachments.ts:GET /vault/:id/attachments
  vault-attachments.ts:GET /vault/:id/attachments/:attachmentId
  vault-attachments.ts:PATCH /vault/:id/attachments/:attachmentId
  vault-attachments.ts:POST /vault/:id/attachments
```

`--update-baseline`-equivalent applied by hand: exactly those 5 entries
removed, **101 → 96**. `ayzen-mailbox.ts`'s 5 entries deliberately left in
place (see triage above). Re-run clean, 96 unchanged.

`vault-attachments.ts` also independently syntax-parsed via the TypeScript
compiler API (`ts.createSourceFile`) — 0 parse diagnostics.

**Real `tsc --noEmit` still not run** — same D6-D8/E1-E4 sandbox limitation
(`@workspace/db`/`express`/`drizzle-orm` have no installed `node_modules`
here, no network). Run `pnpm --filter @workspace/api-server typecheck` in
the real toolchain before merge — this file's edit is new code (unlike
E1-E4's pure route-wiring), so it's the one this phase most needs that
check to actually run.

## Result
| Item | Count |
|---|---|
| New `ResourceRefBuilder` + factory | 1 (`vaultAttachmentEntityResource` / `requireVaultAttachmentEntityOwnership`) |
| `vault-attachments.ts` routes promoted | 5 (all of them) |
| `ayzen-mailbox.ts` routes promoted | 0 (all 5 re-confirmed genuinely self-scoped, not a builder gap) |
| Baseline shrink | 101 → 96 |
| SQL/behavior change | 0 |
| Roadmap's own preliminary estimate for this phase | ~10 (revised down to 5, per hand-triage — same pattern as E3/E4) |

## Next
Per `ROADMAP_ROUTE_INTEGRATION_PHASE_E1_E7.md`, next is **E6** — long-tail
triage across ~34 remaining files (~80 routes): `local-accounts.ts`,
`marketplace.ts` + satellite files, `vault-snapshot.ts`/
`vault-backup-cloud.ts`, and ~25 files with 1-2 routes each. Findings-doc
first, per the roadmap's own instruction — large shared-shape clusters get
builders, isolated single-route files likely get an explicit
"intentionally not wired, cost > benefit" note instead, same precedent
this phase (`ayzen-mailbox.ts`) and E4 (`teams.ts`) both just reinforced.
