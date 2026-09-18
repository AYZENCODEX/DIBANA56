/**
 * lib/policy-admin-console.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 23A (Admin Policy
 * Console — Policies section) + Phase 23B (Admin Policy Console — Policy
 * Versions section).
 *
 * This is the ONE file every `lib/policy/registry/*` header has been
 * pointing at since Phase 07 ("a future route that touches `PolicyRegistry`"
 * — see `policy-registry.ts`'s `listAllPolicies()` doc comment,
 * `actor-from-subject.ts`'s file header) — the "route composes, this lib
 * validates + persists" service layer `routes/admin-policy-console.ts`
 * calls into, same split `lib/oidc-client-admin.ts` +
 * `lib/oidc-client-admin-request.ts` already establish for the OIDC admin
 * surface. Unlike that pair, request validation and orchestration live in
 * ONE file here rather than two — the request shapes this phase validates
 * (a handful of scalar fields matching `NewPolicyInput`/`PolicyStatus`) are
 * simple enough that splitting them into a sibling `-request.ts` file would
 * only add an import boundary with nothing meaningful on either side of it.
 *
 * ── WHAT THIS FILE OWNS THAT `PolicyRegistry` DELIBERATELY DOES NOT ───────
 * `registry/policy-registry.ts`'s own header is explicit that its read
 * methods (`listAllPolicies`/`listVersions`/`getPolicy`) are NOT
 * actor-gated — "the route layer in front of this... is what decides who
 * may reach these methods at all." THIS file is that route layer's
 * service half. Every exported function below that reads or writes
 * through a `PolicyRegistry` first resolves a `PolicyAdminActor` (via
 * Phase 23A's own `buildPolicyAdminActor()`) and, for reads, asserts the
 * actor holds AT LEAST ONE of the two registry permissions
 * (`admin.policy.manage` OR `admin.policy.approve` — see
 * `assertCanViewPolicies()` below) before returning anything. Writes defer
 * entirely to `PolicyRegistry`'s own authorization (`assertCanManagePolicies`/
 * `assertCanApprovePolicies`, called inside `createPolicy`/
 * `createNewVersion`/`transitionStatus` themselves) — this file does not
 * duplicate that check, only the READ gate the registry explicitly declined
 * to enforce itself.
 *
 * ── ERROR TRANSLATION, NOT ERROR PROPAGATION ──────────────────────────────
 * `PolicyRegistry` communicates failure by throwing one of eight typed
 * error classes (`registry/errors.ts`). Every function below catches those
 * (plus zod validation failures) and returns a plain discriminated
 * `PolicyAdminConsoleResult<T>` instead of letting the route layer import
 * `registry/errors.ts` and `instanceof`-switch on it itself — same
 * "persistence layer returns `{ok:false,...}`, route never needs a
 * try/catch" shape `lib/oidc-client-admin.ts`'s functions already use for
 * their own callers. An HTTP `status` travels with every failure so
 * `routes/admin-policy-console.ts` never has to re-derive one from an
 * error's `name`.
 *
 * ── PHASE 23B: ROLLBACK IS `createNewVersion()`, NEVER A REACTIVATION ────
 * `registry/lifecycle.ts`'s own header is explicit that "reactivating old
 * intent is `createNewVersion()`'s job (a fresh DRAFT, reviewed again from
 * scratch), not a shortcut back into an already-archived row's history."
 * `rollbackPolicyVersionForAdmin()` below honors that literally: it reads
 * an older version's content and feeds it to
 * `PolicyRegistry.createNewVersion()` as an ordinary
 * `NewPolicyVersionInput` — producing a brand-new DRAFT version (latest+1)
 * that must independently earn its way back through
 * TESTING → APPROVED → ACTIVE (including the maker-checker and assurance
 * gates `transitionStatus()` already enforces on that path). It never
 * calls `updateStatus`/`transitionStatus` on the OLD row, and it never
 * lets an old row's `status` change at all — immutability of a
 * once-written `(policyId, version)` row (Rule 11) is preserved exactly.
 *
 * KNOWN LIMITATION (documented, not silently absorbed): the audit row a
 * rollback produces is indistinguishable, in `policy_admin_audit_log`,
 * from an organic hand-authored new version — both are a
 * `"policy_version_created"` entry, because rollback and "write a new
 * version by hand" are, mechanically, the exact same `PolicyRegistry`
 * call. This file additionally emits a structured `logger.info` line
 * (`policy_admin.policy_rolled_back`, naming the source version) at the
 * ROUTE layer so an operator reading application logs can still tell the
 * two apart — but the durable DB audit trail cannot, today. Giving
 * rollback its own `policy_admin_audit_log.action` value is a real,
 * worthwhile follow-up, but it means widening `POLICY_AUDIT_ACTIONS`
 * (schema/policy-registry.ts) and `PolicyAdminAuditAction`
 * (registry/types.ts) — a schema change with its own migration, per the
 * roadmap's own "every schema change requires... migration... rollback
 * consideration" rule — deliberately NOT bundled as a rider on this pass.
 *
 * ── CONSTRUCTION ───────────────────────────────────────────────────────
 * `getPolicyRegistry()`/`getRbacProviderForPolicyAdmin()` below are the
 * FIRST real call sites in this codebase that construct
 * `DrizzlePolicyRegistryProvider`/`DrizzleRbacProvider` — every prior
 * phase's own header says as much ("nothing in the app constructs this
 * yet"). Both are lazily-constructed module-level singletons (stateless
 * classes wrapping the shared `@workspace/db` client — no per-request
 * state to isolate), same lifetime/reuse posture every other
 * lazily-constructed singleton in this codebase already takes (e.g.
 * `lib/oidc-client-admin.ts`'s own DB-backed helpers, which never
 * reconstruct a client per call either).
 */

