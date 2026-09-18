/**
 * scripts/src/test-route-ownership-regression.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Route Integration Roadmap — Season C, Phase C32 (Regression suite: manual
 * verification → automated tests).
 *
 * C19A through C31 each verified their own routes by hand: bracket-balance
 * counts, `grep` to confirm wiring, and manually driving owner/non-owner/
 * nonexistent-id requests. This suite codes that same three-case model
 * (see `./lib/ownership-route-test-kit.ts`'s own header for exactly how)
 * so a future change to a resource builder, an action string, or an
 * `onDeny` body is caught here instead of waiting for the next manual
 * audit — the roadmap's own stated goal for this phase.
 *
 * ── Scope: every route reusing one of this codebase's two EXPORTED,
 *    reusable `ResourceRefBuilder`s ─────────────────────────────────────────
 * `vaultEntryResource` (routes/vault-entity-links.ts) and `kycEntryResource`
 * (routes/kyc.ts) are the only two `ResourceRefBuilder`s in the entire
 * `routes/` tree exported for reuse across files — every other file's
 * builder (local-accounts.ts's `localAccountResource`, two-factor.ts's,
 * security.ts's, teams.ts's, finance.ts's two, etc. — 30+ files, see this
 * phase's own CHANGES doc) is file-local. That matters here because this
 * suite drives the REAL resource builder + the REAL `requireOwnership()`/
 * `requireKycEntryOwnership()` — never a hand-rolled stand-in — so it can
 * only reach routes whose builder it can actually import. This covers:
 *
 *   - vault.ts             — all 14 routes gated by `vaultEntryResource`
 *                             (C30's 3 core CRUD + C31's 11 peripheral)
 *   - vault-entity-links.ts — `GET /vault/:id/links` (reuses `vaultEntryResource`;
 *                             its OTHER two routes gate on the file-local,
 *                             unexported `vaultEntityLinkResource` — out of
 *                             scope for the same reason, see CHANGES doc)
 *   - entities.ts           — all 5 `vaultEntryResource`-gated routes
 *   - value-history.ts      — all 3 `vaultEntryResource`-gated routes
 *   - kyc.ts                — all 4 `kycEntryResource`-gated routes
 *   - exchange-api.ts       — its 1 `kycEntryResource`-gated route
 *
 * 28 routes total. The remaining ~30 files' locally-scoped builders are
 * this phase's own documented follow-up (CHANGES doc's "যা বাকি" section) —
 * each needs its builder exported first, then one table entry here; that
 * export step is a natural pairing with C33's pattern doc (which already
 * has to explain, in prose, when a builder should be exported for reuse).
 *
 * ── Reconstructing the per-file wrapper, not duplicating its logic ────────
 * `vault.ts`/`entities.ts`/`value-history.ts`/`vault-entity-links.ts` each
 * define their own trivial, file-local, NON-exported one-line wrapper —
 * e.g. vault.ts's own `requireVaultEntryOwnership(action, onDeny)` is
 * *exactly* `requireOwnership(action, vaultEntryResource, { onDecision:
 * pepDecisionObserver, onDeny })` (see vault.ts's own source — this is not
 * an inference, it's copied verbatim). Since the only two moving parts in
 * that line (`requireOwnership`, `vaultEntryResource`) are themselves
 * real, exported, imported-unmodified production functions, calling
 * `requireOwnership(action, vaultEntryResource, { onDeny })` directly here
 * exercises the identical code path as going through the file-local
 * one-liner — no route file needed to export its own wrapper for this
 * suite to test the real thing. `kyc.ts` needed no such reconstruction at
 * all: `requireKycEntryOwnership` is already exported (Phase C19B, for
 * exchange-api.ts's own reuse) and is imported directly below. Its one
 * exchange-api.ts route is exercised the same way — via the imported
 * `requireKycEntryOwnership`, with that route's own action string/onDeny
 * body copied verbatim from its source below — rather than importing
 * exchange-api.ts itself, which would pull in that file's own third-party
 * exchange-integration dependencies for no test benefit (this suite never
 * needs the route registered, only the same shared ownership check it
 * gates on).
 *
 * `onDecision: pepDecisionObserver` is deliberately OMITTED from every
 * reconstructed call below — that observer writes to a real
 * `authorization_audit_log` table via `DrizzleAuthorizationAuditWriter`
 * (middlewares/auth.ts), a concern this suite doesn't exercise (audit
 * writing is separately covered by Phase 17/B1's own tests) and don't want
 * to attempt against the mocked `db` this suite installs. Omitting it
 * changes nothing about the ALLOW/DENY effect under test — `PolicyEngine`
 * simply has no observer to call.
 *
 * ── Run ──────────────────────────────────────────────────────────────────
 *   DATABASE_URL=postgres://test:test@localhost:5432/test \
 *   VAULT_FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32) \
 *   npx tsx scripts/src/test-route-ownership-regression.ts
 *
 * Both env vars only need to be PRESENT and well-formed, never valid/
 * reachable — see `./lib/ownership-route-test-kit.ts`'s header ("Requires
 * DATABASE_URL, but never actually connects") and `lib/vault-crypto.ts`'s
 * own import-time guard (>= 32 chars, never actually used to decrypt
 * anything in this suite — no route handler is ever invoked, only the
 * ownership middleware in front of it). Every route file this suite
 * imports (vault.ts, value-history.ts, exchange-api.ts, kyc.ts) pulls in
 * `lib/vault-crypto.ts` transitively, which is why both vars are needed
 * even though this suite never encrypts or decrypts a single field.
 */

