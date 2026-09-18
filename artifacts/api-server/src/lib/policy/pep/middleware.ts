/**
 * lib/policy/pep/middleware.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK).
 *
 * The roadmap's own Phase 19 list, minus `authorize()` itself
 * (authorize.ts): `requirePolicy()`, `requirePermission()`,
 * `requireOwnership()`, `requireRole()`, `requireStepUp()`,
 * `requireApproval()`. Every one of these returns a plain Express
 * `(req, res, next) => void` middleware built on `authorize()` +
 * `enforce()` — none of them invents a new way to reach a Decision.
 *
 * ── `requirePolicy()` is the only fully generic one ───────────────────────
 * It takes a caller-supplied engine (already registered with whatever
 * rule mix the caller assembled) and is what every other helper below
 * ultimately reduces to. Use it directly when the built-in sugar below
 * doesn't fit (multiple rule types combined, a `PrecedenceEngine`
 * instead of a flat `PolicyEngine`, a rule this file doesn't know about).
 *
 * ── `requirePermission()` / `requireOwnership()` — sugar over ONE existing
 *    rule factory each ───────────────────────────────────────────────────
 * Both construct a throwaway, single-rule `PolicyEngine` internally
 * (cheap, stateless, deterministic construction — same "cheap to build a
 * fresh one" posture every `scripts/src/test-policy-*.ts` file already
 * relies on to isolate one rule at a time) wrapping `createRbacRule()`
 * (Phase 02) / `createResourceOwnershipRule()` (Phase 03) respectively,
 * then delegate to `requirePolicy()`. Neither rule ever returns an
 * explicit DENY on its own (both ABSTAIN when the check doesn't match —
 * see each rule's own header for why) — with only one rule registered,
 * abstain correctly falls through to `PolicyEngine`'s own default-deny
 * (`NO_MATCHING_POLICY`, Rule 7), which is exactly the desired outcome
 * for a middleware whose entire job IS that one check.
 *
 * ── `requireStepUp()` — the one helper that needs a companion rule ────────
 * `createAssuranceRule()` (Phase 09) is documented as "a GATE, not a grant
 * path" — it can only ever `STEP_UP` or abstain, NEVER `ALLOW` (see that
 * file's own header). Registered alone, an already-sufficiently-assured
 * subject would abstain straight into `NO_MATCHING_POLICY` — the opposite
 * of what a standalone "did this request clear the assurance bar"
 * middleware should do. So this helper registers a second, trivial
 * always-`ALLOW` rule AFTER the assurance gate: it only ever runs once the
 * gate has already abstained (a `STEP_UP` from the first rule is an
 * immediate, non-combinable outcome — see policy-engine.ts's header — so
 * the second rule is never reached in that case), meaning "the gate has
 * nothing left to add" and "clear to proceed" are the same event here.
 *
 * ── `requireApproval()` — no companion rule needed ────────────────────────
 * `createApprovalGateRule()` (Phase 12), unlike assurance, already returns
 * `ALLOW` itself once a matching `APPROVED` request is on file (see that
 * file's own header for why approval, unlike assurance, is documented as
 * a full grant path, not merely a precondition) — no trivial pass-through
 * rule is needed alongside it.
 *
 * ── `requireRole()` — the one helper NOT built on an existing rule factory ─
 * `middlewares/auth.ts` already has a `requireRoles(...roles)` — a plain,
 * non-PDP inline check with its own ad hoc 403 response. This helper is
 * NOT a duplicate of that: it routes the exact same "is `subject.role` one
 * of these" question through the PDP (a real `Decision`, with a
 * `requestId`/reason code, observable by whatever `onDecision` audit hook
 * (Phase 17) a caller's engine happens to be configured with elsewhere,
 * and renderable via the same `enforce()`/Phase 15 explain() path every
 * other PEP helper uses) — giving a role check the same audit/
 * observability surface every other authorization decision in this engine
 * already gets, without replacing `middlewares/auth.ts`'s own existing,
 * working `requireRoles()` (Rule 3 — do not remove working systems). It is
 * not routed through `../rbac/rbac-rule.ts` (Phase 02) because that rule
 * answers a different question entirely — "does this subject hold a
 * `product.resource.action`-shaped PERMISSION grant" (DB-backed, role-
 * inheritance-resolved) — not "is this subject's raw `role` string one of
 * a fixed list" (no DB read at all).
 *
 * ── Route Integration Roadmap — Season A, Phase A3 (Telemetry hookup) ────
 * Every `new PolicyEngine()` this file constructs internally
 * (`requirePermission()`/`requireOwnership()`/`requireRole()`/
 * `requireStepUp()`/`requireApproval()`) now passes
 * `{ onDecision: options.onDecision }` through to the engine's
 * constructor — see `./types.ts`'s own doc comment on
 * `PepMiddlewareOptions.onDecision` for the full contract. This file
 * still never imports `lib/policy/observability/*` or
 * `lib/policy/audit/*` itself, and still never constructs a
 * `DrizzleAuthorizationAuditWriter` — that would break this directory's
 * own "no DB import" invariant (see `./index.ts`'s header). The observer
 * itself is assembled once, by the one real caller that needs decisions
 * durably audited (`middlewares/auth.ts`, for `requireRole()`) — this
 * file only adds the pass-through seam, it does not decide what gets
 * plugged into it.
 */

