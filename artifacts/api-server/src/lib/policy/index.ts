/**
 * lib/policy/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01, sub-phase 1C.
 *
 * Barrel export. Nothing in this module is wired into app.ts or any route
 * yet — this file exists so later phases (and tests) have one stable import
 * path, `./lib/policy`, instead of reaching into individual files.
 */

export * from "./types";
export * from "./decision-reasons";
export * from "./policy-errors";
export * from "./policy-context";
export * from "./authorization-request";
export * from "./authorization-decision";
export * from "./policy-engine";

// Phase 1B — PIP (Policy Information Point) adapters.
export * from "./pip/subject-adapter";
export * from "./pip/context-adapter";

// Phase 1C — decision-observability.
export * from "./decision-observer";

// Phase 02 — RBAC. See ./rbac/index.ts's own header for why
// drizzle-rbac-provider.ts is deliberately NOT part of this re-export
// (it alone is exempt from this barrel's DB-free/side-effect-free
// guarantee — import it directly where actually needed).
export * from "./rbac";

// Phase 03 — Resource / Ownership Authorization: sub-phases 3A (ownership +
// locked-resource), 3B (explicit resource grants + resource-level deny),
// and 3C (organization access) — see ./resource/index.ts's own header for
// the full breakdown, including why drizzle-resource-grant-provider.ts is
// deliberately excluded from this re-export.
export * from "./resource";

// Phase 04 — ReBAC (relationship-based authorization): relation vocabulary,
// relation→action-verb mapping, the roadmap-mandated relationship resolver
// abstraction, and the ReBAC PolicyRule — see ./rebac/index.ts's own header
// for why drizzle-relationship-provider.ts is deliberately excluded from
// this re-export.
export * from "./rebac";

// Phase 05 — ABAC (attribute-based authorization): the attribute-value/
// condition-tree/operator types, the attribute resolver + dot-path lookup,
// the AND/OR/NOT condition evaluator, and the ABAC PolicyRule — see
// ./abac/index.ts's own header for why this phase, uniquely so far, needed
// no Drizzle provider to exclude at all.
export * from "./abac";

// Phase 07 — Policy Registry / PAP: the policy-administration engine
// (create/version/transition-status, with authorization + lifecycle +
// maker-checker + assurance + audit all enforced) — see ./registry/index.ts's
// own header for why drizzle-policy-registry-provider.ts is deliberately
// excluded from this re-export. (Phase 06's DSL is already re-exported via
// ./abac above — compileAbacPolicy() is what policy-registry.ts's own
// validateRuleContent() calls.)
//
// Phase 16 — Policy Versioning — also lives inside ./registry (not a
// separate top-level barrel): `assertVersionSlotFree()`'s immutability
// guard inside policy-registry.ts itself, `createRegistryPolicyRule()`/
// `createRegistryPolicyRules()` (registry-rule-loader.ts — feeds an ACTIVE
// registry row into the PDP, stamping `policyId`+`policyVersion` onto its
// decisions), and `getDecisionPolicySnapshot()` (reproducibility.ts —
// looks a past decision's exact policy version back up). See
// ./registry/index.ts's own header for the full file list.
export * from "./registry";

// Phase 08 — Policy Precedence: the formal 7-tier conflict-resolution order
// (./precedence-tiers.ts) and the additive, parallel `PrecedenceEngine`
// (./precedence-engine.ts) that resolves multi-rule conflicts by strict
// tier rank with deny-overrides as the intra-tier tiebreak — see that
// file's own header for why this is a NEW class rather than a change to
// Phase 01's `PolicyEngine`.
export * from "./precedence-tiers";
export * from "./precedence-engine";

// Phase 09 — Authentication Assurance, sub-phase 9A: the roadmap's 6-level
// assurance vocabulary (./assurance/types.ts), the pure Subject/PolicyContext
// → AssuranceLevel computation (./assurance/assurance-level.ts), and the
// gate-only PolicyRule that STEP_UPs when an action's registered minimum
// assurance isn't met (./assurance/assurance-rule.ts) — see
// ./assurance/index.ts's own header for why this phase, like Phase 05
// (ABAC), needed no Drizzle provider to exclude at all.
export * from "./assurance";

