/**
 * lib/policy/pep/enforce.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK).
 *
 * `enforce()` is the second half of every middleware in ./middleware.ts:
 * `authorize()` answers WHAT the PDP decided, `enforce()` answers WHAT
 * EXPRESS DOES ABOUT IT. Splitting the two means `authorize()` stays a
 * pure "ask the PDP" primitive a route handler can call mid-request (see
 * authorize.ts's own header — the `includeDetail`-style conditional-check
 * use case), while `enforce()` is the one and only place in this whole
 * engine that turns a `Decision` into an HTTP status/body. PEP enforces.
 * PDP decides — this file is the "enforces" half, verbatim.
 *
 * ── Never invents a new outcome ───────────────────────────────────────────
 * `enforce()` branches on `decision.effect`/`decision.reason` ONLY to pick
 * an HTTP status code and a response shape — it never re-evaluates
 * anything, never consults a rule, and never produces a DENY/STEP_UP/
 * APPROVAL_REQUIRED itself. The `AuthorizationDecision` it renders was
 * already fully decided by `authorize()`'s call into the caller's engine.
 *
 * ── `req.authorization` is stamped for EVERY outcome, before any response
 *    is sent ────────────────────────────────────────────────────────────
 * See ./types.ts's own doc comment on `Express.Request.authorization` —
 * "present for EVERY outcome (ALLOW included)". Stamped first, then
 * branched on, so a business-service handler downstream of `next()` can
 * always read it, and so any `onDeny`/`onStepUp`/`onApprovalRequired`
 * override (which fully owns the response after that point — see
 * ./types.ts's `PepResponseOptions` doc comment) still sees it too, should
 * it want to log `decision.requestId` itself.
 *
 * ── UNAUTHENTICATED is a DENY, rendered as 401 instead of 403 ─────────────
 * `authorize.ts`/`../policy-engine.ts` both model "no subject at all" as
 * `effect: "DENY", reason: "UNAUTHENTICATED"` (decision-reasons.ts's own
 * doc comment: "Distinguished from EXPLICIT_DENY so logs/metrics can
 * separate 'not logged in' from 'logged in but not permitted'"). This file
 * reuses that exact distinction to pick the HTTP status — 401 for
 * UNAUTHENTICATED, 403 for every other DENY reason — without adding a
 * second, parallel "is this an auth failure" check of its own.
 * `requirePolicy()`'s own `options.onDeny` (see ./types.ts) covers BOTH
 * cases uniformly, same as any other DENY — a caller wanting to render
 * "not logged in" differently from "logged in, not permitted" can still
 * do so by inspecting `outcome.decision.reason` inside its own `onDeny`.
 *
 * ── STEP_UP is rendered as 401, not 403 ───────────────────────────────────
 * A STEP_UP outcome means the subject IS authenticated but the CURRENT
 * SESSION's assurance is insufficient — the same "prove who you are again,
 * more strongly" shape as an expired/insufficient credential, which is
 * conventionally a 401 (`WWW-Authenticate`-adjacent), not a 403
 * ("you are who you say, and it's still not enough"). `requiredAssurance`
 * (copied verbatim from `decision.requiredAssurance` — see
 * ../authorization-decision.ts's `stepUp()` builder) is always included so
 * a client knows exactly which assurance level to step up to, without
 * needing `includeDetail`/admin access to find out.
 *
 * ── `includeDetail` is resolved HERE, once, per request ───────────────────
 * `PepResponseOptions.includeDetail` (./types.ts) may be a plain boolean or
 * a per-request predicate — this file is the one place that distinction is
 * collapsed to a plain boolean before being handed to
 * `explainAuthorizationDecision()` (Phase 15, ../explain/explain-
 * authorization.ts), which itself has no notion of "who is asking" (see
 * that file's own header). Defaults to `false` (fail-closed on exposure —
 * same posture `./types.ts`'s own doc comment on `includeDetail`
 * establishes) when omitted entirely.
 *
 * ── Every default response body is deliberately the same shape ───────────
 * `{ error, code, solution, detail? }` for DENY/APPROVAL_REQUIRED, plus
 * `requiredAssurance` for STEP_UP — `code` is always `decision.reason`
 * (the exact same closed `DecisionReasonCode` vocabulary every audit/log
 * consumer already reads — decision-reasons.ts), `solution` is always the
 * roadmap's own fixed `GENERIC_DENIAL_MESSAGE` (Phase 15), and `detail` is
 * Phase 15's admin/debug detail, gated behind `includeDetail`. A caller
 * that wants an entirely different body shape supplies `onDeny`/
 * `onStepUp`/`onApprovalRequired` instead of trying to reshape this one.
 */

import type { NextFunction, Request, Response } from "express";
import { explainAuthorizationDecision } from "../explain/explain-authorization";
import { GENERIC_DENIAL_MESSAGE } from "../explain/types";
import type { AuthorizeOutcome, PepMiddlewareOptions } from "./types";

async function resolveIncludeDetail(req: Request, options: PepMiddlewareOptions): Promise<boolean> {
  const { includeDetail } = options;
  if (typeof includeDetail === "function") {
    return Boolean(await includeDetail(req));
  }
  return Boolean(includeDetail);
}

/**
 * Renders `outcome` (from a prior `authorize()` call) onto `res`, or calls
 * `next()` for ALLOW. Every `requirePolicy()`-built middleware in
 * ./middleware.ts calls this as its very last step — this is the only
 * function in this directory that touches `res`.
 */
export async function enforce(
  req: Request,
  res: Response,
  next: NextFunction,
  outcome: AuthorizeOutcome,
  options: PepMiddlewareOptions = {},
): Promise<void> {
  // Present for EVERY outcome, before any response/next() — see file
  // header and ./types.ts's own doc comment on this field.
  req.authorization = outcome;

  const { decision } = outcome;

  switch (decision.effect) {
    case "ALLOW": {
      next();
      return;
    }

    case "STEP_UP": {
      if (options.onStepUp) {
        await options.onStepUp(req, res, next, outcome);
        return;
      }
      res.status(401).json({
        error: "Unauthorized",
        code: decision.reason,
        solution: GENERIC_DENIAL_MESSAGE,
        requiredAssurance: decision.requiredAssurance,
      });
      return;
    }

    case "APPROVAL_REQUIRED": {
      if (options.onApprovalRequired) {
        await options.onApprovalRequired(req, res, next, outcome);
        return;
      }
      res.status(403).json({
        error: "Forbidden",
        code: decision.reason,
        solution: GENERIC_DENIAL_MESSAGE,
      });
      return;
    }

    case "DENY":
    default: {
      // `default` here is unreachable given `DecisionEffect`'s closed
      // union (types.ts) — kept only for fail-closed defense-in-depth
      // (Rule 8): an engine that somehow produced an outcome outside the
      // known vocabulary is rendered as a DENY, never as an accidental
      // ALLOW-through.
      if (options.onDeny) {
        await options.onDeny(req, res, next, outcome);
        return;
      }
      const isUnauthenticated = decision.reason === "UNAUTHENTICATED";
      const includeDetail = await resolveIncludeDetail(req, options);
      const explanation = includeDetail
        ? explainAuthorizationDecision({ decision, request: outcome.request, includeDetail: true })
        : undefined;
      res.status(isUnauthenticated ? 401 : 403).json({
        error: isUnauthenticated ? "Unauthorized" : "Forbidden",
        code: decision.reason,
        solution: GENERIC_DENIAL_MESSAGE,
        detail: explanation?.detail,
      });
      return;
    }
  }
}
