/**
 * lib/policy/pip/verification-level-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9B.
 *
 * 9A's `computeAssuranceLevel()` (../assurance/assurance-level.ts) already
 * reads `Subject.verificationLevel` — 9A left NOTHING populating it (see
 * that file's own header: "Nothing in this codebase populates those three
 * fields with real data yet"). This file is the first of those three to
 * get real data, and deliberately only this one — see the "Why only
 * `verificationLevel`, not `assuranceMethods`" section below for why the
 * other two (`assuranceMethods`, `authenticationFreshnessSeconds`) are
 * NOT part of 9B.
 *
 * ── Why only `verificationLevel`, not `assuranceMethods` ──────────────────
 * `Subject.assuranceMethods`'s own doc comment (../types.ts) defines it as
 * "Assurance methods satisfied so far *for this request's session*" — a
 * USAGE fact about THIS login, not a capability fact about the account.
 * Inspecting this codebase's real tables (`users.two_fa_enabled`,
 * `passkey_credentials`, `user_backup_codes`) only tells you what a method
 * an account COULD use, never what it actually used to establish the
 * current session — `createSession()` (../../sessions.ts) doesn't record
 * which method(s) cleared before a session was opened, and nothing joins
 * `user_sessions` back to `login_history.method` /
 * `login_challenges.completedMethods` today. Populating `assuranceMethods`
 * from account capability would silently upgrade every session for a
 * password-only login on a 2FA-enabled account to "MFA satisfied" (L3) —
 * a real security regression in the assurance model 9A built, not merely
 * an incomplete feature. Wiring that correctly needs either a schema
 * change (recording the login method against the session/JWT) or route-
 * level changes to `auth.ts`/`passkey.ts`/`vault-reauth.ts` — deliberately
 * left to a later sub-phase rather than bundled here (roadmap Rule 16).
 *
 * `Subject.verificationLevel` has no such trap: its own doc comment
 * defines it as "How strongly is this identity verified" — an ACCOUNT-
 * LEVEL STANDING (closer to KYC status than to a login event), which is
 * exactly what `users.emailVerified`/`kycVerified`/`kycLevel` (see
 * `routes/users.ts`'s `/profile/kyc` + admin-approval endpoints) already
 * durably record, independent of any particular session. Reading it here
 * carries none of `assuranceMethods`'s usage-vs-capability ambiguity.
 *
 * ── DB-free by design, same posture `subject-adapter.ts` established ─────
 * This file declares `VerificationLevelProvider` (an interface) and a pure
 * mapping function — no `@workspace/db` import, so it stays safely
 * importable anywhere (tests, other modules) without dragging in Drizzle.
 * The actual Postgres-backed implementation lives in
 * `drizzle-verification-level-provider.ts`, the one file in this pair that
 * imports `@workspace/db` — same split `rbac/index.ts`'s header documents
 * for `drizzle-rbac-provider.ts` (excluded from the barrel; import it
 * directly where actually needed).
 *
 * ── Not wired into any route or `subjectFromAuthUser()` yet ───────────────
 * `subjectFromAuthUser()` (subject-adapter.ts) stays exactly as Phase 1B
 * left it — this file adds a SEPARATE, optional enrichment step
 * (`withVerificationLevel()`) a caller can compose after it, rather than
 * baking a DB read into what Phase 1B deliberately kept a synchronous,
 * DB-free reshape. Nothing in this codebase calls `withVerificationLevel()`
 * yet (Phase 19/PEP's concern, same as every other rule/provider in this
 * engine) — Phase 1A-08's routes and middleware remain untouched.
 */

import type { Subject } from "../types";

/** The account-standing facts this module needs — exactly the shape
 *  `users.emailVerified`/`kycVerified`/`kycLevel` already durably record
 *  (see `lib/db/src/schema/users.ts`), reshaped so this file (and its
 *  tests) never has to know Drizzle's column-naming conventions. */
export interface AccountVerificationStanding {
  emailVerified: boolean;
  /** Mirrors `users.kycVerified` — `true` only once an admin has approved
   *  a KYC submission (see `routes/users.ts`'s `/admin/kyc/:userId/approve`).
   *  A `pending`/`rejected`/`none` `kycStatus` all leave this `false`. */
  kycVerified: boolean;
  /** Mirrors `users.kycLevel` — `0` until the first KYC approval, `1`
   *  today (the only level `routes/users.ts` currently grants; see that
   *  file's own "KYC: Level v1 (basic profile) verification" comment).
   *  Read alongside `kycVerified` rather than alone, since a future KYC
   *  tier could in principle set a level without (yet) flipping
   *  `kycVerified` — this module never assumes the two can't diverge. */
  kycLevel: number;
}

/** Reads one user's current `AccountVerificationStanding` — implemented
 *  for real by `DrizzleVerificationLevelProvider`
 *  (drizzle-verification-level-provider.ts); a test fixture can implement
 *  this trivially without any DB. */
export interface VerificationLevelProvider {
  getAccountVerificationStanding(userId: number): Promise<AccountVerificationStanding>;
}

/** The three concrete strings this module ever produces — the exact
 *  vocabulary `../types.ts`'s own `Subject.verificationLevel` doc comment
 *  already names as examples ("unverified" / "email_verified" /
 *  "identity_verified"), so nothing about the ABAC/assurance consumers of
 *  this field needs to change to recognize real values once this module
 *  starts producing them. */
export type VerificationLevelLabel = "unverified" | "email_verified" | "identity_verified";

/**
 * Pure mapping: `AccountVerificationStanding` → one of the three known
 * `VerificationLevelLabel`s. KYC approval outranks a bare verified email
 * (an approved KYC submission necessarily happened after account signup,
 * so it always implies at least as much standing as email verification
 * alone) — `kycVerified` is checked first for that reason, not because
 * `emailVerified` is ignored once KYC is approved.
 *
 * Deliberately tolerant of the "future KYC tier sets a level without
 * flipping `kycVerified`" case `AccountVerificationStanding.kycLevel`'s
 * own doc comment flags: `kycLevel >= 1` alone (regardless of
 * `kycVerified`) is enough to report `"identity_verified"`, since a level
 * on file is itself evidence of admin-approved standing even if some
 * future code path sets one differently than today's `/admin/kyc/:userId/approve`
 * does. Pure, deterministic, never throws.
 */
export function mapAccountStandingToVerificationLevel(
  standing: AccountVerificationStanding,
): VerificationLevelLabel {
  if (standing.kycVerified || standing.kycLevel >= 1) return "identity_verified";
  if (standing.emailVerified) return "email_verified";
  return "unverified";
}

/**
 * Returns a NEW `Subject` — identical to `subject`, with `verificationLevel`
 * populated from `provider`. Never mutates `subject` (same functional
 * posture `subjectFromAuthUser()` already establishes for building a
 * `Subject` in the first place). This is an explicit, separate enrichment
 * step (see file header) — nothing calls this automatically.
 *
 * Only reads through `provider`; never trusts a `verificationLevel` the
 * caller might have already set on `subject` (this function always
 * overwrites it) — a caller who wants to preserve some other pre-set value
 * should not call this function for that `Subject` at all, rather than
 * expecting it to merge/preserve.
 */
export async function withVerificationLevel(
  subject: Subject,
  provider: VerificationLevelProvider,
): Promise<Subject> {
  const standing = await provider.getAccountVerificationStanding(subject.userId);
  return { ...subject, verificationLevel: mapAccountStandingToVerificationLevel(standing) };
}