// Phase 09, sub-phase 9B — the first of 9A's three unpopulated Subject/
// PolicyContext fields to get real data: `verificationLevel`, mapped from
// this codebase's real, already-durable KYC/email-verification standing
// (`users.emailVerified`/`kycVerified`/`kycLevel`). `assuranceMethods` and
// `authenticationFreshnessSeconds` remain unpopulated — see
// ./pip/verification-level-adapter.ts's own header for why populating
// `assuranceMethods` from account CAPABILITY (rather than this session's
// actual usage) would be a real security regression, not merely an
// incomplete feature, and is deliberately left for a later sub-phase.
// `drizzle-verification-level-provider.ts` (the one file here that imports
// `@workspace/db`) is deliberately excluded from this barrel — same
// precedent `./rbac`/`./resource`/`./rebac`/`./registry`'s own headers
// already established for their own Drizzle providers; import it directly
// where actually needed.
export * from "./pip/verification-level-adapter";

// Phase 10 — Risk-Aware Authorization, sub-phase 10A: the "decide what to
// do with risk" half of the roadmap's own "Risk Engine = calculates risk;
// Policy Engine = decides what to do with risk" framing. `createRiskRule()`
// maps an already-computed `Subject.riskLevel` to LOW/unset → abstain,
// MEDIUM → STEP_UP, HIGH → DENY — see ./risk/risk-rule.ts's own header for
// why HIGH denies outright rather than only stepping up, and for why risk
// CALCULATION itself is deliberately not part of 10A. No Drizzle provider
// to exclude here either (see ./risk/index.ts's own header).
export * from "./risk";

// Phase 10, sub-phase 10B — the "calculates" half of the roadmap's own
// "Risk Engine = calculates risk; Policy Engine = decides what to do with
// risk" framing, reusing lib/login-security.ts's existing isAnomalousIp()
// signal plus a recent-failed-login-burst count from the same
// login_history table (see ./pip/risk-level-adapter.ts's own header for
// why these two, not a new signal). `login-security-risk-provider.ts`
// (the one file here that imports both @workspace/db and
// lib/login-security.ts) is deliberately excluded from this barrel — same
// precedent every other Drizzle/DB-backed provider in this engine already
// established; import it directly where actually needed.
export * from "./pip/risk-level-adapter";

// Phase 11 — Temporary / Expiring Access: time-boxed grants carrying
// grantedBy/reason/startsAt/expiresAt/scope/resource/action, matching the
// roadmap's own Phase 11 field list. Allow-only (no `effect` column/DENY
// path — see ./temporary-access/temporary-access-rule.ts's own header for
// why), evaluated against `request.context.timestamp` (never a fresh clock
// read) so an expired or not-yet-active grant automatically stops
// authorizing without any background job. `scope: "resource_type"` is what
// lets a temporary grant be broader than one resource instance, unlike
// Phase 03's exact-match-only `resource_grants` — see
// ./temporary-access/types.ts's own header. Belongs at the EXPLICIT_GRANT
// precedence tier (../precedence-tiers.ts), same tier as ownership/ReBAC/
// the ALLOW half of the Phase 03 explicit-grant rule.
// `drizzle-temporary-access-grant-provider.ts` (the one file here that
// imports `@workspace/db`) is deliberately excluded from this barrel — same
// precedent every other Drizzle/DB-backed provider in this engine already
// established; import it directly where actually needed.
export * from "./temporary-access";

