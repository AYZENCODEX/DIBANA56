/**
 * lib/policy/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core),
 * sub-phase 1A.
 *
 * Pure types. No DB, no Express, no side effects — this file must be safely
 * importable from anywhere (routes, cron jobs, the Telegram bot, tests)
 * without dragging in the rest of the app.
 *
 * These mirror the *real* identity shape already produced by
 * `auth-utils.ts#getUserFromToken()` (userId/role/authType/keyType/scopes) —
 * Phase 1A does not invent a parallel identity model, it just gives that
 * existing shape a name (`Subject`) that the PDP can reason about. Wiring an
 * actual Express request into a `Subject` is deliberately NOT part of this
 * sub-phase (see policy-context.ts doc comment) — that adapter is a later
 * Phase 01 sub-part / PEP concern, not the engine core.
 */

/** Matches `getUserFromToken()`'s `authType` today; PDP treats each the same
 *  unless a specific rule cares (a rule is free to check this field).
 *  "oidc" added in the Route Integration Roadmap's Season A / Phase A1
 *  (this codebase's own OIDC access tokens, lib/auth-utils.ts). */
export type SubjectAuthType = "session" | "apikey" | "legacy" | "oidc";

/** Step-up / assurance signals the PDP can require or observe. Values are
 *  intentionally a plain string union (not yet backed by a table) — Phase 01
 *  only needs the vocabulary to exist so `AuthorizationDecision`'s STEP_UP
 *  effect has something concrete to name. */
export type AssuranceMethod = "password" | "otp" | "totp" | "passkey" | "backup_code";

/**
 * WHO is asking. `null` represents an unauthenticated caller — deliberately
 * a distinct case from "a Subject with no permissions" so PIP/PDP code can't
 * accidentally treat "not logged in" as just another role.
 */
export interface Subject {
  userId: number;
  role: string;
  authType: SubjectAuthType;
  /** Present only for authType "apikey" (mirrors getUserFromToken()). */
  keyType?: "full" | "scoped";
  scopes?: string[];
  /** Not modeled by the current schema yet (Phase 03+ concern) — carried
   *  here as optional so later phases don't need to touch this interface. */
  organizationId?: number | null;
  /** Assurance methods satisfied so far *for this request's session*, e.g.
   *  ["password", "totp"]. Empty/undefined means "base session only". */
  assuranceMethods?: AssuranceMethod[];
  /** Phase 05 (ABAC) subject attribute. Not modeled by the current schema
   *  yet — no table currently records account lifecycle state (e.g.
   *  "active" / "suspended" / "pending_verification"). Carried here as
   *  optional, same posture as `organizationId` above, so a future
   *  account-state table needs no change to this interface, only a PIP
   *  adapter that populates it. Nothing in this codebase sets it yet. */
  accountState?: string;
  /** Phase 05 (ABAC) subject attribute. "How strongly is this identity
   *  verified" (e.g. "unverified" / "email_verified" / "identity_verified"),
   *  distinct from `authType`/`assuranceMethods` (which describe THIS
   *  session's login method, not the account's overall verification
   *  standing). Not modeled by the current schema yet — left optional,
   *  same posture as `organizationId`. Nothing sets it yet. */
  verificationLevel?: string | number;
  /** Phase 05 (ABAC) subject attribute. Deliberately left for the Risk
   *  Engine (Phase 10) to populate — "Risk Engine = calculates risk; Policy
   *  Engine = decides what to do with risk" (roadmap, Phase 10). Phase 05
   *  only adds the vocabulary/field so ABAC conditions can reference
   *  `subject.riskLevel` once something populates it; nothing in this
   *  codebase sets it yet, and no rule in Phase 05 requires it to be
   *  present (see abac/README notes in CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE5.md). */
  riskLevel?: "low" | "medium" | "high";
}

/**
 * WHICH resource the action targets. Every field is optional in Phase 01 —
 * Phase 03 (Resource / Ownership Authorization) is what actually requires
 * and validates these; Phase 01's engine only needs the shape to exist.
 */
