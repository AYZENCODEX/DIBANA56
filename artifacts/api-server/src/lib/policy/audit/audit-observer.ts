/**
 * lib/policy/audit/audit-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 17 (Authorization Audit).
 *
 * `createAuthorizationAuditObserver()` builds a `PolicyDecisionObserver`
 * (../policy-engine.ts) — the exact same seam `../decision-observer.ts`'s
 * `createLoggingObserver()` already uses — that turns every finalized
 * decision into an `AuthorizationAuditEntry` (./to-audit-entry.ts) and
 * persists it through a caller-supplied `AuthorizationAuditWriter`
 * (./types.ts). A caller wires it as:
 *
 *   import { PolicyEngine, createAuthorizationAuditObserver } from "./lib/policy";
 *   import { DrizzleAuthorizationAuditWriter } from "./lib/policy/audit/drizzle-audit-writer";
 *   const engine = new PolicyEngine({
 *     onDecision: createAuthorizationAuditObserver(new DrizzleAuthorizationAuditWriter()),
 *   });
 *
 * Nothing in the app constructs this yet (same posture every prior Phase's
 * dormant surface area has taken — see e.g. ../decision-observer.ts's own
 * header, or ../registry/drizzle-policy-registry-provider.ts's) — Rule 16
 * ("do not implement future phases prematurely") plus the roadmap's own
 * migration strategy (real routes are wired to the engine, and shadow
 * mode, are later phases/work) means this is reviewed and tested surface
 * area, not yet load-bearing traffic.
 *
 * ── Fire-and-forget, exactly like createLoggingObserver() ──────────────
 * `PolicyEngine.notifyObserver()` already never awaits `onDecision`'s
 * returned promise before `evaluate()` resolves (see that method's own
 * doc comment) — so a slow database write here adds no latency to the
 * authorization decision itself. On top of that, this observer wraps
 * `writer.write()` in its own try/catch (belt-and-suspenders, same as
 * `createLoggingObserver()`'s own header explains for its logger calls)
 * so a rejected write is swallowed here too, defensively, even though the
 * engine would already swallow it one layer up. A failing audit writer
 * must NEVER become a new way for authorization to fail — that would
 * turn a durability problem into an availability problem, which is
 * exactly backwards from what an audit trail is for.
 */

import type { AuthorizationDecision, AuthorizationRequest } from "../types";
import type { PolicyDecisionObserver } from "../policy-engine";
import { toAuditEntry } from "./to-audit-entry";
import type { AuthorizationAuditWriter } from "./types";

export function createAuthorizationAuditObserver(writer: AuthorizationAuditWriter): PolicyDecisionObserver {
  return (decision: AuthorizationDecision, request: AuthorizationRequest | undefined): void | Promise<void> => {
    try {
      const entry = toAuditEntry(decision, request);
      return writer.write(entry).catch(() => {
        // Swallowed intentionally — see file header. A write failure must
        // never surface as, or cause, an authorization failure.
      });
    } catch {
      // Swallowed intentionally — same posture as above, for the
      // synchronous half (toAuditEntry() throwing, or writer.write()
      // itself throwing synchronously rather than returning a rejected
      // promise).
      return undefined;
    }
  };
}