// Phase 12 — Approval Engine: supports `REQUIRE_APPROVAL` with
// initiator/approver/scope/reason/expiry/approval-state/audit-trail (the
// roadmap's own Phase 12 field list, verbatim), plus the CRITICAL rule —
// "Initiator must not approve their own sensitive operation" — enforced by
// `ApprovalEngine.decide()` before any other check. Unlike every gate-only
// rule before it (assurance, risk), `createApprovalGateRule()` can produce
// ALLOW as well as APPROVAL_REQUIRED — an approved request IS the grant for
// that specific action, not a mere precondition layered on some other
// rule's grant — see ./approval/approval-gate-rule.ts's own header.
// `drizzle-approval-request-provider.ts` (the one file here that imports
// `@workspace/db`) is deliberately excluded from this barrel — same
// precedent every other Drizzle/DB-backed provider in this engine already
// established; import it directly where actually needed.
export * from "./approval";

// Phase 13 — Separation of Duties: a DENY-only gate (never ALLOW, same
// one-sided posture `assurance/assurance-rule.ts` established for STEP_UP)
// implementing the roadmap's three verbatim examples — "creator !=
// approver", "requester != reviewer", "key-rotator != sole approver" — via
// two independent, already-existing data sources: `resource.ownerId`
// (Phase 01) for the "creator" check, and Phase 04's ReBAC
// `RelationshipProvider` for the "conflicting relation" check (a subject
// holding a write-capable relation — owner/editor/manager — on a resource
// may not also `approve` on that same resource). No new schema, no new
// provider — see ./sod/types.ts's own header for why both of the
// roadmap's remaining examples reduce to the same two checks. Belongs at
// the RESOURCE_DENY precedence tier (../precedence-tiers.ts), same tier as
// locked-resource-rule.ts and the DENY half of the Phase 03 explicit-grant
// rule — see ./sod/separation-of-duties-rule.ts's own header.
export * from "./sod";

// Phase 14 — Policy Simulation: `simulatePolicy()`/`simulatePrecedence()`
// dry-run entry points, returning the roadmap's own named output fields
// ("decision, policy, version, matched rules, reason, required assurance")
// by running the EXACT SAME evaluation both real engines already perform
// (via each engine's own new, additive `evaluateWithTrace()` method — see
// ../policy-engine.ts's and ../precedence-engine.ts's own headers) rather
// than a parallel/simplified copy of the combining algorithm. Never able
// to execute a business action — see ./simulation/policy-simulator.ts's
// own header for why that holds by construction, not by a runtime flag.
export * from "./simulation";

// Phase 15 — Explainability: `explainAuthorizationDecision()` renders an
// already-produced `AuthorizationDecision` (never re-evaluating it) into
// the roadmap's own two-audience shape — a fixed, safe `userMessage` for
// ordinary callers, and richer `detail` (policy, version, matched rule,
// decision, reason code, risk, assurance, resource context) gated behind
// `includeDetail`, itself decided server-side by
// `canViewExplanationDetail()` (a Phase 02 RBAC permission check, reusing
// role-resolver.ts/permission-matcher.ts verbatim — never a parallel
// permission system) — see ./explain/index.ts's own header.
export * from "./explain";

// Phase 17 — Authorization Audit: `AuthorizationAuditEntry` (the roadmap's
// own field list — decisionId, requestId, subject reference, product,
// resource, action, decision, policyId, policyVersion, risk, assurance,
// timestamp, latency, reasonCode), `toAuditEntry()` (the one pure
// decision+request → entry mapping), and
// `createAuthorizationAuditObserver()` — a SECOND `PolicyDecisionObserver`
// built the same way Phase 1C's `createLoggingObserver()` (./decision-
// observer.ts) already was, persisting through a caller-supplied
// `AuthorizationAuditWriter` instead of a structured logger. Also adds
// `latencyMs` to `AuthorizationDecision` itself (types.ts) and stamps it
// inside `PolicyEngine.evaluate()`/`evaluateWithTrace()` (policy-engine.ts)
// — see ./audit/index.ts's own header for why
// `drizzle-audit-writer.ts` is deliberately excluded from this re-export.
export * from "./audit";