import type { NextFunction, Request, Response } from "express";
import { PolicyEngine, type PolicyDecisionObserver } from "../policy-engine";
import { allow, deny } from "../authorization-decision";
import { buildAuthorizationRequest } from "../authorization-request";
import { policyContextFromRequest } from "../pip/context-adapter";
import { createRbacRule, isValidPermissionKey, type RbacProvider } from "../rbac";
import { createResourceOwnershipRule } from "../resource/ownership-rule";
import { createAssuranceRule, type AssuranceLevel, type AssuranceRequirement } from "../assurance";
import { createApprovalGateRule, type ApprovalRequestProvider, type ApprovalRequirement } from "../approval";
import { authorize } from "./authorize";
import { enforce } from "./enforce";
import type { AuthorizingEngine, PepMiddlewareOptions, ResourceRefBuilder } from "./types";

/** Used by any helper below that has no resource-specific fact to check
 *  (`requireRole()`, `requireStepUp()`) — a fixed, opaque resource type
 *  naming which PEP check produced it, never read by any registered rule
 *  in this file's own throwaway engines. */
function fixedResource(type: string): ResourceRefBuilder {
  return () => ({ type });
}

/**
 * The fully generic PEP middleware. Builds the request's `ResourceRef` via
 * `resource(req)`, evaluates it against `engine` (any caller-assembled
 * `AuthorizingEngine`) via `authorize()`, and renders the result via
 * `enforce()`. Every other helper in this file is sugar over this one.
 */
export function requirePolicy(
  engine: AuthorizingEngine,
  action: string,
  resource: ResourceRefBuilder,
  options: PepMiddlewareOptions = {},
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const resolvedResource = await resource(req);
    const outcome = await authorize({ req, engine, action, resource: resolvedResource, enrichment: options });
    await enforce(req, res, next, outcome, options);
  };
}

/**
 * RBAC sugar over `requirePolicy()`: does `req.user` hold a permission
 * (Phase 02, `../rbac/rbac-rule.ts`) covering `action`? Throws immediately
 * at construction (never at request time) if `action` is not a valid
 * "product.resource.action" key — same fail-loud-at-registration posture
 * `../assurance/types.ts`'s `assertValidAssuranceLevel()` already
 * establishes for a typo'd assurance level.
 */
export function requirePermission(
  provider: RbacProvider,
  action: string,
  resource: ResourceRefBuilder = fixedResource("unspecified"),
  options: PepMiddlewareOptions = {},
) {
  if (!isValidPermissionKey(action)) {
    throw new Error(
      `requirePermission(): "${action}" is not a valid "product.resource.action" permission key (see rbac/permission-matcher.ts).`,
    );
  }
  const engine = new PolicyEngine({ onDecision: options.onDecision });
  engine.registerRule("rbac", createRbacRule(provider));
  return requirePolicy(engine, action, resource, options);
}