import { z } from "zod/v4";
import { DrizzlePolicyRegistryProvider } from "./policy/registry/drizzle-policy-registry-provider";
import { DrizzleRbacProvider } from "./policy/rbac/drizzle-rbac-provider";
import {
  PolicyRegistry,
  RbacPolicyAdminAuthorizer,
  buildPolicyAdminActor,
  PolicyNotFoundError,
  PolicyAlreadyExistsError,
  InvalidPolicyContentError,
  PolicyLifecycleError,
  PolicyAuthorizationError,
  SelfApprovalNotAllowedError,
  InsufficientAssuranceError,
  PolicyVersionConflictError,
  type PolicyRecord,
  type PolicyStatus,
  type PolicyEffect,
  type PolicyRuleKind,
  type PolicyAdminActor,
  type PolicyAdminAuthorizer,
  type NewPolicyInput,
  type NewPolicyVersionInput,
} from "./policy/registry";
import { subjectFromAuthUser, type AuthenticatedUserLike } from "./policy/pip/subject-adapter";
import type { RbacProvider } from "./policy/rbac/types";

// ── Construction (lazy singletons — see file header) ───────────────────────

let rbacProviderSingleton: RbacProvider | null = null;
function getRbacProviderForPolicyAdmin(): RbacProvider {
  if (!rbacProviderSingleton) rbacProviderSingleton = new DrizzleRbacProvider();
  return rbacProviderSingleton;
}

let policyRegistrySingleton: PolicyRegistry | null = null;
function getPolicyRegistry(): PolicyRegistry {
  if (!policyRegistrySingleton) {
    const authorizer: PolicyAdminAuthorizer = new RbacPolicyAdminAuthorizer(getRbacProviderForPolicyAdmin());
    policyRegistrySingleton = new PolicyRegistry(new DrizzlePolicyRegistryProvider(), authorizer);
  }
  return policyRegistrySingleton;
}

/**
 * Projects `req.user` (already authenticated by `requireDev` upstream —
 * see `routes/admin-policy-console.ts`) into a `PolicyAdminActor`. `null`
 * in → `null` out, same "no authenticated caller" convention
 * `subjectFromAuthUser()` itself already establishes — every caller below
 * treats a `null` actor as `unauthenticated`, never as "skip the check."
 */
