/**
 * lib/policy/pip/context-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 01 (Foundation / PDP Core),
 * sub-phase 1B: PIP (Policy Information Point) — request-context adapter.
 *
 * Phase 1A's `createPolicyContext()` (policy-context.ts) is transport-
 * agnostic — it takes plain optional fields and stamps `requestId`/
 * `timestamp` consistently. This file is the one place that knows how to
 * pull those fields *out of an Express `Request`* specifically, so a future
 * PEP adapter doesn't reinvent "which header carries the correlation id" or
 * "where does the caller's IP live" at every call site.
 *
 * This is the only file in `lib/policy/` that imports Express's `Request`
 * type — by design, since a PIP request-context adapter's entire job is
 * bridging the transport layer to the transport-agnostic `PolicyContext`
 * shape. `policy-engine.ts` and everything else in this module still has no
 * idea Express exists.
 *
 * Deliberately NOT done here (see CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE1B.md):
 * - Does not read or verify the auth token to recover a session id (`sid`).
 *   `auth-utils.ts`/`lib/jwt.ts` already own token verification; duplicating
 *   that here would be a second, divergent place a token could be parsed.
 *   Callers that already have a verified `sid` (a future PEP layer, once one
 *   exists) can pass it via `opts.sessionId`.
 * - Not wired into any middleware or route. Nothing calls this yet.
 */

import type { Request } from "express";
import { createPolicyContext } from "../policy-context";
import type { PolicyContext } from "../types";

/** Header a caller/proxy may have already set upstream to correlate this
 *  request across services/logs. Same idea as the `X-Request-Id` convention
 *  used by most reverse proxies; AYZEN does not currently guarantee any
 *  proxy sets this, so it is read defensively and falls back to a generated
 *  id (via createPolicyContext) when absent or malformed. */
const CORRELATION_HEADER = "x-request-id";

export interface PolicyContextFromRequestOptions {
  /** Takes precedence over any inbound header — pass this when the caller
   *  (e.g. a future PEP layer) already established a correlation id earlier
   *  in the request lifecycle. */
  requestId?: string;
  /** Verified session id (JWT `sid` claim / `user_sessions.jti`), if the
   *  caller already has one. See file header — this adapter does not
   *  extract it itself. */
  sessionId?: string;
  extra?: Readonly<Record<string, unknown>>;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * Builds a `PolicyContext` from an Express `Request`. Correlation id
 * precedence: `opts.requestId` > inbound `X-Request-Id` header > generated
 * (see `createPolicyContext`). Never throws.
 */
export function policyContextFromRequest(req: Request, opts: PolicyContextFromRequestOptions = {}): PolicyContext {
  const inboundRequestId = firstHeaderValue(req.headers[CORRELATION_HEADER]);
  return createPolicyContext({
    requestId: opts.requestId ?? inboundRequestId,
    ip: req.ip,
    sessionId: opts.sessionId,
    extra: opts.extra,
  });
}
