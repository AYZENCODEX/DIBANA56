/**
 * lib/policy/explain/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 15 (Explainability).
 *
 * Pure types. No DB, no Express — same discipline every other lib/policy/*
 * types.ts file already follows (see e.g. ../assurance/types.ts's header).
 *
 * The roadmap's own Phase 15 section, verbatim:
 *
 *   "User-facing: 'You don't have permission to perform this action.'
 *    Admin/debug detail: policy, version, matched rule, decision, reason
 *    code, risk, assurance, resource context.
 *    Never expose sensitive policy internals to unauthorized users."
 *
 * ── Two audiences, one function, never two calls ────────────────────────
 * `explainAuthorizationDecision()` (./explain-authorization.ts) always
 * returns an `AuthorizationExplanation`. Which half of it is populated is
 * decided ENTIRELY by the caller-supplied `includeDetail` flag on that
 * function's own options — never by re-deriving "is this viewer an admin"
 * inside this module (this module has no notion of who is asking; that is
 * ./viewer-authorization.ts's job, one layer up, which the PEP/route layer
 * is expected to call FIRST and pass the result in). This mirrors
 * ../simulation/policy-simulator.ts's own posture: a pure builder function
 * that never itself decides authorization, only shapes an already-decided
 * outcome for display.
 *
 * ── Why this reuses `MatchedRuleTrace` from Phase 14 instead of a new type ──
 * The roadmap's Phase 15 "matched rule" field and Phase 14's "matched
 * rules" field name the exact same underlying data — which registered
 * rule(s) were consulted, and what each one decided, for one evaluation.
 * Inventing a second, differently-shaped type here would let the two
 * phases' notions of "matched rule" silently drift apart for no reason;
 * `PolicyExplanationDetail.matchedRules` below is typed as
 * `MatchedRuleTrace[]` verbatim, and a caller who already has a Phase 14
 * `PolicySimulationResult.matchedRules` (or a raw
 * `PolicyEngine.evaluateWithTrace()`/`PrecedenceEngine.evaluateWithTrace()`
 * trace) can pass it straight through with no reshaping.
 */

import type { AuthorizationDecision, ResourceRef } from "../types";
import type { DecisionReasonCode } from "../decision-reasons";
import type { AssuranceLevel } from "../assurance/types";
import type { MatchedRuleTrace } from "../simulation/types";

/**
 * The one, fixed, non-sensitive message an ordinary (non-admin) caller
 * ever sees for a non-ALLOW decision — verbatim from the roadmap's own
 * Phase 15 section. Deliberately a single constant, not a per-reason-code
 * message: varying the user-facing text by `DecisionReasonCode` would
 * itself leak policy internals (e.g. "denied because your risk is HIGH"
 * tells an attacker their risk score is being tracked) — exactly what
 * this phase's own "never expose sensitive policy internals to
 * unauthorized users" rule forbids. Reason-code-specific detail belongs
 * ONLY in `PolicyExplanationDetail`, gated behind `includeDetail`.
 */
export const GENERIC_DENIAL_MESSAGE = "You don't have permission to perform this action.";

/**
 * Admin/debug detail — the roadmap's own Phase 15 field list, verbatim:
 *   - policy               → `policyId`
 *   - version              → `policyVersion`
 *   - matched rule         → `matchedRule` (the one rule that actually
 *                            decided this — `decision.policyId` itself)
 *                            and `matchedRules` (every rule consulted,
 *                            when the caller supplied a trace)
 *   - decision             → `decision` (the effect) — the full
 *                            `AuthorizationDecision` is also carried
 *                            verbatim as `rawDecision` for a caller that
 *                            wants to inspect anything else on it
 *   - reason code          → `reasonCode` + `reasonDescription`
 *   - risk                 → `risk`
 *   - assurance            → `requiredAssurance` (what the decision
 *                            demanded, if gated) + `assuranceLevel` (what
 *                            the subject actually had, for comparison)
 *   - resource context     → `resource`
 *
 * Every field here is either copied verbatim from the triggering
 * `AuthorizationDecision`/`AuthorizationRequest`, or looked up from a
 * fixed, non-secret table (`DECISION_REASON_DESCRIPTIONS`) — nothing here
 * is independently computed or guessed, same "exactly one source of
 * truth" posture ../simulation/types.ts's own header documents for
 * `PolicySimulationResult`'s alias fields.
 */