export async function buildActorForPolicyAdminRequest(user: AuthenticatedUserLike | null | undefined): Promise<PolicyAdminActor | null> {
  const subject = subjectFromAuthUser(user);
  if (!subject) return null;
  return buildPolicyAdminActor(subject, getRbacProviderForPolicyAdmin());
}

/**
 * Phase 23A's own read gate — see file header. `PolicyAdminAuthorizer`
 * only exposes assert-style (throw-on-deny) checks, so "may view" is
 * expressed as "manage OR approve," tried in that order; only if BOTH
 * throw does this itself throw (the approve-permission's own
 * `PolicyAuthorizationError`, which every caller below already knows how
 * to translate).
 */
async function assertCanViewPolicies(actor: PolicyAdminActor, authorizer: PolicyAdminAuthorizer): Promise<void> {
  try {
    await authorizer.assertCanManagePolicies(actor);
    return;
  } catch {
    // Fall through — manage-denial alone must not deny a viewer who only
    // holds the narrower approve permission.
  }
  await authorizer.assertCanApprovePolicies(actor);
}

// ── Result shape ─────────────────────────────────────────────────────────

export type PolicyAdminConsoleErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "already_exists"
  | "invalid_request"
  | "invalid_policy_content"
  | "illegal_transition"
  | "self_approval_not_allowed"
  | "insufficient_assurance"
  | "version_conflict"
  | "internal_error";

export interface PolicyAdminConsoleFailure {
  ok: false;
  status: number;
  error: PolicyAdminConsoleErrorCode;
  message: string;
  /** Only set for `invalid_request` — the offending body/query field. */
  field?: string;
}

export type PolicyAdminConsoleResult<T> = ({ ok: true } & T) | PolicyAdminConsoleFailure;

function unauthenticated(): PolicyAdminConsoleFailure {
  return { ok: false, status: 401, error: "unauthenticated", message: "This action requires an authenticated caller." };
}

/**
 * The one place every thrown `PolicyRegistry` error becomes an HTTP-ready
 * result — see file header's "error translation, not propagation." A
 * class NOT in this list is a genuine bug (unmodeled failure), not a
 * caller-facing condition, so it falls into `internal_error` rather than
 * leaking an unrecognized shape to a route.
 */
function translateRegistryError(err: unknown): PolicyAdminConsoleFailure {
  if (err instanceof PolicyNotFoundError) {
    return { ok: false, status: 404, error: "not_found", message: err.message };
  }
  if (err instanceof PolicyAlreadyExistsError) {
    return { ok: false, status: 409, error: "already_exists", message: err.message };
  }
  if (err instanceof InvalidPolicyContentError) {
    return { ok: false, status: 400, error: "invalid_policy_content", message: err.message };
  }
  if (err instanceof PolicyLifecycleError) {
    return { ok: false, status: 409, error: "illegal_transition", message: err.message };
  }
  if (err instanceof SelfApprovalNotAllowedError) {
    return { ok: false, status: 403, error: "self_approval_not_allowed", message: err.message };
  }
  if (err instanceof InsufficientAssuranceError) {
    return { ok: false, status: 403, error: "insufficient_assurance", message: err.message };
  }
  if (err instanceof PolicyAuthorizationError) {
    return { ok: false, status: 403, error: "forbidden", message: err.message };
  }
  if (err instanceof PolicyVersionConflictError) {
    return { ok: false, status: 409, error: "version_conflict", message: "This version was concurrently created by another writer — retry the operation." };
  }
  return {
    ok: false,
    status: 500,
    error: "internal_error",
    message: err instanceof Error ? err.message : "Unexpected policy-registry error.",
  };
}

// ── Request validation (zod) ────────────────────────────────────────────
//
// Same field set/limits `schema/policy-registry.ts`'s own
// `insertPolicySchema` already enforces at the DB-insert layer (policyId
// pattern, status enum) — duplicated here deliberately, not imported from
// there: that schema validates a FULL row (including `status`, `version`,
// `createdBy` — fields this console never lets a caller set directly), and
// pulling it in would mean `.omit()`-ing half of it back out at every call
// site. This validates exactly the request-shaped subset instead, same
// "a validator should not read a field its own phase wasn't asked to
// expose" discipline `lib/oidc-client-admin-request.ts`'s own header
// documents.

