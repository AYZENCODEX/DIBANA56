/**
 * lib/policy/pip/risk-level-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 10 (Risk-Aware
 * Authorization), sub-phase 10B.
 *
 * 10A's `createRiskRule()` (../risk/risk-rule.ts) already reads
 * `Subject.riskLevel` — 10A left it completely unpopulated (see that
 * file's own header: "It never computes risk itself"). This file is the
 * "Risk Engine = calculates risk" half of the roadmap's own Phase 10
 * framing — the counterpart to 9B's `verification-level-adapter.ts`,
 * same DB-free-interface / separate-real-provider split.
 *
 * ── Reuses the EXISTING login-security signal, doesn't invent a new one ──
 * Roadmap Rule 4: "Reuse existing auth, role, organization, audit,
 * login-security, risk and resource data." `lib/login-security.ts`
 * already computes exactly one real risk signal today:
 * `isAnomalousIp(userId, ip)` — true when the request's IP has never
 * appeared among this account's recent SUCCESSFUL logins (see that
 * function's own doc comment). This module combines that with a second,
 * already-durable signal from the same `login_history` table this
 * codebase already writes on every login attempt
 * (`recordLoginHistory()`): a burst of recent FAILED logins — a classic
 * brute-force/credential-stuffing indicator neither `isAnomalousIp()` nor
 * anything else in this codebase currently surfaces as a standalone
 * signal. Nothing here computes a NEW kind of signal (no new telemetry,
 * no new table) — see `login-security-risk-provider.ts`'s own header for
 * the exact query.
 *
 * ── Per-REQUEST, not just per-LOGIN ────────────────────────────────────────
 * `isAnomalousIp()` was written for the login flow, but it takes a plain
 * `(userId, ip)` — nothing about it is login-specific. This module calls
 * it against `PolicyContext.ip` (the CURRENT request's IP, from
 * `pip/context-adapter.ts`'s `req.ip`), so a session that logged in
 * normally but is now being used from a suddenly-different IP (a hijacked
 * cookie, a shared/leaked token) is flagged too — a real capability this
 * combination adds, not merely a re-check of something login already
 * decided once.
 *
 * ── "Never allow the client to choose its own risk level" ────────────────
 * Same guarantee `risk-rule.ts` already documents for `Subject.riskLevel`
 * itself: `withRiskLevel()` below only ever reads `context.ip` (already
 * server-resolved by `pip/context-adapter.ts` from the transport layer,
 * the same trust boundary every IP-consuming code in this codebase
 * already relies on — spoofing that is a `trust proxy`/network concern
 * outside this module's scope, not something a request body/header could
 * override here) and whatever `provider` reads from the DB. There is no
 * parameter here a caller could use to hand this function a risk level
 * directly.
 *
 * ── DB-free by design, same split 9B established ──────────────────────────
 * This file declares `RiskSignal`/`RiskLevelProvider` (an interface) and a
 * pure mapping function — no `@workspace/db`/`login-security.ts` import,
 * so it stays testable without a database. The real implementation lives
 * in `login-security-risk-provider.ts`, the one file in this pair that
 * imports both.
 *
 * ── Not wired into any route or `subjectFromAuthUser()` yet ───────────────
 * Same posture 9B's `withVerificationLevel()` already established:
 * `subjectFromAuthUser()` (subject-adapter.ts) is untouched; this is a
 * separate, optional enrichment step nothing in this codebase calls yet
 * (Phase 19/PEP's concern).
 */

import type { PolicyContext, Subject } from "../types";

/** The two already-durable login-security facts this module combines.
 *  Neither is a new kind of telemetry — both are already computable from
 *  data `lib/login-security.ts` writes on every login attempt (see file
 *  header). */
export interface RiskSignal {
  /** `isAnomalousIp()`'s own result for this request's IP — `false` when
   *  the request carried no IP to check (see
   *  `login-security-risk-provider.ts`'s own handling of that case). */
  anomalousIp: boolean;
  /** Count of this account's FAILED login attempts within the provider's
   *  lookback window (see `login-security-risk-provider.ts` for the exact
   *  window) — a brute-force/credential-stuffing indicator, independent
   *  of whether any of those attempts came from an anomalous IP. */
  recentFailedLogins: number;
}

/** Reads one user's current `RiskSignal` for a given request IP —
 *  implemented for real by `LoginSecurityRiskProvider`
 *  (login-security-risk-provider.ts); a test fixture can implement this
 *  trivially without any DB. */
export interface RiskLevelProvider {
  getRiskSignal(userId: number, ip: string | undefined): Promise<RiskSignal>;
}

/** How many recent failed logins count as a "burst" on their own (with no
 *  anomalous IP involved) — chosen to sit above ordinary human mistyping
 *  (2-3 wrong passwords happens to everyone) while still catching a
 *  sustained guessing attempt well before `vault-pin-guard.ts`'s own
 *  5-attempt Vault-specific lockout would separately kick in for Vault
 *  actions specifically. Exported so a caller/test references the same
 *  constant rather than risking two hardcoded `3`s drifting apart. */
export const RISK_FAILED_LOGIN_BURST_THRESHOLD = 3;

/**
 * Pure mapping: `RiskSignal` → one of `Subject.riskLevel`'s three values.
 * Both signals present at once (an anomalous IP ALSO showing a recent
 * failed-login burst) escalates to `"high"` — two independent red flags
 * agreeing is meaningfully stronger evidence than either alone. Either
 * signal alone is `"medium"` (roadmap: MEDIUM → STEP_UP, an extra
 * authentication check rather than an outright block for a single,
 * possibly-innocent signal — a new IP with no failed attempts nearby is
 * plausibly just a new device/network, not an attack). Neither signal
 * present is `"low"`. Pure, deterministic, never throws.
 */
export function mapRiskSignalToLevel(signal: RiskSignal): NonNullable<Subject["riskLevel"]> {
  const hasAnomalousIp = signal.anomalousIp;
  const hasFailedLoginBurst = signal.recentFailedLogins >= RISK_FAILED_LOGIN_BURST_THRESHOLD;

  if (hasAnomalousIp && hasFailedLoginBurst) return "high";
  if (hasAnomalousIp || hasFailedLoginBurst) return "medium";
  return "low";
}

/**
 * Returns a NEW `Subject` — identical to `subject`, with `riskLevel`
 * populated from `provider`, computed against `context.ip` (see file
 * header for why this is per-request rather than only per-login). Never
 * mutates `subject`. Always overwrites any pre-set `riskLevel` — same
 * "provider's real signal wins, never merges" posture
 * `withVerificationLevel()` (9B) already established.
 */
export async function withRiskLevel(
  subject: Subject,
  context: PolicyContext,
  provider: RiskLevelProvider,
): Promise<Subject> {
  const signal = await provider.getRiskSignal(subject.userId, context.ip);
  return { ...subject, riskLevel: mapRiskSignalToLevel(signal) };
}