export interface PolicyExplanationDetail {
  /** Which registered rule decided this — copied from
   *  `decision.policyId`. `undefined` for the engine's own built-in
   *  fallbacks (NO_MATCHING_POLICY/INVALID_AUTHORIZATION_CONTEXT/
   *  UNAUTHENTICATED), which are not produced by any registered rule —
   *  same posture as ../simulation/types.ts's `policyId` field. */
  policyId?: string;
  /** Best-effort Phase 07 registry version enrichment, when the caller
   *  supplied one (see ../simulation/policy-simulator.ts's
   *  `resolvePolicyVersion()` for the exact same lookup this module
   *  expects a caller to have already performed — this file does not
   *  duplicate that DB-touching lookup itself; see
   *  explain-authorization.ts's header). */
  policyVersion?: number;
  /** Alias for `policyId`, named to match the roadmap's own "matched
   *  rule" (singular) wording exactly. */
  matchedRule?: string;
  /** Every rule actually consulted for this decision, in evaluation
   *  order, INCLUDING abstentions — present only when the caller supplied
   *  a trace (from `PolicyEngine.evaluateWithTrace()`,
   *  `PrecedenceEngine.evaluateWithTrace()`, or a Phase 14
   *  `PolicySimulationResult.matchedRules`). `undefined`, not `[]`, when
   *  no trace was supplied — so a caller can distinguish "no trace was
   *  captured for this decision" from "a trace was captured and it happens
   *  to be empty" (e.g. an INVALID_AUTHORIZATION_CONTEXT/UNAUTHENTICATED
   *  short-circuit, where no rule ever ran). */
  matchedRules?: MatchedRuleTrace[];
  /** The decision's own effect — ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED.
   *  Copied verbatim from `decision.effect`. */
  decision: AuthorizationDecision["effect"];
  reasonCode: DecisionReasonCode;
  /** Fixed, human-readable prose for `reasonCode` — looked up from
   *  ../decision-reasons.ts's `DECISION_REASON_DESCRIPTIONS`, never
   *  independently authored here, so this text and the reason-code
   *  vocabulary itself can never drift apart. */
  reasonDescription: string;
  /** Copied from `decision.requiredAssurance` — see ../types.ts's own doc
   *  comment on that field for which rules populate it (today: only
   *  ../assurance/assurance-rule.ts's STEP_UP). `undefined` for any
   *  decision not gated on a named assurance level. */
  requiredAssurance?: string;
  /** The subject's OWN computed assurance level for this exact request —
   *  ../assurance/assurance-level.ts's `computeAssuranceLevel()`, run over
   *  the same `subject`/`context` the triggering decision was evaluated
   *  against (when the caller supplied the originating `request`).
   *  Deliberately separate from `requiredAssurance` (what a STEP_UP
   *  demanded) so an admin can see BOTH what was required and what the
   *  subject actually had, e.g. "required L3, subject was only L1" —
   *  `undefined` only when no `request` was supplied to
   *  `explainAuthorizationDecision()` (see that function's own doc
   *  comment). */
  assuranceLevel?: AssuranceLevel;
  /** Copied from `request.subject.riskLevel` (Phase 05/10) — `undefined`
   *  when no `request` was supplied, or when the subject had no computed
   *  risk level on file. This module never computes risk itself (per the
   *  roadmap's own "Risk Engine = calculates risk; Policy Engine =
   *  decides what to do with risk" framing — see ../risk/risk-rule.ts's
   *  header); it only surfaces whatever was already on the request. */
  risk?: "low" | "medium" | "high";
  /** Copied from `request.resource` verbatim — the roadmap's own
   *  "resource context" field. `undefined` only when no `request` was
   *  supplied. */
  resource?: ResourceRef;
  /** Copied from `decision.requestId` — the same correlation ID the real
   *  authorization decision itself was stamped with, so an explanation
   *  can always be joined back to the log line / audit row (Phase 17)
   *  that recorded the underlying decision. */
  requestId: string;
  /** Copied from `decision.evaluatedAt`. */
  evaluatedAt: Date;
}

/**
 * Full output of `explainAuthorizationDecision()`. `userMessage` and
 * `detail` are independent — a caller renders whichever half its own
 * audience is entitled to (an end-user route renders only `userMessage`;
 * an admin/debug surface renders `detail` too, when present).
 */
export interface AuthorizationExplanation {
  /** The roadmap's own "user-facing" message, verbatim, for any non-ALLOW
   *  effect. `undefined` for ALLOW — an action that was simply permitted
   *  has nothing that needs explaining to the ordinary caller who
   *  performed it (see explain-authorization.ts's own header for why this
   *  is deliberate, not an oversight). Always the SAME fixed string
   *  (`GENERIC_DENIAL_MESSAGE`) regardless of `reasonCode` — see that
   *  constant's own doc comment for why varying it would itself leak
   *  policy internals. */
  userMessage?: string;
  /** Admin/debug detail. Present if and only if the caller's
   *  `includeDetail` option was `true` — see
   *  explain-authorization.ts's header and
   *  ./viewer-authorization.ts for how that boolean is meant to be
   *  decided (a server-side RBAC permission check, never client-supplied
   *  input — Rule 9). */
  detail?: PolicyExplanationDetail;
}
