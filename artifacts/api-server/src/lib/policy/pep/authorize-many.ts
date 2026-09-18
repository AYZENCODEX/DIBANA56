/**
 * lib/policy/pep/authorize-many.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 20 (Batch Authorization).
 *
 * The roadmap's own Phase 20 section, verbatim:
 *
 *   "Support: authorizeMany(). Use for: marketplace lists, projects,
 *    organization members, vault resources, admin dashboards. Avoid N+1
 *    authorization queries."
 *
 * ── What the N+1 actually is here ─────────────────────────────────────────
 * A route rendering a list of N resources (a marketplace page, a vault
 * folder, an admin dashboard row set) that wants a per-item authorization
 * decision (can THIS viewer edit/approve/see THIS row) has an obvious naive
 * implementation: call `authorize()` (./authorize.ts) once per resource.
 * `authorize()` itself makes zero DB calls (see its own header — "this file
 * itself performs zero DB reads"), but everything it delegates to for
 * Subject/PolicyContext resolution can: `enrichment.pip.resolveSubject()`/
 * `resolveContext()` (Phase 18) compose whichever `RiskProvider`/
 * `SessionProvider`/`DeviceProvider`/`SubjectProvider` the caller's
 * `PolicyInformationPoint` was built with, and those DO read the DB
 * (`drizzle-session-context-provider.ts`, `drizzle-device-trust-provider.ts`,
 * `login-security-risk-provider.ts`, `drizzle-subject-provider.ts`). Calling
 * `authorize()` N times for one list therefore means re-resolving the
 * SAME subject's risk/session/device/verification standing N times over —
 * a real N+1, even though every individual `PolicyEngine.evaluate()` call
 * after that point is already an in-memory rule pass. `authorizeMany()`
 * resolves Subject/PolicyContext EXACTLY ONCE per batch (the same
 * subject-resolution code path `authorize()` itself uses — see
 * "Never a second Subject/PolicyContext resolution path" below) and reuses
 * that single result across every item's `engine.evaluate()` call.
 *
 * ── Never a second Subject/PolicyContext resolution path ─────────────────
 * The subject/context-building block below is the exact same three-branch
 * shape `authorize()` (./authorize.ts) already implements (PIP-enriched
 * when `enrichment.pip` is supplied, DB-free Phase 1B adapters otherwise) —
 * duplicated here rather than factored into a shared helper only because
 * `authorize()` deliberately stays single-item-shaped (see its own header:
 * the mid-handler "one WHO/WHAT/WHICH question" primitive) and importing
 * it in a loop would reintroduce the exact N+1 this file exists to remove.
 * Any future change to how a Subject/PolicyContext is resolved from a
 * request must be made in BOTH places — same "no new way to reach a
 * Decision" discipline every PEP helper in ./middleware.ts already
 * follows, just applied to subject resolution instead of decision
 * resolution.
 *
 * ── Still N calls into the engine — that part is NOT batched ─────────────
 * `authorizeMany()` does not attempt to batch `engine.evaluate()` itself
 * into a single call, and does not change `PolicyEngine`/`PrecedenceEngine`
 * in any way (Rule 16 — do not implement future phases prematurely; a
 * genuinely vectorized PDP evaluation is not anything the roadmap asks
 * for here). Every registered `PolicyRule` already built (Phase 02-13) is
 * itself an in-memory, synchronous-or-already-cached function of
 * `(subject, action, resource, context)` — see e.g. `rbac/rbac-rule.ts`'s
 * own header on `RbacProvider` being read once per user, not once per
 * resource. Running N of those in a loop, once subject/context resolution
 * is already paid for exactly once, is the "avoid N+1" the roadmap asks
 * for — not a new batched-PDP capability.
 *
 * ── One shared `PolicyContext`, one shared `requestId` ────────────────────
 * Every item in one `authorizeMany()` call shares the SAME resolved
 * `PolicyContext` object (and therefore the same `context.requestId`) —
 * deliberately, since all N decisions are answering the same logical
 * "what can this caller do, right now, across this list" question as part
 * of rendering ONE route response. This lets every decision in the batch
 * be correlated back to the same audit/log line (Phase 17) by
 * `requestId`, the same way every rule consulted for a single `authorize()`
 * call already shares one `requestId` today.
 *
 * ── Never invents a new way to reach ALLOW/DENY/STEP_UP/APPROVAL_REQUIRED ─
 * Same "PEP enforces, PDP decides" discipline as every other file in this
 * directory (see ./types.ts's own header) — each item's decision comes
 * from the exact same `engine.evaluate()` call `authorize()` itself makes;
 * `authorizeMany()` only removes the redundant Subject/PolicyContext work
 * around N of those calls.
 *
 * ── Not a middleware ──────────────────────────────────────────────────────
 * Like `authorize()`, this is a plain async function a route/service
 * handler calls directly (typically to filter a list before serializing
 * it), not a `(req, res, next)` middleware — batch authorization
 * inherently produces per-item results a caller must fold into its own
 * response shape (filter the list, annotate each row with a `canEdit`
 * flag, etc.), which `enforce()` (./enforce.ts) has no generic way to do.
 */

