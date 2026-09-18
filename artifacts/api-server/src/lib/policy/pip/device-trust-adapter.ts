/**
 * lib/policy/pip/device-trust-adapter.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * `PolicyContext.deviceTrust` (../types.ts) has existed since Phase 05
 * (ABAC), left "for a future Phase 09/10 concern to populate from a real
 * device-fingerprint/login-security signal." AYZEN has no device-
 * fingerprinting feature and no dedicated devices table — but
 * `user_sessions` (`lib/sessions.ts`) already durably records the
 * `user_agent` string of every login, across every session a user has ever
 * opened. This module's one real signal: has THIS user ever opened a
 * session with THIS exact `user_agent` string before. That is a genuine,
 * already-durable fact this codebase can answer today — not a new kind of
 * telemetry (same restraint risk-level-adapter.ts's own header documents
 * for reusing `isAnomalousIp()`/`login_history` instead of inventing a new
 * signal).
 *
 * ── Only ever "trusted" or "unknown" — never "untrusted" ──────────────────
 * `PolicyContext.deviceTrust`'s own doc comment names three example values
 * ("trusted" / "unknown" / "untrusted"). This module only ever produces the
 * first two. There is no data source anywhere in this codebase for a
 * genuine NEGATIVE device signal (a known-bad/blocklisted device,
 * jailbreak/root detection, EDR posture, etc.) — inventing one here would
 * be exactly the "convert mock functionality into production functionality
 * without real backend support" the roadmap's Rule 18 forbids. A brand-new
 * device is `"unknown"` (the weaker, non-committal reading — same posture
 * `risk-level-adapter.ts` takes for "no IP to check" → not-anomalous rather
 * than guessing), never downgraded to a fabricated `"untrusted"`.
 *
 * Same DB-free-interface / separate-real-provider split every other pair in
 * this directory establishes — the real, `user_sessions`-backed
 * implementation lives in `drizzle-device-trust-provider.ts`.
 *
 * Not wired into any route yet — same additive, unwired posture every PIP
 * enrichment step in this engine ships with (Phase 19/PEP's concern).
 */

import type { PolicyContext } from "../types";

/** The one fact this module needs about a (user, user-agent) pair. */
export interface DeviceSignal {
  /** `true` iff this exact `user_agent` string appears on at least one of
   *  this user's OTHER session rows (see `drizzle-device-trust-provider.ts`
   *  for the exact query and its caveats). */
  seenBefore: boolean;
}

/** Reads one user's current `DeviceSignal` for a given User-Agent string —
 *  implemented for real by `DrizzleDeviceTrustProvider`
 *  (drizzle-device-trust-provider.ts); a test fixture can implement this
 *  trivially without any DB. */
export interface DeviceTrustProvider {
  getDeviceSignal(userId: number, userAgent: string): Promise<DeviceSignal>;
}

/** The two values this module ever produces (see file header for why a
 *  third, "untrusted", is deliberately never returned here). */
export type DeviceTrustLabel = "trusted" | "unknown";

/** Pure mapping: `DeviceSignal` → one of `DeviceTrustLabel`'s two values.
 *  Deterministic, never throws. */
export function mapDeviceSignalToTrust(signal: DeviceSignal): DeviceTrustLabel {
  return signal.seenBefore ? "trusted" : "unknown";
}

/**
 * Returns a NEW `PolicyContext` — identical to `context`, with
 * `deviceTrust` populated from `provider`, computed against `userAgent`.
 * Never mutates `context`.
 *
 * No-ops (returns `context` unchanged) when `userAgent` is missing/blank —
 * same "leave the field unset rather than guess" posture
 * `withSessionAge()` (session-context-adapter.ts) already establishes for
 * a missing `sessionId`. `userAgent` is an explicit parameter, not read off
 * `PolicyContext` itself — unlike `ip`/`sessionId`, no `PolicyContext`
 * field carries it (see pip/context-adapter.ts, which never captured it —
 * out of scope for that adapter's original Phase 1B purpose), so a caller
 * with access to the raw request (a future PEP layer) passes it through
 * explicitly, the same way `withRiskLevel()` already receives `context.ip`
 * only because `PolicyContext` happens to already carry that one.
 */
export async function withDeviceTrust(
  context: PolicyContext,
  userId: number,
  userAgent: string | undefined,
  provider: DeviceTrustProvider,
): Promise<PolicyContext> {
  if (!userAgent || userAgent.trim().length === 0) return context;
  const signal = await provider.getDeviceSignal(userId, userAgent);
  return { ...context, deviceTrust: mapDeviceSignalToTrust(signal) };
}
