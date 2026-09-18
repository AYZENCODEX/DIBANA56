/**
 * lib/policy/pep/authorize.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK).
 *
 * `authorize()` is the roadmap's own named Phase 19 entry point, and the
 * one function every middleware in ./middleware.ts is built on top of. It
 * is deliberately NOT a middleware itself (no `(req, res, next)` signature,
 * never touches `res`) — it is the "PEP calls the PDP for one WHO/WHAT/
 * WHICH question and gets a Decision back" primitive a route handler can
 * also call directly, mid-handler, for a conditional check that shouldn't
 * gate the whole route (e.g. "show an extra field only if this viewer
 * could also approve it" — a Phase 15-style `includeDetail` decision made
 * with a real Decision, not a hand-rolled second permission check).
 * `./middleware.ts`'s `requirePolicy()` is the thin `(req, res, next)`
 * wrapper around this for the common "gate the whole route" case.
 *
 * ── Building the Subject/PolicyContext: Phase 1B by default, Phase 18 when
 *    asked ──────────────────────────────────────────────────────────────
 * `req.user` (set by `middlewares/auth.ts`'s `requireAuth`/`requireAdmin`/
 * etc., upstream of any PEP middleware — see roadmap's own Phase 19
 * "Expected flow": route → authentication → authorization middleware →
 * business service) is reshaped via `subjectFromAuthUser()` (Phase 1B) and
 * `policyContextFromRequest()` (Phase 1B), same as calling those adapters
 * directly. When the caller supplies `enrichment.pip` (a Phase 18
 * `PolicyInformationPoint`), those two calls are replaced by
 * `pip.resolveSubject()`/`pip.resolveContext()` instead — composing
 * whichever risk/session/device providers that instance was constructed
 * with. Either way, this file itself performs zero DB reads — it only
 * calls whichever adapter/facade the caller already built (or the DB-free
 * Phase 1B fallback), same boundary every PIP adapter's own header already
 * draws.
 *
 * ── Always calls the real engine — never shortcuts to an early decision
 *    itself ────────────────────────────────────────────────────────────
 * `resolveRequestOrEarlyDecision()` (../policy-engine.ts, exported since
 * Phase 08) is called here ONLY to recover the built `AuthorizationRequest`
 * for callers that want it (e.g. `../explain/explain-authorization.ts`'s
 * `request` option, for its `detail.resource`/`detail.assuranceLevel`/
 * `detail.risk` fields) — it is a pure, side-effect-free rebuild of the
 * exact same request `engine.evaluate()` is about to build again
 * internally (deterministic, Rule 12 — rebuilding it twice can never
 * disagree with itself). It is NEVER used as a shortcut to skip calling
 * `engine.evaluate()`: doing that would silently bypass whatever
 * `onDecision` audit/observability hook (Phase 1C/17) the caller's engine
 * was constructed with for every invalid-context/unauthenticated request —
 * exactly the decisions Rule 10 (auditable) cares about seeing. So this
 * function ALWAYS calls `engine.evaluate(input)` for every request that
 * reaches a built `AuthorizationRequest`, and separately (also always)
 * calls `resolveRequestOrEarlyDecision(input)` purely to recover `request`
 * for display — the former is authoritative for the DECISION, the latter
 * is only ever used for what gets SHOWN about it.
 *
 * ── Phase 22E (Reliability) hardening: PIP failures fail closed too ───────
 * The one narrow, deliberate exception to "always call the real engine",
 * above: if `enrichment.pip.resolveSubject()`/`resolveContext()` itself
 * throws (a `SubjectProvider`/`RiskProvider`/`SessionProvider`/
 * `DeviceProvider` backed by a database that is down, a network call that
 * timed out, or any other provider-level failure — see each provider
 * interface's own file for what a real implementation reads), there is no
 * trustworthy `Subject`/`PolicyContext` to build an `AuthorizationRequest`
 * from at all. Falling back to the raw, unenriched `req.user`/pre-PIP
 * context would silently evaluate the request with a WEAKER, partially-
 * missing attribute set than the caller explicitly asked for by supplying
 * a PIP (e.g. missing risk/device signals a risk-aware or device-aware
 * rule depends on to deny) — exactly the "never trust... without
 * server-side validation" and fail-closed posture Rules 8/9 require, read
 * together. So this one path returns a synthesized `PIP_ENRICHMENT_ERROR`
 * DENY immediately, WITHOUT calling `engine.evaluate()` — there is no safe
 * `BuildAuthorizationRequestInput` to hand it. This differs from
 * `resolveRequestOrEarlyDecision()`'s own early-decision paths (invalid
 * context, unauthenticated), which describe well-defined, safe-to-evaluate
 * states (a `null` subject is a real, meaningful input `engine.evaluate()`
 * already knows how to fail closed on) — a PIP throw describes the ABSENCE
 * of any such well-defined state. Prior to Phase 22E this file (and
 * `pip/policy-information-point.ts`'s own `resolveSubject()`/
 * `resolveContext()`) did not catch this at all: an unhandled provider
 * throw propagated out of `authorize()` as a rejected promise instead of a
 * DENY decision — see
 * `CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE22E.md` for how Phase 22E's
 * own test suite found this and why fixing it (rather than merely
 * documenting it) was the correct call for a NON-NEGOTIABLE rule.
 *
 * ── Phase 25 (Production Hardening): PIP calls are now time-bounded too ──
 * Phase 22E (above) made a *throwing* PIP provider fail closed. It did not
 * make a *hanging* one fail closed — a provider whose promise simply never
 * settles (a hung DB connection, a network call with no timeout of its
 * own) would leave `authorize()` awaiting it forever, which is exactly the
 * DoS/fail-closed gap `../hardening/timeout.ts`'s own header describes.
 * When the caller supplies `enrichment.pipTimeoutMs`, both
 * `pip.resolveSubject()` and `pip.resolveContext()` below are now wrapped
 * in `withTimeout()`. A timeout rejects with an `AuthorizationTimeoutError`
 * — which is just another thrown `cause` as far as the try/catch already
 * here is concerned, so it flows into the exact same `pipFailureOutcome()`
 * / `PIP_ENRICHMENT_ERROR` DENY Phase 22E already built; no new reason
 * code, no new catch branch. Omitting `pipTimeoutMs` keeps the pre-Phase-25
 * unbounded wait, byte-for-byte (see `withTimeout()`'s own "opt-in"
 * section) — this is purely additive.
 */