/**
 * Ownership sugar over `requirePolicy()`: does `resource.ownerId === req.user.userId`
 * (Phase 03, `../resource/ownership-rule.ts`)? `resource` MUST populate
 * `ownerId` — a request that reaches this middleware with `ownerId`
 * unset can never be granted (the only rule registered here abstains with
 * nothing to compare — see that rule's own header), which would otherwise
 * surface as a confusing generic `NO_MATCHING_POLICY` deny indistinguishable
 * from "really isn't the owner". This throws a distinct wiring error
 * instead (via `next(err)`), the same "fail loud, don't silently
 * misattribute" instinct `../precedence-engine.ts`'s tier validation and
 * `../assurance/assurance-rule.ts`'s level validation already apply to
 * their own construction-time inputs — here it can only be checked per
 * request, since `resource` depends on the request.
 */
export function requireOwnership(action: string, resource: ResourceRefBuilder, options: PepMiddlewareOptions = {}) {
  const engine = new PolicyEngine({ onDecision: options.onDecision });
  engine.registerRule("resource-ownership", createResourceOwnershipRule());
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const resolvedResource = await resource(req);
    if (resolvedResource.ownerId === undefined || resolvedResource.ownerId === null) {
      next(
        new Error(
          `requireOwnership(): resource builder for action "${action}" did not populate resource.ownerId — this check can never grant access as written.`,
        ),
      );
      return;
    }
    const outcome = await authorize({ req, engine, action, resource: resolvedResource, enrichment: options });
    await enforce(req, res, next, outcome, options);
  };
}

/**
 * Role-membership sugar — see file header's "requireRole()" section for
 * why this is a plain inline `PolicyRule`, not a wrapper over
 * `../rbac/rbac-rule.ts`. Produces an explicit `EXPLICIT_ALLOW`/
 * `EXPLICIT_DENY` (never an abstain) — a role-membership check has
 * nothing else that could still grant access afterward, unlike
 * `../rbac/rbac-rule.ts`'s own deliberate abstain-on-no-match (see that
 * file's header) which exists to leave room for a LATER rule (ownership,
 * ReBAC) to still grant the same request.
 */
export function requireRole(roles: readonly string[], options: PepMiddlewareOptions = {}) {
  const engine = new PolicyEngine({ onDecision: options.onDecision });
  engine.registerRule("subject-role", (request) => {
    const subject = request.subject;
    if (!subject) return null; // unreachable in practice — policy-engine.ts already denies UNAUTHENTICATED first
    if (roles.includes(subject.role)) {
      return allow(request, "EXPLICIT_ALLOW", {
        policyId: "subject-role",
        message: `granted via role "${subject.role}"`,
      });
    }
    return deny(request, "EXPLICIT_DENY", {
      policyId: "subject-role",
      message: `role "${subject.role}" is not one of: ${roles.join(", ")}`,
    });
  });
  return requirePolicy(engine, "pep.role.check", fixedResource("pep.role-check"), options);
}

/**
 * Assurance sugar — see file header's "requireStepUp()" section for why a
 * trivial always-`ALLOW` rule is registered alongside the real
 * `createAssuranceRule()` gate. `minimumLevel` is validated by
 * `createAssuranceRule()` itself, at construction (throws immediately on
 * an invalid `AssuranceLevel` — see `../assurance/assurance-rule.ts`'s
 * header).
 */
export function requireStepUp(
  minimumLevel: AssuranceLevel,
  options: PepMiddlewareOptions & { action?: string; message?: string } = {},
) {
  const action = options.action ?? "pep.step_up.check";
  const requirement: AssuranceRequirement = { id: "pep-step-up", minimumLevel, message: options.message };
  const engine = new PolicyEngine({ onDecision: options.onDecision });
  engine.registerRule("assurance-gate", createAssuranceRule([requirement]));
  engine.registerRule("assurance-gate-pass", (request) =>
    allow(request, "EXPLICIT_ALLOW", {
      policyId: "assurance-gate-pass",
      message: `assurance requirement satisfied (>= ${minimumLevel})`,
    }),
  );
  return requirePolicy(engine, action, fixedResource("pep.assurance-check"), options);
}

/**
 * Approval sugar over `requirePolicy()`: does a live `APPROVED` request
 * (Phase 12, `../approval/approval-gate-rule.ts`) cover this exact
 * `(subject, resource, action)` tuple? `action` must match the literal
 * action string the corresponding `ApprovalEngine.requestApproval()` call
 * used, and `resource` must resolve the same `type`/`id` that approval
 * request named — see `../approval/approval-gate-rule.ts`'s header on
 * exact-match-only lookup (no wildcards at the storage layer).
 */
