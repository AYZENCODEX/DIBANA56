/**
 * lib/policy/pip/account-state-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * `Subject.accountState` (../types.ts) has existed since Phase 05 (ABAC) —
 * `abac/attribute-resolver.ts` already exposes it to conditions as
 * `subject.accountState` — but that field's own doc comment says "Not
 * modeled by the current schema yet... Nothing in this codebase sets it
 * yet." That was true when it was written; it no longer is. `users.status`
 * (`lib/db/src/schema/users.ts`) is a real, already-durable, already-
 * enforced account-lifecycle column — `auth-utils.ts#getUserFromToken()`
 * already refuses to authenticate a `"banned"`/`"suspended"` user before a
 * request ever reaches the PDP (see that file's own status check). This
 * module is the first thing in `lib/policy/*` to read that column, so an
 * ABAC condition can reference `subject.accountState` for defense-in-depth
 * (e.g. a narrow re-check on an unusually sensitive action) or for a future
 * status value auth-utils.ts doesn't itself gate on, without inventing a
 * second, parallel place account status is judged.
 *
 * Same DB-free-interface / separate-real-provider split every other pair in
 * this directory already establishes (verification-level-adapter.ts,
 * risk-level-adapter.ts): this file declares `AccountStateProvider` (an
 * interface) and the pure enrichment function; the real,
 * `@workspace/db`-backed implementation lives in
 * `drizzle-account-state-provider.ts`.
 *
 * Not wired into `subjectFromAuthUser()` or any route — same additive,
 * unwired posture every PIP enrichment step in this engine ships with
 * (Phase 19/PEP's concern). See `drizzle-subject-provider.ts` for the one
 * place this phase DOES compose it (into the new `SubjectProvider`).
 */

import type { Subject } from "../types";

/** Reads one user's current `users.status` value verbatim (e.g. "active",
 *  "suspended", "banned") — implemented for real by
 *  `DrizzleAccountStateProvider` (drizzle-account-state-provider.ts); a
 *  test fixture can implement this trivially without any DB. */
export interface AccountStateProvider {
  getAccountState(userId: number): Promise<string>;
}

/**
 * Returns a NEW `Subject` — identical to `subject`, with `accountState`
 * populated from `provider`. Never mutates `subject`. Always overwrites any
 * pre-set `accountState` — same "provider's real signal wins, never merges"
 * posture `withVerificationLevel()`/`withRiskLevel()` already establish.
 */
export async function withAccountState(subject: Subject, provider: AccountStateProvider): Promise<Subject> {
  const accountState = await provider.getAccountState(subject.userId);
  return { ...subject, accountState };
}