const POLICY_ID_PATTERN = /^[a-z0-9_-]{1,128}$/;
const POLICY_STATUS_VALUES = ["DRAFT", "TESTING", "APPROVED", "ACTIVE", "DISABLED", "ARCHIVED"] as const;

const newPolicyBodySchema = z.object({
  policyId: z.string().min(1).max(128).regex(POLICY_ID_PATTERN, "policyId must be lowercase alphanumeric/-/_ (max 128 chars)"),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  application: z.string().min(1).max(100),
  resource: z.string().min(1).max(100),
  action: z.string().min(1).max(100),
  ruleKind: z.literal("abac_dsl"),
  rules: z.string().min(1).max(20000),
  effect: z.enum(["allow", "deny"]),
  priority: z.number().int().min(0).max(1_000_000).optional(),
});

const newPolicyVersionBodySchema = newPolicyBodySchema.omit({ policyId: true });

const statusTransitionBodySchema = z.object({
  status: z.enum(POLICY_STATUS_VALUES),
});

const rollbackBodySchema = z.object({
  toVersion: z.number().int().min(1),
});

const listFilterQuerySchema = z.object({
  application: z.string().min(1).max(100).optional(),
  resource: z.string().min(1).max(100).optional(),
  status: z.enum(POLICY_STATUS_VALUES).optional(),
});

function invalidRequestFromZod(result: z.ZodSafeParseError<unknown>): PolicyAdminConsoleFailure {
  const first = result.error.issues[0];
  return {
    ok: false,
    status: 400,
    error: "invalid_request",
    message: first?.message ?? "Invalid request.",
    field: first?.path?.length ? first.path.join(".") : undefined,
  };
}

// ── Serialization ────────────────────────────────────────────────────────
//
// Two projections, same "list is a summary, detail is the full row" split
// `routes/admin-oidc-clients.ts`'s own list-vs-detail response shapes
// already use: the Policies list view (23A) never sends `rules`/`ruleKind`
// DSL source over the wire for every row in a potentially long list —
// only a single Policy/Version detail view (23A/23B) does, where an
// operator has actually asked to inspect ONE version's content.

export interface PolicyAdminSummary {
  policyId: string;
  version: number;
  name: string;
  description: string | null;
  application: string;
  resource: string;
  action: string;
  effect: PolicyEffect;
  priority: number;
  status: PolicyStatus;
  createdBy: number;
  approvedBy: number | null;
  createdAt: string;
  updatedAt: string;
  approvedAt: string | null;
}

export interface PolicyAdminDetail extends PolicyAdminSummary {
  ruleKind: PolicyRuleKind;
  rules: string;
}

function toPolicyAdminSummary(record: PolicyRecord): PolicyAdminSummary {
  return {
    policyId: record.policyId,
    version: record.version,
    name: record.name,
    description: record.description,
    application: record.application,
    resource: record.resource,
    action: record.action,
    effect: record.effect,
    priority: record.priority,
    status: record.status,
    createdBy: record.createdBy,
    approvedBy: record.approvedBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    approvedAt: record.approvedAt ? record.approvedAt.toISOString() : null,
  };
}

function toPolicyAdminDetail(record: PolicyRecord): PolicyAdminDetail {
  return { ...toPolicyAdminSummary(record), ruleKind: record.ruleKind, rules: record.rules };
}

// ── Phase 23A — Policies section ────────────────────────────────────────

/** `GET /admin/policies` — one row per policyId, latest version, any
 *  status, optionally narrowed by `application`/`resource`/`status`. */
export async function listPoliciesForAdmin(
  actor: PolicyAdminActor | null,
  rawQuery: unknown,
): Promise<PolicyAdminConsoleResult<{ policies: PolicyAdminSummary[] }>> {
  if (!actor) return unauthenticated();
  const parsed = listFilterQuerySchema.safeParse(rawQuery ?? {});
  if (!parsed.success) return invalidRequestFromZod(parsed);

  const registry = getPolicyRegistry();
  try {
    await assertCanViewPolicies(actor, authorizerFallback());
  } catch (err) {
    return translateRegistryError(err);
  }
  const records = await registry.listAllPolicies(parsed.data);
  return { ok: true, policies: records.map(toPolicyAdminSummary) };
}

