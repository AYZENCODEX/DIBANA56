/**
 * lib/policy/assurance/assurance-level.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 09 (Authentication
 * Assurance), sub-phase 9A.
 *
 * `computeAssuranceLevel()` derives one of `types.ts`'s 6 `AssuranceLevel`
 * values from a request's already-resolved `Subject` + `PolicyContext` —
 * the exact same PIP-adjacent posture `abac/attribute-resolver.ts`'s
 * `resolveAttributes()` already established for Phase 05: no DB, no IO, it
 * only reshapes data the caller (a future PEP/route layer) already
 * assembled onto `Subject.assuranceMethods` / `Subject.verificationLevel` /
 * `PolicyContext.authenticationFreshnessSeconds`. Nothing in this codebase
 * populates those three fields with real data yet (see `types.ts`'s own
 * doc comments on each — "Nothing sets it yet") — that is real
 * Passkey/MFA/session-freshness wiring, deliberately deferred to a later
 * Phase 09 sub-phase (see this file's own "NOT part of 9A" section below),
 * per roadmap Rule 16 ("do not implement future phases prematurely"). 9A
 * only builds the deterministic MAPPING from those fields to a level, so
 * once something populates them, assurance enforcement works with no
 * further change to this file.
 *
 * ── Two independent signals, reconciled in one place ──────────────────────
 * The roadmap's 6 levels don't reduce to a single scalar the way, say,
 * `Subject.assuranceMethods.length` might suggest — L5 ("fresh high-
 * assurance authentication") is a RECENCY property (see types.ts's header),
 * not a stronger credential type than L4's passkey. This function computes
 * a `baseLevel` from WHICH assurance signals are present
 * (`assuranceMethods` / `verificationLevel`), then separately checks WHEN
 * the most recent strong-assurance event happened
 * (`authenticationFreshnessSeconds`) to decide whether that base should be
 * upgraded to L5. The two checks never fight each other: recency can only
 * ever raise the result to L5, never lower a `baseLevel` that recency
 * doesn't apply to.
 *
 * ── `authenticationFreshnessSeconds`'s presence already implies a strong
 *    event — this function does not re-derive that from `assuranceMethods` ──
 * `PolicyContext.authenticationFreshnessSeconds`'s own doc comment (../types.ts)
 * defines it as "seconds since the subject last completed a strong-
 * assurance authentication event (password re-entry, MFA, passkey)" — the
 * field's very presence is the caller's (a future PEP layer's) assertion
 * that such an event occurred; this function does not second-guess that by
 * cross-checking it against `assuranceMethods` (which describes the
 * session's ORIGINAL login, not necessarily its most recent step-up — see
 * `Subject.assuranceMethods`'s own doc comment: "a session can be old
 * while its last strong-auth moment was recent, e.g. a step-up just
 * completed"). A value within `ASSURANCE_FRESHNESS_WINDOW_SECONDS`
 * therefore always yields (at least) L5 on its own, regardless of
 * `baseLevel` — see `resolveFreshnessUpgrade()` below.
 *
 * ── `verificationLevel` is treated as a presence check, not parsed ────────
 * `Subject.verificationLevel` is `string | number`, deliberately loose
 * (no schema exists yet — see ../types.ts). This module does not assume a
 * specific enum of strings or a specific numeric scale (that would bake in
 * a guess about a table that doesn't exist yet). It only asks "is this
 * field present and does it NOT spell out one of the known 'not actually
 * verified' markers" — `UNVERIFIED_MARKERS` below lists the handful of
 * values a future verification-state table is likely to use for "not yet
 * verified" (mirroring how `accountState`-shaped fields are typically
 * modeled elsewhere in this codebase). Anything else present is treated as
 * "verified enough for L2" — this is a deliberately conservative (i.e.
 * grants the LOWER of L1/L2 when truly ambiguous, never jumps to L3+ off
 * `verificationLevel` alone) placeholder until a real verification-level
 * schema exists to refine it.
 *
 * ── NOT part of 9A (left for a later Phase 09 sub-phase) ──────────────────
 * - No PIP adapter change: `pip/subject-adapter.ts#subjectFromAuthUser()`
 *   still leaves `assuranceMethods`/`verificationLevel` undefined (see that
 *   file's own header, unchanged by this phase) — wiring those to real
 *   session/login-security/passkey data is a distinct piece of work, not
 *   bundled into 9A's "given the fields, compute a level" contract.
 * - No `PolicyRule`/enforcement here — that is `assurance-rule.ts`'s job
 *   (this file only computes a level; it never decides ALLOW/DENY/STEP_UP).
 * - No Risk Engine interaction — Phase 10's explicit concern (roadmap:
 *   "Risk Engine = calculates risk; Policy Engine = decides what to do
 *   with risk"). `Subject.riskLevel` is never read here.
 */

import type { AssuranceMethod, PolicyContext, Subject } from "../types";
import { ASSURANCE_RANK, type AssuranceLevel } from "./types";

