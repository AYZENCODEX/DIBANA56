/**
 * lib/policy/pep/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK).
 *
 *   Identity → PIP → PDP/Policy Engine → Decision → PEP → Business Action → Audit
 *                                                    ^^^
 *                                                    this directory
 *
 * Phase 01-18 built the PDP (PolicyEngine/PrecedenceEngine), the PIP
 * (subjectFromAuthUser/policyContextFromRequest/PolicyInformationPoint),
 * and every concrete PolicyRule (RBAC, ownership, ReBAC, ABAC, assurance,
 * risk, temporary access, approval, separation of duties). None of it has
 * ever been reachable from an actual Express route (see e.g.
 * pip/policy-information-point.ts's own header: "Wiring one into an actual
 * request path is Phase 19's (PEP) concern."). This directory is that
 * wiring: thin, additive middleware factories — `authorize()`,
 * `requirePolicy()`, `requirePermission()`, `requireOwnership()`,
 * `requireRole()`, `requireStepUp()`, `requireApproval()` — the roadmap's
 * own Phase 19 list, verbatim.
 *
 * ── PEP enforces. PDP decides. ────────────────────────────────────────────
 * Nothing in this directory invents a new way to reach ALLOW/DENY/STEP_UP/
 * APPROVAL_REQUIRED. Every helper here either calls an already-registered
 * `PolicyEngine`/`PrecedenceEngine`'s own `evaluate()` (`requirePolicy()`,
 * the fully generic case), or constructs one from already-existing
 * Phase 02-13 rule factories (`requirePermission()`/`requireOwnership()`/
 * `requireStepUp()`/`requireApproval()` — see middleware.ts's own header
 * for exactly which rule each one wraps). `requireRole()` is the one
 * exception that builds a rule inline (a single `subject.role` membership
 * check) rather than reusing an existing rule factory — see
 * middleware.ts's own header for why that one is deliberately not routed
 * through `../rbac/rbac-rule.ts` (a DB-backed permission system, not a
 * plain role-membership check).
 *
 * ── Never wired into any route yet ────────────────────────────────────────
 * Same "engine, not endpoint" posture every phase before this one has
 * shipped with (Rule 16 — do not implement future phases prematurely).
 * These middleware factories are ready to be attached to a real route by a
 * future phase/PR; nothing in `routes/*.ts` calls any of them yet.
 */

import type { NextFunction, Request, Response } from "express";
import type { AuthorizationDecision, AuthorizationRequest, ResourceRef, Subject } from "../types";
import type { BuildAuthorizationRequestInput } from "../authorization-request";
import type { PolicyInformationPoint } from "../pip/policy-information-point";
import type { PolicyDecisionObserver } from "../policy-engine";

/**
 * Structural subset of `PolicyEngine`/`PrecedenceEngine`'s own public
 * `evaluate()` method (policy-engine.ts / precedence-engine.ts) — every
 * PEP helper is written against this interface, not either concrete class,
 * so a caller can hand in whichever engine it already built (or a test
 * double) without this directory importing either class merely to name
 * its type. Both real engines already satisfy this structurally (no
 * change needed on either side — TypeScript interfaces are structural,
 * same reasoning `pip/types.ts`'s header gives for its own provider
 * aliases).
 */
export interface AuthorizingEngine {
  evaluate(input: BuildAuthorizationRequestInput): Promise<AuthorizationDecision>;
}

/**
 * Builds the `ResourceRef` for ONE specific request. A PEP helper never
 * fetches a resource itself (no DB access anywhere in this directory,
 * same boundary `resource/ownership-rule.ts`'s own header already draws
 * around `ResourceRef.ownerId`) — the route/service layer already knows
 * which resource it's checking; this is just the one place that shape
 * gets handed to the PDP. May read `req.params`/`req.body`/anything else
 * already resolved earlier in the request lifecycle (e.g. by an upstream
 * middleware that already looked the resource up and attached it to
 * `req`).
 */
export type ResourceRefBuilder = (req: Request) => ResourceRef | Promise<ResourceRef>;

/**
 * Optional Phase 18 (PIP) enrichment a PEP helper can be given. Every
 * field is optional — omitting all of them behaves exactly as calling
 * `subjectFromAuthUser(req.user)` / `policyContextFromRequest(req)`
 * directly (Phase 1B), the same "safe default, nothing else has to
 * populate it" posture every optional `Subject`/`PolicyContext` field
 * already establishes (see ../types.ts's own doc comments).
 */