// Phase 18 — PIP / Attribute Providers: gives the roadmap's own seven-name
// provider vocabulary (SubjectProvider, ResourceProvider,
// OrganizationProvider, SessionProvider, RiskProvider, DeviceProvider,
// RelationshipProvider) one authoritative home — six as type ALIASES over
// interfaces earlier phases already built (RiskLevelProvider →
// RiskProvider, etc. — see ./pip/types.ts's own header for the full
// mapping and for why RelationshipProvider is deliberately NOT re-aliased
// here, to avoid an ambiguous re-export against ./rebac's own export of
// that exact name above), plus two genuinely new real attribute sources
// this phase adds (`Subject.accountState` from `users.status`;
// `PolicyContext.sessionAgeSeconds`/`deviceTrust` from `user_sessions`),
// and `PolicyInformationPoint` — the composition facade that is the
// concrete answer to this phase's "PDP requests context through providers
// instead of arbitrary DB queries" framing. `ResourceProvider`/
// `OrganizationProvider` ship as interfaces only, deliberately with no
// implementation (see ./pip/resource-attribute-provider.ts's and
// ./pip/organization-provider.ts's own headers for why — no generic
// resources table and no organizations table exist in this codebase).
// `drizzle-account-state-provider.ts`, `drizzle-session-context-provider.ts`,
// `drizzle-device-trust-provider.ts`, and `drizzle-subject-provider.ts`
// (the files here that import `@workspace/db`) are deliberately excluded
// from this barrel — same precedent every other Drizzle/DB-backed provider
// in this engine already established; import each directly where actually
// needed.
export * from "./pip/account-state-adapter";
export * from "./pip/session-context-adapter";
export * from "./pip/device-trust-adapter";
export * from "./pip/resource-attribute-provider";
export * from "./pip/organization-provider";
export * from "./pip/types";
export * from "./pip/policy-information-point";

// Phase 19 — PEP / Express SDK: thin enforcement helpers —
// `authorize()`, `requirePolicy()`, `requirePermission()`,
// `requireOwnership()`, `requireRole()`, `requireStepUp()`,
// `requireApproval()` (the roadmap's own Phase 19 list, verbatim) — the
// first thing in this whole engine that imports Express AND is meant to
// actually sit in front of a route (nothing in `routes/*.ts` calls any of
// them yet — same "engine, not endpoint" posture every phase before this
// one shipped with; see ./pep/index.ts's own header). Every helper here
// composes rule factories Phase 02-13 already built (RBAC, ownership,
// assurance, approval) or delegates to a caller-supplied
// `PolicyEngine`/`PrecedenceEngine` — nothing in this directory invents a
// new way to reach ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED. Safe to include
// in this barrel: like `./pip/context-adapter` (Phase 1B, already
// re-exported above), this directory's only Express dependency is the
// `Request`/`Response`/`NextFunction` types themselves — no DB import
// anywhere in `./pep/*`.
//
// Phase 20 — Batch Authorization: `authorizeMany()`/`allowedKeys()`
// (./pep/authorize-many.ts), re-exported here as part of the same `./pep`
// barrel — see that file's own header for why batch authorization lives
// alongside `authorize()` rather than in a separate top-level directory.
export * from "./pep";

// Phase 21A — Policy Test Framework (declarative model): the roadmap's own
// "GIVEN subject + resource + context, WHEN action, THEN decision" case
// shape (`PolicyTestCase`/`PolicyTestSuite` — ./test-framework/types.ts),
// the five-category coverage vocabulary (`PolicyTestCategory`), and a
// runner (`runPolicyTestCase()`/`runPolicyTestSuite()`/
// `assertPolicyTestSuitePassed()` — ./test-framework/runner.ts) that
// evaluates a case against a real `PolicyEngine`/`PrecedenceEngine` and
// reports pass/fail plus category-coverage gaps. No Drizzle provider to
// exclude (this directory only ever touches a caller-supplied engine) —
// see ./test-framework/index.ts's own header. Phase 21B (applying this
// framework across every already-shipped policy rule, with full
// five-category coverage each) is deliberately NOT part of this export —
// see ./test-framework/types.ts's own header for why that is later work,
// not something this sub-phase claims to have already done.
export * from "./test-framework";