/** `GET /admin/policies/:policyId` — the latest version's full detail. */
export async function getPolicyForAdmin(
  actor: PolicyAdminActor | null,
  policyId: string,
): Promise<PolicyAdminConsoleResult<{ policy: PolicyAdminDetail }>> {
  if (!actor) return unauthenticated();
  const registry = getPolicyRegistry();
  try {
    await assertCanViewPolicies(actor, authorizerFallback());
  } catch (err) {
    return translateRegistryError(err);
  }
  const record = await registry.getPolicy(policyId);
  if (!record) {
    return { ok: false, status: 404, error: "not_found", message: `No policy registered with policyId "${policyId}".` };
  }
  return { ok: true, policy: toPolicyAdminDetail(record) };
}

/** `POST /admin/policies` — create version 1 of a brand-new policy. */
export async function createPolicyForAdmin(
  actor: PolicyAdminActor | null,
  rawBody: unknown,
): Promise<PolicyAdminConsoleResult<{ policy: PolicyAdminDetail }>> {
  if (!actor) return unauthenticated();
  const parsed = newPolicyBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  const input: NewPolicyInput = parsed.data;
  try {
    const created = await getPolicyRegistry().createPolicy(actor, input);
    return { ok: true, policy: toPolicyAdminDetail(created) };
  } catch (err) {
    return translateRegistryError(err);
  }
}

/** `POST /admin/policies/:policyId/versions` — create the next version
 *  (latest + 1), status DRAFT. */
export async function createPolicyVersionForAdmin(
  actor: PolicyAdminActor | null,
  policyId: string,
  rawBody: unknown,
): Promise<PolicyAdminConsoleResult<{ policy: PolicyAdminDetail }>> {
  if (!actor) return unauthenticated();
  const parsed = newPolicyVersionBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  const input: NewPolicyVersionInput = parsed.data;
  try {
    const created = await getPolicyRegistry().createNewVersion(actor, policyId, input);
    return { ok: true, policy: toPolicyAdminDetail(created) };
  } catch (err) {
    return translateRegistryError(err);
  }
}

// ── Phase 23B — Policy Versions section ─────────────────────────────────

/** `GET /admin/policies/:policyId/versions` — every version on file,
 *  newest first. 404s if `policyId` has no version at all (a nicer admin
 *  UX than `PolicyRegistryProvider.listVersions()`'s own "empty array, not
 *  an exception" contract — that contract is for the registry layer, this
 *  console layer is allowed to make it a 404 for an operator instead). */
export async function listPolicyVersionsForAdmin(
  actor: PolicyAdminActor | null,
  policyId: string,
): Promise<PolicyAdminConsoleResult<{ versions: PolicyAdminDetail[] }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewPolicies(actor, authorizerFallback());
  } catch (err) {
    return translateRegistryError(err);
  }
  const records = await getPolicyRegistry().listVersions(policyId);
  if (records.length === 0) {
    return { ok: false, status: 404, error: "not_found", message: `No policy registered with policyId "${policyId}".` };
  }
  return { ok: true, versions: records.map(toPolicyAdminDetail) };
}

/** `GET /admin/policies/:policyId/versions/:version` — one specific
 *  version's full detail (never just "the latest" — see
 *  `getPolicyForAdmin()` above for that). */
export async function getPolicyVersionForAdmin(
  actor: PolicyAdminActor | null,
  policyId: string,
  version: number,
): Promise<PolicyAdminConsoleResult<{ policy: PolicyAdminDetail }>> {
  if (!actor) return unauthenticated();
  try {
    await assertCanViewPolicies(actor, authorizerFallback());
  } catch (err) {
    return translateRegistryError(err);
  }
  const record = await getPolicyRegistry().getPolicy(policyId, version);
  if (!record) {
    return { ok: false, status: 404, error: "not_found", message: `No version ${version} of policy "${policyId}".` };
  }
  return { ok: true, policy: toPolicyAdminDetail(record) };
}