export interface PepEnrichmentOptions {
  /** Phase 18's composition facade. When supplied, `authorize()` resolves
   *  `Subject`/`PolicyContext` through it (subject risk/session/device
   *  enrichment) instead of the DB-free Phase 1B adapters alone. */
  pip?: PolicyInformationPoint;
  /** Recovers a verified session id (JWT `sid` claim / `user_sessions.jti`)
   *  from the request, when the caller already has one available (e.g.
   *  from whatever set `req.user`). This directory never re-verifies a
   *  token itself to extract this — same boundary
   *  `pip/context-adapter.ts`'s header already draws. Omit when no
   *  verified session id is available; `PolicyContext.sessionId` (and
   *  anything a PIP `SessionProvider` would have derived from it) is then
   *  simply left unset, same as calling `policyContextFromRequest()`
   *  directly with no `sessionId`. */
  sessionId?: (req: Request) => string | undefined;
  /**
   * Phase 25 (Production Hardening): a time budget, in milliseconds,
   * enforced via `../hardening/timeout.ts`'s `withTimeout()` around each
   * of `pip.resolveSubject()`/`pip.resolveContext()` in `authorize.ts`.
   * Ignored when `pip` is omitted (there is nothing to bound). A provider
   * that exceeds this budget rejects with an `AuthorizationTimeoutError`,
   * which lands in `authorize()`'s existing PIP try/catch exactly like any
   * other provider throw — same Phase 22E `PIP_ENRICHMENT_ERROR` fail-
   * closed DENY, no new reason code needed. Omit (or pass `undefined`/`0`/
   * negative) to keep the pre-Phase-25 unbounded wait, byte-for-byte. */
  pipTimeoutMs?: number;
  /**
   * Route Integration Roadmap — Season A, Phase A3 (Telemetry hookup):
   * an optional `PolicyDecisionObserver` (../policy-engine.ts) to attach
   * to the throwaway `PolicyEngine` that `requirePermission()`/
   * `requireOwnership()`/`requireRole()`/`requireStepUp()`/
   * `requireApproval()` (middleware.ts) each construct internally.
   * `requirePolicy()` itself ignores this — it takes an already-built
   * `engine` from the caller, who already controls that engine's own
   * `onDecision` at its own construction site.
   *
   * This directory stays DB-free by design (see ./index.ts's own header:
   * "any real DB-backed provider a caller wires in is supplied BY the
   * caller, never constructed inside this directory") — this field is
   * that same rule applied to observability. This file never imports
   * `lib/policy/audit/drizzle-audit-writer.ts` or constructs one; a
   * caller (e.g. `middlewares/auth.ts`) that wants decisions durably
   * audited builds its own observer (typically
   * `composeObservers(authorizationObserver, createAuthorizationAuditObserver(...))`)
   * and passes it here. Omit for the exact same behavior as every phase
   * before this one — an engine with no `onDecision` at all.
   */
  onDecision?: PolicyDecisionObserver;
}

/**
 * How a PEP middleware turns a non-ALLOW `AuthorizationDecision` into an
 * HTTP response. Every callback fully owns the response for its outcome
 * (must call `res.json()`/`res.send()`/`res.end()` itself, or call
 * `next()`/`next(err)`) — omit any of these to get this directory's own
 * default rendering (enforce.ts) for that outcome instead.
 */
export interface PepResponseOptions {
  onDeny?: (req: Request, res: Response, next: NextFunction, outcome: AuthorizeOutcome) => void | Promise<void>;
  onStepUp?: (req: Request, res: Response, next: NextFunction, outcome: AuthorizeOutcome) => void | Promise<void>;
  onApprovalRequired?: (req: Request, res: Response, next: NextFunction, outcome: AuthorizeOutcome) => void | Promise<void>;
  /**
   * Whether the DENY response's body should include Phase 15's admin/
   * debug `detail` alongside the always-present, fixed `userMessage` —
   * see ../explain/explain-authorization.ts's and
   * ../explain/viewer-authorization.ts's own headers for why this is a
   * server-side decision, never a client-supplied flag. Defaults to
   * `false` (fail-closed on exposure) when omitted. A function receives
   * the request so a caller can route it through
   * `canViewExplanationDetail()` (Phase 15) against the SAME already-
   * DB-verified subject this request's own decision was evaluated
   * against, not a second, independently-trusted signal.
   */
  includeDetail?: boolean | ((req: Request) => boolean | Promise<boolean>);
}

/** Union of the two option groups every PEP middleware factory accepts. */
export type PepMiddlewareOptions = PepEnrichmentOptions & PepResponseOptions;

/**
 * What `authorize()` (authorize.ts) hands back to `enforce()` (enforce.ts)
 * and — via `req.authorization` (see the `declare global` augmentation
 * below) — to whatever business-service code runs after a PEP middleware
 * calls `next()`. `request` is `undefined` only for the same one path
 * `resolveRequestOrEarlyDecision()` (../policy-engine.ts) already leaves
 * it undefined for (invalid context, before validation completes) — see
 * authorize.ts's own header for why this directory still always calls the
 * real engine either way.
 */
export interface AuthorizeOutcome {
  decision: AuthorizationDecision;
  request: AuthorizationRequest | undefined;
  subject: Subject | null;
}

declare global {
  namespace Express {
    interface Request {
      /** Set by `enforce()` (enforce.ts) right before it decides how to
       *  respond — present for EVERY outcome (ALLOW included), so a
       *  business-service handler downstream of a PEP middleware can
       *  still read e.g. `req.authorization.decision.requestId` for its
       *  own audit/logging without re-deriving it. Never set by anything
       *  outside this directory. */
      authorization?: AuthorizeOutcome;
    }
  }
}