import type { Request } from "express";
import { resolveRequestOrEarlyDecision } from "../policy-engine";
import { policyContextFromRequest } from "../pip/context-adapter";
import { subjectFromAuthUser, type AuthenticatedUserLike } from "../pip/subject-adapter";
import { withTimeout } from "../hardening/timeout";
import type { AuthorizationDecision, PolicyContext, ResourceRef, Subject } from "../types";
import type { AuthorizeOutcome, AuthorizingEngine, PepEnrichmentOptions } from "./types";

export interface AuthorizeInput {
  req: Request;
  /** Any engine satisfying `AuthorizingEngine` — a real `PolicyEngine`/
   *  `PrecedenceEngine` the caller already assembled and registered rules
   *  on, or a throwaway single-rule one (see ./middleware.ts's
   *  `requirePermission()`/`requireOwnership()`/etc. for that pattern). */
  engine: AuthorizingEngine;
  action: string;
  resource: ResourceRef;
  enrichment?: PepEnrichmentOptions;
}

/**
 * Resolves `req.user` + `req` into a `Subject`/`PolicyContext`, evaluates
 * `(subject, action, resource, context)` against `input.engine`, and
 * returns the resulting Decision alongside the Subject and (when
 * available) the built `AuthorizationRequest`. Never touches `res` and
 * never throws for an authorization-shaped failure — same fail-closed
 * guarantee `PolicyEngine.evaluate()`/`PrecedenceEngine.evaluate()`
 * themselves already provide (see policy-engine.ts's header); this
 * function only adds the Express-request-shaping step on top.
 */
export async function authorize(input: AuthorizeInput): Promise<AuthorizeOutcome> {
  const { req, engine, action, resource, enrichment } = input;

  const rawUser = (req.user ?? null) as AuthenticatedUserLike | null;
  const sessionId = enrichment?.sessionId?.(req);
  let context = policyContextFromRequest(req, { sessionId });

  let subject: Subject | null;
  if (enrichment?.pip) {
    const pip = enrichment.pip;
    const pipTimeoutMs = enrichment.pipTimeoutMs;
    try {
      // Phase 25: see file header's "PIP calls are now time-bounded too"
      // section — a timeout here surfaces as an AuthorizationTimeoutError,
      // caught below exactly like any other provider throw.
      subject = await withTimeout(() => pip.resolveSubject(rawUser, context), pipTimeoutMs, "PIP resolveSubject()");
      context = await withTimeout(
        () =>
          pip.resolveContext(context, {
            userId: subject?.userId,
            userAgent: firstHeaderValue(req.headers["user-agent"]),
          }),
        pipTimeoutMs,
        "PIP resolveContext()",
      );
    } catch (cause) {
      // Fail closed (Rule 8) — see file header's "Phase 22E hardening"
      // section. No safe Subject/PolicyContext exists to evaluate, so
      // this returns a DENY directly rather than calling engine.evaluate()
      // with unknown or partially-enriched attributes.
      return pipFailureOutcome(context, cause);
    }
  } else {
    subject = subjectFromAuthUser(rawUser);
  }

  const buildInput = { subject, action, resource, context };

  // Pure — see file header's "Always calls the real engine" section for
  // why this is only ever used for `request`, never for the decision
  // itself.
  const resolved = resolveRequestOrEarlyDecision(buildInput);

  const decision = await engine.evaluate(buildInput);

  return { decision, request: resolved.request, subject };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * Synthesizes the fail-closed `AuthorizeOutcome` for a thrown PIP provider
 * — see this file's header, "Phase 22E hardening" section. Mirrors
 * `resolveRequestOrEarlyDecision()`'s own (../policy-engine.ts)
 * `INVALID_AUTHORIZATION_CONTEXT` branch: no real `AuthorizationRequest`
 * exists (there is no trustworthy subject to build one from), so
 * `requestId` is stamped straight from the pre-PIP `PolicyContext` (still
 * safe — built DB-free by `policyContextFromRequest()` before the PIP was
 * ever called) rather than from a request object this path never builds.
 * `subject: null` on the returned `AuthorizeOutcome` reflects the true
 * state honestly: not "unauthenticated" (we never got far enough to know),
 * simply "no subject could be safely resolved".
 */
function pipFailureOutcome(context: PolicyContext, cause: unknown): AuthorizeOutcome {
  const decision: AuthorizationDecision = {
    effect: "DENY",
    reason: "PIP_ENRICHMENT_ERROR",
    message: cause instanceof Error ? cause.message : "Policy Information Point provider failed",
    requestId: context.requestId,
    evaluatedAt: new Date(),
  };
  return { decision, request: undefined, subject: null };
}