/** `PATCH /admin/policies/:policyId/versions/:version/status` — advance
 *  (or retreat, per `lifecycle.ts`'s own graph) one version's status.
 *  Every legality/authorization/maker-checker/assurance check is
 *  `PolicyRegistry.transitionStatus()`'s own job (see that method's
 *  header) — this function only validates the request shape and
 *  translates whichever of those five checks rejected it. */
export async function transitionPolicyStatusForAdmin(
  actor: PolicyAdminActor | null,
  policyId: string,
  version: number,
  rawBody: unknown,
): Promise<PolicyAdminConsoleResult<{ policy: PolicyAdminDetail }>> {
  if (!actor) return unauthenticated();
  const parsed = statusTransitionBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  try {
    const updated = await getPolicyRegistry().transitionStatus(actor, policyId, version, parsed.data.status);
    return { ok: true, policy: toPolicyAdminDetail(updated) };
  } catch (err) {
    return translateRegistryError(err);
  }
}

/**
 * `POST /admin/policies/:policyId/rollback` — Phase 23B's own "rollback"
 * admin action. See file header for why this is `createNewVersion()`
 * under the hood, never a reactivation of the old row: reads
 * `toVersion`'s content and re-submits it as a fresh DRAFT
 * `NewPolicyVersionInput`, going through every one of
 * `createNewVersion()`'s own checks (rule-content re-validation included
 * — a policy that compiled when `toVersion` was authored is re-compiled
 * here too, not assumed still valid) exactly as if an admin had
 * hand-copied that old version's fields into a "create new version" form.
 */
export async function rollbackPolicyVersionForAdmin(
  actor: PolicyAdminActor | null,
  policyId: string,
  rawBody: unknown,
): Promise<PolicyAdminConsoleResult<{ policy: PolicyAdminDetail; rolledBackFrom: number }>> {
  if (!actor) return unauthenticated();
  const parsed = rollbackBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidRequestFromZod(parsed);

  const registry = getPolicyRegistry();
  const source = await registry.getPolicy(policyId, parsed.data.toVersion);
  if (!source) {
    return { ok: false, status: 404, error: "not_found", message: `No version ${parsed.data.toVersion} of policy "${policyId}".` };
  }

  const input: NewPolicyVersionInput = {
    name: source.name,
    description: source.description,
    application: source.application,
    resource: source.resource,
    action: source.action,
    ruleKind: source.ruleKind,
    rules: source.rules,
    effect: source.effect,
    priority: source.priority,
  };

  try {
    const created = await registry.createNewVersion(actor, policyId, input);
    return { ok: true, policy: toPolicyAdminDetail(created), rolledBackFrom: source.version };
  } catch (err) {
    return translateRegistryError(err);
  }
}

// ── Internal ────────────────────────────────────────────────────────────

/**
 * `assertCanViewPolicies()` needs a `PolicyAdminAuthorizer` to call, but
 * `PolicyRegistry` deliberately does not expose the one it was
 * constructed with (it is an internal collaborator, not part of that
 * class's own public surface — see `registry/types.ts`). Rather than
 * reach into `PolicyRegistry`'s private field (the ugly cast the first
 * draft of this file used, now removed) or widen `PolicyRegistry`'s own
 * public API just for this one read-gate's benefit, this file keeps a
 * second reference to the SAME underlying `RbacProvider`-backed
 * authorizer it already handed to `getPolicyRegistry()` — one extra
 * stateless object, not a second source of truth (both wrap the exact
 * same `getRbacProviderForPolicyAdmin()` singleton).
 */
let viewAuthorizerSingleton: PolicyAdminAuthorizer | null = null;
function authorizerFallback(): PolicyAdminAuthorizer {
  if (!viewAuthorizerSingleton) viewAuthorizerSingleton = new RbacPolicyAdminAuthorizer(getRbacProviderForPolicyAdmin());
  return viewAuthorizerSingleton;
}