export function requireApproval(
  provider: ApprovalRequestProvider,
  action: string,
  resource: ResourceRefBuilder,
  options: PepMiddlewareOptions & { message?: string } = {},
) {
  const requirement: ApprovalRequirement = { id: "pep-approval-gate", message: options.message };
  const engine = new PolicyEngine({ onDecision: options.onDecision });
  engine.registerRule("approval-gate", createApprovalGateRule([requirement], provider));
  return requirePolicy(engine, action, resource, options);
}

/**
 * Route Integration Roadmap — Phase F1 (Public Route Audit Wiring).
 *
 * Sugar for routes where access is ALREADY fully gated by possession of an
 * opaque URL token/code (receipt/:token, invoices/public/:token, /r/:code,
 * emergency-access confirm/view, etc.) — there is no ownership or role fact
 * left to check; the token itself IS the access control. The goal here is
 * NOT to add a real authorization check (there isn't one to add) — it's to
 * give these routes the same observable PDP decision trail (requestId,
 * reason code, onDecision hook) every other route in this codebase gets,
 * so a public/token route doesn't show up as a silent gap in coverage
 * reporting.
 *
 * ── Deliberately NOT built on requirePolicy()/authorize() ─────────────────
 * Every other helper in this file goes through `requirePolicy()`, which
 * calls `authorize()` → `PolicyEngine.evaluate()`. That path has a hard,
 * deliberate invariant (`policy-engine.ts`'s `resolveRequestOrEarlyDecision()`,
 * and `types.ts`'s own doc comment on `Subject`): a `null` subject —
 * i.e. no `req.user`, which is exactly what every route in this bucket
 * looks like, by definition — is auto-denied with UNAUTHENTICATED before
 * ANY registered rule runs. Routing these routes through `requirePolicy()`
 * would not add an audit trail, it would 401 every real caller (a receipt
 * viewer, an SMS webhook sender, an emergency-access confirm click) — the
 * exact regression this helper exists to avoid. Faking a non-null
 * "anonymous" Subject to slip past that gate was considered and rejected:
 * it's precisely the "treat 'not logged in' as just another role" pattern
 * `types.ts`'s Subject doc comment says this engine must never do.
 *
 * So this helper builds the same `AuthorizationRequest`/`AuthorizationDecision`
 * shape by hand (`buildAuthorizationRequest()` explicitly allows `subject:
 * null` — "unauthenticated is a valid, distinct case", it's only
 * `PolicyEngine.evaluate()`'s early-decision gate that treats it as an
 * automatic deny), stamps it ALLOW via the same `allow()` builder every
 * other rule in this engine uses, feeds it to `onDecision` (so it lands in
 * the exact same audit/telemetry pipeline — `pepDecisionObserver` in
 * `middlewares/auth.ts` — as every ownership-wired route), sets
 * `req.authorization` (same as `enforce()` does, for any downstream code
 * that reads it), and calls `next()` unconditionally. There is no deny
 * path — by construction, a route wired with this helper can never be
 * blocked by it; if it needs a real check later, that's `requireOwnership()`
 * or a hand-rolled rule, not this.
 */
export function requirePublicAudit(routeLabel: string, options: { onDecision?: PolicyDecisionObserver } = {}) {
  const action = `pep.public.${routeLabel}`;
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const context = policyContextFromRequest(req);
    const request = buildAuthorizationRequest({
      subject: null, // honest, not faked — this route genuinely has no authenticated subject
      action,
      resource: { type: "public-token-route", id: routeLabel },
      context,
    });
    const decision = allow(request, "EXPLICIT_ALLOW", {
      policyId: "public-token-access",
      message: "public/token-possession route — access already gated by URL token, not PDP",
    });
    req.authorization = { decision, request, subject: null };
    if (options.onDecision) {
      try {
        await options.onDecision(decision, request);
      } catch {
        // Swallowed intentionally — same "observer must never affect the
        // outcome" contract PolicyEngine.evaluate() applies to onDecision.
      }
    }
    next();
  };
}