import { db } from "@workspace/db";
import { requireOwnership } from "../../artifacts/api-server/src/lib/policy/pep/middleware";
import { vaultEntryResource } from "../../artifacts/api-server/src/routes/vault-entity-links";
import { requireKycEntryOwnership } from "../../artifacts/api-server/src/routes/kyc";
import {
  runOwnershipRouteSuite,
  summarize,
  DRIZZLE_USER_ID_ROW,
  RAW_SQL_USER_ID_ROW,
  type OwnershipRouteSpec,
} from "./lib/ownership-route-test-kit";

function vaultEntrySpec(
  label: string,
  action: string,
  onDeny: (req: any, res: any) => void,
  expectedDenyStatus: number,
  expectedDenyBody: unknown,
): OwnershipRouteSpec {
  return {
    label,
    middleware: () => requireOwnership(action, vaultEntryResource, { onDeny }),
    db,
    ownerRow: DRIZZLE_USER_ID_ROW,
    expectedDenyStatus,
    expectedDenyBody,
  };
}

function kycEntrySpec(
  label: string,
  action: string,
  onDeny: (req: any, res: any) => void,
  expectedDenyStatus: number,
  expectedDenyBody: unknown,
): OwnershipRouteSpec {
  return {
    label,
    middleware: () => requireKycEntryOwnership(action, onDeny),
    db,
    ownerRow: RAW_SQL_USER_ID_ROW,
    expectedDenyStatus,
    expectedDenyBody,
  };
}

const NOT_FOUND_VAULT_ENTRY = { error: "Vault entry not found" };
const NOT_FOUND_VAULT_ENTRY_MESSAGE = { message: "Vault entry not found" };
const TRASHED_NOT_FOUND = { message: "Trashed vault entry not found" };
const NOT_FOUND_ENTITY = { error: "Entity not found" };

