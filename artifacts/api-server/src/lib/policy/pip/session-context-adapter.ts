/**
 * lib/policy/pip/session-context-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * `PolicyContext.sessionAgeSeconds` (../types.ts) has existed since Phase 05
 * (ABAC), left for "a future Phase 09 (Authentication Assurance) PIP
 * adapter to populate" — that adapter is this one. AYZEN already has a
 * real, durable session record to read it from: `user_sessions`
 * (`lib/sessions.ts`), created once per login with a `created_at` and
 * looked up by `jti` — exactly the `sid`/`jti` that `PolicyContext.sessionId`
 * already carries (see context-adapter.ts, `opts.sessionId`). This module
 * is the first thing in `lib/policy/*` to read that table for session AGE
 * specifically (distinct from `lib/sessions.ts#isSessionRevoked()`, which
 * only answers revoked-or-not, never age).
 *
 * ── Deliberately does NOT populate `authenticationFreshnessSeconds` ───────
 * That field's own doc comment (../types.ts) distinguishes it from
 * `sessionAgeSeconds` precisely: "a session can be old while its last
 * strong-auth moment was recent, e.g. a step-up just completed." Nothing in
 * `user_sessions` (or anywhere else in this codebase — see
 * verification-level-adapter.ts's own header for the same gap re:
 * `assuranceMethods`) records WHEN a step-up/re-auth last happened for a
 * session, only when the session itself was opened. Populating
 * `authenticationFreshnessSeconds` from `created_at` would silently treat
 * every session's *login* moment as its *last strong-auth* moment even
 * after a step-up refreshes the latter — the same kind of real security
 * regression verification-level-adapter.ts already declined to risk for
 * `assuranceMethods`. Left for a later sub-phase that adds real step-up
 * timestamp tracking (Rule 16).
 *
 * ── Reads `context.sessionId`, never a fresh token/session lookup ─────────
 * Same trust boundary every other caller-supplied `PolicyContext` field in
 * this engine already draws: this module only ever reads the `sessionId`
 * the caller (ultimately `pip/context-adapter.ts`, from a verified `sid`)
 * already put on the context — it does not verify a token or accept a
 * caller-supplied session age directly.
 *
 * Same DB-free-interface / separate-real-provider split every other pair in
 * this directory establishes — the real, `@workspace/db`-adjacent
 * implementation (`user_sessions` is a raw-SQL table, see
 * `drizzle-session-context-provider.ts`'s own header) lives in that file.
 */

import type { PolicyContext } from "../types";

/** The one fact this module needs from a session row. */
export interface SessionRecord {
  createdAt: Date;
}

/** Reads one session's `SessionRecord` by `jti` — implemented for real by
 *  `DrizzleSessionContextProvider` (drizzle-session-context-provider.ts); a
 *  test fixture can implement this trivially without any DB. Contract:
 *  never throw for "not found" (or revoked/expired) — return `null`, same
 *  "unknown key contributes nothing" posture every other *Provider in this
 *  engine documents. */
export interface SessionContextProvider {
  getSessionRecord(jti: string): Promise<SessionRecord | null>;
}

/**
 * Pure: session age in whole seconds between `record.createdAt` and `now`,
 * floored at 0 (a clock skew or out-of-order read should never produce a
 * negative age). Deterministic given its inputs — callers pass
 * `context.timestamp` as `now` (see `withSessionAge()` below), never a
 * fresh `Date.now()` read, so repeated evaluation of the same
 * `AuthorizationRequest` always yields the same age (Rule 12).
 */
export function computeSessionAgeSeconds(record: SessionRecord, now: Date): number {
  const deltaMs = now.getTime() - record.createdAt.getTime();
  return Math.max(0, Math.floor(deltaMs / 1000));
}

/**
 * Returns a NEW `PolicyContext` — identical to `context`, with
 * `sessionAgeSeconds` populated from `provider`, computed against
 * `context.timestamp` (never a fresh clock read — see
 * `computeSessionAgeSeconds()`'s own header). Never mutates `context`.
 *
 * No-ops (returns `context` unchanged) when `context.sessionId` is absent,
 * or when `provider` reports no matching/active session for it — same
 * "leave the field unset rather than guess" posture every other optional
 * `PolicyContext`/`Subject` attribute in this engine already establishes.
 */
export async function withSessionAge(
  context: PolicyContext,
  provider: SessionContextProvider,
): Promise<PolicyContext> {
  if (!context.sessionId) return context;
  const record = await provider.getSessionRecord(context.sessionId);
  if (!record) return context;
  return { ...context, sessionAgeSeconds: computeSessionAgeSeconds(record, context.timestamp) };
}