export interface ResourceRef {
  /** e.g. "sylo.vault_item", "ryft.payment", "admin.user" — same family as
   *  the `product.resource.action` permission naming used elsewhere in the
   *  roadmap, minus the action. */
  type: string;
  id?: string | number;
  ownerId?: number;
  organizationId?: number | null;
  classification?: string;
  state?: string;
  locked?: boolean;
  /** Phase 05 (ABAC) resource attribute. Distinct from `classification`
   *  (e.g. "public" / "internal" / "confidential" — an administrative
   *  labeling scheme) — `sensitivity` is meant for a coarser, ABAC-facing
   *  axis (e.g. "low" / "high") a condition can compare against
   *  independently of whatever classification scheme a given product uses.
   *  Optional, caller-supplied, same trust boundary as every other
   *  `ResourceRef` field (see ownership-rule.ts's header) — this module
   *  never fetches it itself. Nothing in this codebase sets it yet. */
  sensitivity?: string;
  /** Route Integration Roadmap — Season D, Phase D6. The subject's role
   *  within a GROUP/TEAM resource identified by `type`/`id` — e.g.
   *  "leader" / "member" for a `team_members` row — distinct from
   *  `ownerId` (a single global owner field) because many resources in
   *  this codebase are instead governed by a per-(resource, user)
   *  membership row in a separate table (`team_members`,
   *  `project_members`, ...), the shape `resource/ownership-rule.ts`
   *  cannot express (see that shape's own discussion in
   *  `routes/teams.ts`'s Phase C4 header comment). Caller-supplied,
   *  exactly the same trust boundary `ownerId`/`organizationId` already
   *  draw: the route/service layer already ran (or already needed to run,
   *  for its own business logic) the membership lookup — this module
   *  never queries a membership table itself. `undefined` means "no
   *  membership fact known for this request" (most often: no row at all,
   *  or a row whose status isn't one the caller's lookup considered live
   *  — see `resource/group-membership-rule.ts`'s header for how a caller
   *  is expected to fold a status column into this one field rather than
   *  this type growing a second, table-shaped status field of its own). */
  groupRole?: string;
}

/**
 * Request-scoped metadata the PDP may want for logging/audit/risk, but which
 * no rule strictly needs to reach a decision in Phase 01. Kept separate from
 * `AuthorizationRequest` itself so it's obvious this is "ambient" data, not
 * part of the WHO/WHAT/WHICH question being asked.
 */
export interface PolicyContext {
  /** Correlation ID for this authorization decision. Always present —
   *  callers who don't supply one get one generated (see policy-context.ts).
   *  Propagated verbatim onto the resulting AuthorizationDecision so a log
   *  line and its triggering request can always be joined. */
  requestId: string;
  timestamp: Date;
  ip?: string;
  sessionId?: string;
  /** Phase 05 (ABAC) environment attribute. "How much do we trust the
   *  device this session is coming from" (e.g. "trusted" / "unknown" /
   *  "untrusted") — a future Phase 09/10 concern to populate from a real
   *  device-fingerprint/login-security signal; left optional so ABAC
   *  conditions have a stable `environment.deviceTrust` path to reference
   *  once something populates it. Nothing sets it yet. */
  deviceTrust?: string;
  /** Phase 05 (ABAC) environment attribute. Seconds since the current
   *  session was established — lets a condition express "session must be
   *  younger than N seconds for this sensitive action" without this module
   *  reading the sessions table itself (a PIP-layer concern, same boundary
   *  every other caller-supplied context field in this file already
   *  draws). Nothing sets it yet. */
  sessionAgeSeconds?: number;
  /** Phase 05 (ABAC) environment attribute. Seconds since the subject last
   *  completed a strong-assurance authentication event (password re-entry,
   *  MFA, passkey) — this is the "authentication freshness" the roadmap's
   *  Phase 05 section names, distinct from `sessionAgeSeconds` (a session
   *  can be old while its last strong-auth moment was recent, e.g. a
   *  step-up just completed). Left for a future Phase 09 (Authentication
   *  Assurance) PIP adapter to populate; nothing sets it yet. */
  authenticationFreshnessSeconds?: number;
  /** Free-form bag for anything a future phase's rules want to read, without
   *  forcing a change to this interface every time. Rules must treat this as
   *  read-only input, never as a place to smuggle in a pre-computed
   *  decision. */
  extra?: Readonly<Record<string, unknown>>;
}

/**
 * The full WHO/WHAT/WHICH/UNDER-WHAT-CONDITIONS question posed to the PDP.
 * This is the one and only input `PolicyEngine.evaluate()` accepts.
 */
export interface AuthorizationRequest {
  subject: Subject | null;
  /** e.g. "read", "update", "approve" — or the full `product.resource.action`
   *  string once Phase 02 (RBAC) exists. Phase 01 treats this as opaque. */
  action: string;
  resource: ResourceRef;
  context: PolicyContext;
}