import type { Request } from "express";
import { policyContextFromRequest } from "../pip/context-adapter";
import { subjectFromAuthUser, type AuthenticatedUserLike } from "../pip/subject-adapter";
import type { AuthorizationDecision, AuthorizationRequest, PolicyContext, ResourceRef, Subject } from "../types";
import { resolveRequestOrEarlyDecision } from "../policy-engine";
import type { AuthorizingEngine, PepEnrichmentOptions } from "./types";

/**
 * One resource to authorize as part of a batch. `key` is caller-supplied
 * (a resource id, an array index, a DB primary key — whatever the caller
 * already uses to identify this row) so results can be matched back to
 * the original list without relying on array order alone.
 */
export interface AuthorizeManyItem<K = string | number> {
  key: K;
  /** Defaults to `input.action` (see `AuthorizeManyInput.action`) when
   *  every item in the batch shares one action (the common "can I edit
   *  each of these rows" list case). Set per-item only when different
   *  rows in the same batch need different actions checked (rare — e.g.
   *  an admin dashboard mixing edit/approve checks in one render pass). */
  action?: string;
  resource: ResourceRef;
}

export interface AuthorizeManyResult<K = string | number> {
  key: K;
  decision: AuthorizationDecision;
  request: AuthorizationRequest | undefined;
}

export interface AuthorizeManyOutcome<K = string | number> {
  subject: Subject | null;
  results: AuthorizeManyResult<K>[];
}

export interface AuthorizeManyInput<K = string | number> {
  req: Request;
  engine: AuthorizingEngine;
  /** Shared action for every item that doesn't set its own — see
   *  `AuthorizeManyItem.action`. Optional only when EVERY item sets its
   *  own `action`; omitting both is a construction-time error (see
   *  below), never a silent "check nothing". */
  action?: string;
  items: AuthorizeManyItem<K>[];
  enrichment?: PepEnrichmentOptions;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * Resolves `req.user` + `req` into a Subject/PolicyContext EXACTLY ONCE
 * (see file header — the whole point of this function), then evaluates
 * `input.engine` once per item in `input.items`, reusing that single
 * Subject/PolicyContext for every one. Returns every item's decision
 * alongside the shared `subject` — never throws for an authorization-
 * shaped failure (same fail-closed guarantee `authorize()`/
 * `PolicyEngine.evaluate()` already provide); a construction-time
 * programmer error (an item with no resolvable `action`) throws
 * immediately, before any engine call, same "fail loud, don't silently
 * misattribute" posture `./middleware.ts`'s `requirePermission()`/
 * `requireOwnership()` already establish for their own construction-time
 * inputs.
 */
export async function authorizeMany<K = string | number>(
  input: AuthorizeManyInput<K>,
): Promise<AuthorizeManyOutcome<K>> {
  const { req, engine, action: defaultAction, items, enrichment } = input;

  for (const item of items) {
    if (!(item.action ?? defaultAction)) {
      throw new Error(
        `authorizeMany(): item with key "${String(item.key)}" has no "action" and no batch-level default "action" was supplied.`,
      );
    }
  }

  // ── Resolve Subject/PolicyContext EXACTLY ONCE — see file header ────────
  // Mirrors authorize.ts's own subject/context resolution verbatim; kept
  // in sync deliberately, not factored out — see this file's own header,
  // "Never a second Subject/PolicyContext resolution path".
  const rawUser = (req.user ?? null) as AuthenticatedUserLike | null;
  const sessionId = enrichment?.sessionId?.(req);
  let context: PolicyContext = policyContextFromRequest(req, { sessionId });

  let subject: Subject | null;
  if (enrichment?.pip) {
    subject = await enrichment.pip.resolveSubject(rawUser, context);
    context = await enrichment.pip.resolveContext(context, {
      userId: subject?.userId,
      userAgent: firstHeaderValue(req.headers["user-agent"]),
    });
  } else {
    subject = subjectFromAuthUser(rawUser);
  }

  const results: AuthorizeManyResult<K>[] = [];
  for (const item of items) {
    const action = item.action ?? defaultAction!;
    const buildInput = { subject, action, resource: item.resource, context };

    // Pure — see authorize.ts's own header for why this is only ever used
    // for `request` (explain()/audit display), never for the decision
    // itself.
    const resolved = resolveRequestOrEarlyDecision(buildInput);
    const decision = await engine.evaluate(buildInput);

    results.push({ key: item.key, decision, request: resolved.request });
  }

  return { subject, results };
}

/** Convenience filter: the subset of `outcome.results` whose decision was
 *  ALLOW, in the same order they were passed to `authorizeMany()`. Covers
 *  the roadmap's own named use case ("marketplace lists, projects,
 *  organization members, vault resources, admin dashboards") — rendering
 *  only the rows a viewer may act on — without every call site
 *  re-implementing the same `.filter(r => r.decision.effect === "ALLOW")`
 *  by hand. Purely a convenience over `outcome.results`; never a second
 *  way to reach ALLOW (see file header). */
export function allowedKeys<K = string | number>(outcome: AuthorizeManyOutcome<K>): K[] {
  return outcome.results.filter((r) => r.decision.effect === "ALLOW").map((r) => r.key);
}