const specs: OwnershipRouteSpec[] = [
  // ── vault.ts — C30 (3 core CRUD) + C31 (11 peripheral) — 14 routes ───────
  vaultEntrySpec("vault.ts — GET /vault/:id/gas", "vault_entry.gas.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — GET /vault/:id", "vault_entry.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — GET /vault/:id/seed", "vault_entry.seed.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — PATCH /vault/:id/drive-wallet", "vault_entry.drive_wallet.update",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — POST /vault/:id/refresh-wallet-worth", "vault_entry.wallet_worth.update",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — PATCH /vault/:id", "vault_entry.update",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — PATCH /vault/:id/field", "vault_entry.field.update",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — GET /vault/:id/field-history", "vault_entry.field_history.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  // NOTE: DELETE /vault/:id's deny body uses a `message` key, not `error` —
  // a pre-existing difference from every other vault.ts route (see C30's
  // own CHANGES doc), unchanged here — this suite pins it down exactly so
  // a future "helpful" normalization to `error` gets caught as a diff.
  vaultEntrySpec("vault.ts — DELETE /vault/:id", "vault_entry.delete",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY_MESSAGE); }, 404, NOT_FOUND_VAULT_ENTRY_MESSAGE),
  vaultEntrySpec("vault.ts — POST /vault/:id/restore", "vault_entry.restore",
    (_req, res) => { res.status(404).json(TRASHED_NOT_FOUND); }, 404, TRASHED_NOT_FOUND),
  vaultEntrySpec("vault.ts — DELETE /vault/trash/:id", "vault_entry.purge",
    (_req, res) => { res.status(404).json(TRASHED_NOT_FOUND); }, 404, TRASHED_NOT_FOUND),
  vaultEntrySpec("vault.ts — GET /vault/:id/activity", "vault_entry.activity.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — POST /vault/:id/receipt", "vault_entry.receipt.create",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),
  vaultEntrySpec("vault.ts — DELETE /vault/:id/receipt", "vault_entry.receipt.delete",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),

  // ── vault-entity-links.ts — 1 route reusing vaultEntryResource ──────────
  vaultEntrySpec("vault-entity-links.ts — GET /vault/:id/links", "vault_entry.links.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_VAULT_ENTRY); }, 404, NOT_FOUND_VAULT_ENTRY),

  // ── entities.ts — 5 routes ───────────────────────────────────────────────
  vaultEntrySpec("entities.ts — GET /entities/:id/summary", "vault_entry.summary.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_ENTITY); }, 404, NOT_FOUND_ENTITY),
  vaultEntrySpec("entities.ts — GET /entities/:id/health", "vault_entry.health.read",
    (_req, res) => { res.status(404).json(NOT_FOUND_ENTITY); }, 404, NOT_FOUND_ENTITY),
  // roi read/update deny with 403, not 404 — a deliberate, pre-existing
  // difference from this same file's other two routes; pinned down exactly
  // rather than "normalized" to 404 here.
  vaultEntrySpec("entities.ts — GET /entities/:id/roi", "vault_entry.roi.read",
    (_req, res) => { res.status(403).json({ error: "Forbidden" }); }, 403, { error: "Forbidden" }),
  vaultEntrySpec("entities.ts — POST /entities/:id/roi", "vault_entry.roi.update",
    (_req, res) => { res.status(403).json({ error: "Forbidden" }); }, 403, { error: "Forbidden" }),
  vaultEntrySpec("entities.ts — PATCH /entities/:id/status", "vault_entry.status.update",
    (_req, res) => { res.status(404).json({ error: "Not found" }); }, 404, { error: "Not found" }),

  // ── value-history.ts — 3 vaultEntryResource-gated routes ────────────────
  // NOTE: this route's deny is `res.json([])` with NO `.status()` call at
  // all — Express's own default (200) applies. This is this file's own
  // silent-no-op precedent (an empty history list reads the same to a
  // caller as "no history yet", not as an error) — captured exactly as
  // 200/[] here, not "corrected" to a 404.
  vaultEntrySpec("value-history.ts — GET /vault/:id/value-history", "vault_entry.value_history.read",
    (_req, res) => { res.json([]); }, 200, []),
  vaultEntrySpec("value-history.ts — POST /vault/:id/value", "vault_entry.value.update",
    (_req, res) => { res.status(404).json(NOT_FOUND_ENTITY); }, 404, NOT_FOUND_ENTITY),
  vaultEntrySpec("value-history.ts — POST /vault/:id/followers", "vault_entry.followers.update",
    (_req, res) => { res.status(404).json(NOT_FOUND_ENTITY); }, 404, NOT_FOUND_ENTITY),

  // ── kyc.ts — 4 routes (real requireKycEntryOwnership export, no
  //    reconstruction needed) ──────────────────────────────────────────────
  kycEntrySpec("kyc.ts — GET /kyc-entries/:id", "kyc_entry.read",
    (_req, res) => { res.status(404).json({ error: "Not found" }); }, 404, { error: "Not found" }),
  kycEntrySpec("kyc.ts — PUT /kyc-entries/:id", "kyc_entry.update",
    (_req, res) => { res.status(404).json({ error: "Not found or forbidden" }); }, 404, { error: "Not found or forbidden" }),
  kycEntrySpec("kyc.ts — PATCH /kyc-entries/:id/status", "kyc_entry.status.update",
    (_req, res) => { res.status(404).json({ error: "Not found or forbidden" }); }, 404, { error: "Not found or forbidden" }),
  // NOTE: this route's deny is `res.json({ success: true })` — a
  // deliberate silent-no-op precedent (deleting something that was never
  // yours, or never existed, reports back as if it's already gone rather
  // than leaking which). Captured exactly as 200/{success:true}, not
  // "corrected" to look like an error.
  kycEntrySpec("kyc.ts — DELETE /kyc-entries/:id", "kyc_entry.delete",
    (_req, res) => { res.json({ success: true }); }, 200, { success: true }),

  // ── exchange-api.ts — 1 route, same requireKycEntryOwnership ────────────
  kycEntrySpec("exchange-api.ts — PATCH /kyc-entries/:id/exchange-keys", "kyc_entry.exchange_keys.update",
    (_req, res) => { res.json({ success: true }); }, 200, { success: true }),
];

async function main() {
  console.log(`Route Integration Roadmap — Phase C32: ownership regression suite (${specs.length} routes)\n`);
  for (const spec of specs) {
    await runOwnershipRouteSuite(spec);
  }
  summarize();
}

main().catch((err) => {
  console.error("Suite crashed:", err);
  process.exit(1);
});