/** Every possible outcome of an authorization decision (see roadmap's target
 *  architecture: ALLOW / STEP-UP / APPROVAL, plus DENY as the default). */
export type DecisionEffect = "ALLOW" | "DENY" | "STEP_UP" | "APPROVAL_REQUIRED";

/**
 * A rule's (or the engine's) verdict. Always carries a reason code — an
 * `AuthorizationDecision` with no explanation is not acceptable per the
 * roadmap's auditability rule (NON-NEGOTIABLE RULE 10).
 */
export interface AuthorizationDecision {
  effect: DecisionEffect;
  reason: import("./decision-reasons").DecisionReasonCode;
  /** Optional human-readable detail, e.g. which assurance method is missing
   *  for a STEP_UP decision. Never put secrets/PII here — this can end up
   *  in logs. */
  message?: string;
  /** Copied from the triggering AuthorizationRequest's context.requestId. */
  requestId: string;
  evaluatedAt: Date;
  /** Which registered rule produced this decision, if any (undefined for
   *  the engine's own default-deny fallback). Useful for audit/debugging. */
  policyId?: string;
  /** Phase 14 (Policy Simulation) surface. Populated only by a rule that
   *  gates on a named minimum assurance level (today: only
   *  `assurance/assurance-rule.ts`'s STEP_UP) — carries that requirement's
   *  own `AssuranceLevel` string (e.g. "L3") verbatim, so a caller (in
   *  particular `lib/policy/simulation/policy-simulator.ts`) can surface
   *  "required assurance" as a structured field instead of having to parse
   *  it back out of `message`'s free-form text. Left undefined by every
   *  other decision producer (ALLOW/DENY/APPROVAL_REQUIRED, and any STEP_UP
   *  not gated on assurance specifically, e.g. `risk/risk-rule.ts`'s
   *  MEDIUM-risk STEP_UP, which has no "level" to name) — same "optional,
   *  additive, nothing else has to populate it" posture every other Phase
   *  05+ attribute on `Subject`/`ResourceRef`/`PolicyContext` in this file
   *  already establishes. */
  requiredAssurance?: string;
  /** Phase 16 (Policy Versioning). The exact registry `PolicyRecord.version`
   *  (../registry/types.ts) this decision was evaluated against, when the
   *  producing rule came from the Policy Registry —
   *  `../registry/registry-rule-loader.ts`'s `createRegistryPolicyRule()`
   *  stamps this alongside `policyId` on every ALLOW/DENY it produces, from
   *  the same `PolicyRecord` both fields are read off of, so the two can
   *  never disagree about which version fired. `undefined` for every
   *  decision not produced by a registry-backed rule (every Phase 02-13
   *  rule factory continues to leave this unset — see authorization-
   *  decision.ts's header) — same "optional, additive, nothing else has to
   *  populate it" posture `requiredAssurance` above already establishes.
   *  This is what lets a decision be joined back to the EXACT policy
   *  version that produced it even after a newer version has since gone
   *  ACTIVE (Rule 11: "Historical decisions must remain reproducible") —
   *  see ../registry/reproducibility.ts's `getDecisionPolicySnapshot()`. */
  policyVersion?: number;
  /** Phase 17 (Authorization Audit). Wall-clock milliseconds
   *  `PolicyEngine.evaluate()`/`evaluateWithTrace()` (or
   *  `PrecedenceEngine`'s own equivalents) took end-to-end for THIS
   *  decision — from the start of `evaluateCore()` (request build +
   *  every rule consulted) to the finalized decision, measured by the
   *  engine itself so this number reflects real rule-evaluation cost
   *  (DB-backed PIP/registry lookups included) rather than something an
   *  external caller times around an already-async call and might
   *  contaminate with its own overhead. Stamped by the engine's public
   *  `evaluate()`/`evaluateWithTrace()` wrapper AFTER `evaluateCore()`
   *  resolves (see policy-engine.ts's own header) — never set by a rule
   *  itself, and always present on every decision either engine produces
   *  (including every early-exit path: invalid context, unauthenticated,
   *  evaluation error, default-deny) since the timer starts before
   *  `evaluateCore()`'s first branch. `undefined` only for a decision
   *  built directly by a helper (allow()/deny()/stepUp()/
   *  approvalRequired() called from a test or from outside either engine)
   *  that was never run through `evaluate()`/`evaluateWithTrace()` at
   *  all — same "optional, additive, nothing else has to populate it"
   *  posture `policyVersion` above already established. This is the
   *  roadmap's Phase 17 "latency" field, made concrete. */
  latencyMs?: number;
}