// Phase 23C — Admin Policy Console (Roles, Permissions & Assignments
// sections): RbacAdminRegistry, the real RbacAdminAuthorizer
// (RbacRbacAdminAuthorizer), and every supporting type/error class for
// the write-capable RBAC-admin surface over the SAME four Phase 02 tables
// (roles/permissions/role_permissions/user_roles) plus this phase's own
// rbac_admin_audit_log -- the "Roles"/"Permissions"/"Assignments"
// counterpart to Phase 07's ./registry above for the "Policies"/"Policy
// Versions" sections. drizzle-rbac-admin-provider.ts (the one file here
// that imports @workspace/db) is deliberately excluded from this
// re-export -- same precedent ./rbac's and ./registry's own headers
// already established for their own Drizzle providers; import it
// directly at the one real call site that constructs it
// (lib/rbac-admin-console.ts). See ./rbac-admin/index.ts's own header.
export * from "./rbac-admin";

// Phase 23D — Admin Policy Console (Resources section): ResourceAdminRegistry,
// the real ResourceAdminAuthorizer (RbacResourceAdminAuthorizer), and every
// supporting type/error class for the write-capable admin surface over the
// SAME Phase 03 (sub-phase 3B) `resource_grants` table plus this phase's own
// resource_admin_audit_log -- the "Resources" counterpart to Phase 23A/23B's
// ./registry above (Policies/Policy Versions) and Phase 23C's ./rbac-admin
// above (Roles/Permissions/Assignments). drizzle-resource-admin-provider.ts
// (the one file here that imports @workspace/db) is deliberately excluded
// from this re-export -- same precedent ./rbac-admin's own header already
// established; import it directly at the one real call site that constructs
// it (lib/resource-admin-console.ts). See ./resource-admin/index.ts's own
// header.
export * from "./resource-admin";

// Phase 24 — Observability: sub-phase 24A (Metrics core) — a dependency-
// free, in-process `MetricsRegistry` fed by `createMetricsObserver()`
// through the same `onDecision` seam Phase 1C/17 already use, covering the
// roadmap's own authorization_requests_total/allow/deny/step_up/approval/
// policy_errors/latency metric list verbatim (authorization_cache_hit_rate
// is deliberately NOT implemented — no caching layer exists anywhere in
// lib/policy/* yet; see ./observability/metrics-registry.ts's own header)
// — and sub-phase 24B (Dashboards) — `AccessPatternRegistry` (reason-code
// + risk-level breakdowns 24A's bare effect counters can't provide) and
// `./observability/dashboards.ts`'s pure builders for the roadmap's own
// six named dashboards (authorization health, denial spikes, policy
// errors, latency, unusual access patterns, high-risk decisions), plus
// the shared runtime singleton pair (`./observability/runtime-
// registries.ts`) a future PolicyEngine construction site plugs
// `authorizationObserver` into with zero further glue. See
// ./observability/index.ts's own header — no Drizzle provider to exclude
// here, unlike most phases before it.
export * from "./observability";

// Phase 25 — Production Hardening: `withTimeout()`/`AuthorizationTimeoutError`
// (./hardening/timeout.ts), the shared primitive bounding how long
// `PolicyEngine.evaluateCore()`'s rule loop (new `ruleTimeoutMs` engine
// option) and `pep/authorize.ts`'s PIP resolution (new `pipTimeoutMs`
// enrichment option) may wait on a single rule/provider call before
// failing closed — see that file's own header for why an unbounded wait
// is itself a DoS/fail-closed gap, and each call site's own header for
// why a timeout there needs no new decision-reason code (it reuses the
// existing POLICY_EVALUATION_ERROR / PIP_ENRICHMENT_ERROR fail-closed
// paths verbatim). Opt-in and additive — omitting both new options keeps
// every pre-Phase-25 caller's behavior byte-for-byte unchanged.
export * from "./hardening/timeout";