/** How recent `PolicyContext.authenticationFreshnessSeconds` must be for
 *  `computeAssuranceLevel()` to treat it as a live L5-qualifying event,
 *  rather than a stale timestamp left over from a step-up long past. Five
 *  minutes — generous enough that a multi-request sensitive workflow (e.g.
 *  "step up once, then complete a short wizard") doesn't get re-prompted
 *  between every request, tight enough that "stepped up an hour ago" no
 *  longer counts as *fresh* high assurance. Exported so a caller/test can
 *  reference the exact same constant rather than hardcoding `300`
 *  elsewhere and risking the two silently drifting apart. */
export const ASSURANCE_FRESHNESS_WINDOW_SECONDS = 300;

/** Assurance methods this module treats as satisfying the roadmap's L3
 *  ("MFA") tier. `"password"` is deliberately excluded — a password alone
 *  is the base authentication factor every session already has (Phase 01's
 *  `Subject` exists at all only for an authenticated caller), not a SECOND
 *  factor. `"passkey"` is deliberately excluded too — it has its own,
 *  higher tier (L4) below; a subject whose `assuranceMethods` includes
 *  `"passkey"` should land on L4, not merely L3, so passkey is checked
 *  first in `computeBaseLevel()` and never falls through to this set. */
const MFA_METHODS: ReadonlySet<AssuranceMethod> = new Set(["otp", "totp", "backup_code"]);

/** Values a future verification-level table is likely to use to mean "not
 *  actually verified yet" — see file header's "`verificationLevel` is
 *  treated as a presence check" section for why this is deliberately a
 *  small, conservative set rather than an assumed enum. Numeric `0` is
 *  included since a numeric verification scale would plausibly use it the
 *  same way. */
const UNVERIFIED_MARKERS: ReadonlySet<string | number> = new Set(["unverified", "none", "pending_verification", 0]);

function hasMeaningfulVerificationLevel(verificationLevel: string | number | undefined): boolean {
  if (verificationLevel === undefined || verificationLevel === null) return false;
  return !UNVERIFIED_MARKERS.has(verificationLevel);
}

/** The method/verification-derived floor, BEFORE any freshness upgrade.
 *  Never returns L0/L5 — L0 is `computeAssuranceLevel()`'s own
 *  unauthenticated short-circuit (a `Subject` this function receives is
 *  always non-null, same precondition `resolveAttributes()` documents);
 *  L5 is a freshness upgrade layered on top by `computeAssuranceLevel()`,
 *  never a base level in its own right (see file header). */
function computeBaseLevel(subject: Subject): AssuranceLevel {
  const methods = subject.assuranceMethods ?? [];
  if (methods.includes("passkey")) return "L4";
  if (methods.some((method) => MFA_METHODS.has(method))) return "L3";
  if (hasMeaningfulVerificationLevel(subject.verificationLevel)) return "L2";
  return "L1";
}

/** `baseLevel` if `context.authenticationFreshnessSeconds` is absent or
 *  outside the freshness window; `"L5"` if a live strong-assurance event
 *  is on file (see file header's "`authenticationFreshnessSeconds`'s
 *  presence already implies a strong event" section for why this never
 *  cross-checks `assuranceMethods` first). Never returns anything WEAKER
 *  than `baseLevel` — freshness only ever upgrades. */
function resolveFreshnessUpgrade(baseLevel: AssuranceLevel, context: PolicyContext): AssuranceLevel {
  const freshness = context.authenticationFreshnessSeconds;
  if (freshness === undefined || freshness < 0) return baseLevel;
  if (freshness > ASSURANCE_FRESHNESS_WINDOW_SECONDS) return baseLevel;
  return "L5";
}

/**
 * Computes the roadmap's own 6-level assurance vocabulary for one request.
 * `subject === null` (no authenticated caller at all) always yields
 * `"L0"` — matching `types.ts`'s own framing of L0 as "unauthenticated".
 * In practice `policy-engine.ts`/`precedence-engine.ts` both already deny
 * `UNAUTHENTICATED` before any rule (including a future
 * `createAssuranceRule()`-built one) ever runs, so this branch is mostly
 * defensive completeness — same posture `abac-rule.ts`'s own `if (!subject)
 * return null` guard documents for the identical reason.
 *
 * Pure and deterministic (Rule 12): a function of its two arguments only,
 * no clock read of its own (`context.timestamp`/`authenticationFreshnessSeconds`
 * are both already-resolved inputs, fixed at request-build time — see
 * `policy-context.ts`). Never throws.
 */
export function computeAssuranceLevel(subject: Subject | null, context: PolicyContext): AssuranceLevel {
  if (subject === null) return "L0";
  const baseLevel = computeBaseLevel(subject);
  return resolveFreshnessUpgrade(baseLevel, context);
}

/** `true` if `level` is at least as strong as `minimum` — the one
 *  comparison `assurance-rule.ts`'s `createAssuranceRule()` actually needs.
 *  Reads `ASSURANCE_RANK` (types.ts) rather than re-deriving order from
 *  `ASSURANCE_LEVEL_ORDER` at every call site, same pattern
 *  `precedence-engine.ts` establishes for `PRECEDENCE_RANK`. */
export function assuranceLevelMeetsMinimum(level: AssuranceLevel, minimum: AssuranceLevel): boolean {
  return ASSURANCE_RANK[level] >= ASSURANCE_RANK[minimum];
}
