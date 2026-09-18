/**
 * lib/policy/pip/types.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The roadmap's own Phase 18 section names seven provider interfaces by
 * these exact seven names:
 *   SubjectProvider, ResourceProvider, OrganizationProvider, SessionProvider,
 *   RiskProvider, DeviceProvider, RelationshipProvider
 *
 * Six of those seven concepts already existed in this engine under other
 * names, built incrementally as each concern's own earlier phase needed
 * them:
 *   - RiskProvider        ← RiskLevelProvider        (pip/risk-level-adapter.ts, Phase 10B)
 *   - RelationshipProvider ← RelationshipProvider     (rebac/types.ts, Phase 04 — same name already)
 *   - SessionProvider     ← SessionContextProvider    (pip/session-context-adapter.ts, this phase)
 *   - DeviceProvider      ← DeviceTrustProvider       (pip/device-trust-adapter.ts, this phase)
 *   - ResourceProvider    ← ResourceAttributeProvider (pip/resource-attribute-provider.ts, this phase)
 *   - OrganizationProvider — already named exactly this (pip/organization-provider.ts, this phase)
 * `SubjectProvider` is the one genuinely NEW interface this phase adds (see
 * below) — every other Subject-shaping piece
 * (subject-adapter.ts/verification-level-adapter.ts/account-state-adapter.ts)
 * already existed as its own narrower step; `SubjectProvider` is the name
 * for the composition of those steps, real for the first time via
 * `DrizzleSubjectProvider` (drizzle-subject-provider.ts).
 *
 * This file's job is NOT to rebuild any of the above (Rule 1: do not
 * rewrite from scratch) — it gives the roadmap's own vocabulary one
 * authoritative home, as TYPE ALIASES (not new/parallel interfaces), so a
 * future PEP layer (Phase 19) or a new engineer can find "SubjectProvider"/
 * "RiskProvider"/etc. by that exact name instead of first having to learn
 * which earlier phase built the equivalent thing under a different one.
 * Because TypeScript interfaces are structural, an existing
 * `RiskLevelProvider` implementation already satisfies `RiskProvider`
 * without any change on that side.
 *
 * `RelationshipProvider` is deliberately NOT re-aliased here: it already
 * carries this exact name in `../rebac/types.ts`, and re-declaring a
 * second, separate `export type RelationshipProvider = ...` here would
 * make `lib/policy/index.ts`'s two `export *` barrels (`./rebac` and
 * `./pip/types`) ambiguous for that name. Import it from `../rebac/types`
 * (or from the top-level `lib/policy` barrel, where `./rebac`'s own export
 * already makes it available) instead.
 */

import type { RiskLevelProvider } from "./risk-level-adapter";
import type { SessionContextProvider } from "./session-context-adapter";
import type { DeviceTrustProvider } from "./device-trust-adapter";
import type { ResourceAttributeProvider } from "./resource-attribute-provider";
import type { AuthenticatedUserLike } from "./subject-adapter";
import type { Subject } from "../types";

/** Alias — see this file's header. Real implementation: `LoginSecurityRiskProvider`
 *  (login-security-risk-provider.ts, Phase 10B). */
export type RiskProvider = RiskLevelProvider;

/** Alias — see this file's header. Real implementation:
 *  `DrizzleSessionContextProvider` (drizzle-session-context-provider.ts). */
export type SessionProvider = SessionContextProvider;

/** Alias — see this file's header. Real implementation:
 *  `DrizzleDeviceTrustProvider` (drizzle-device-trust-provider.ts). */
export type DeviceProvider = DeviceTrustProvider;

/** Alias — see this file's header. No real implementation ships this phase
 *  — see resource-attribute-provider.ts's own header for why. */
export type ResourceProvider = ResourceAttributeProvider;

/**
 * The one genuinely new interface this phase adds: everything needed to
 * turn an already-authenticated identity (`req.user`-shaped) into a fully
 * account-attributed `Subject` — composing `subjectFromAuthUser()` (Phase
 * 1B, identity reshape) with every account-level attribute this codebase
 * has a REAL backing column for today (`verificationLevel` via
 * `users.emailVerified`/`kycVerified`/`kycLevel`, Phase 9B; `accountState`
 * via `users.status`, this phase).
 *
 * Deliberately does NOT populate `riskLevel`: risk needs `context.ip` (a
 * request-scoped fact, not a pure account attribute) — see
 * `PolicyInformationPoint.resolveSubject()` (policy-information-point.ts)
 * for where `RiskProvider` is composed in afterward, once a `PolicyContext`
 * exists. This mirrors the roadmap's own choice to list `RiskProvider`
 * separately from `SubjectProvider` rather than folding one into the
 * other.
 *
 * `null`/`undefined` in (unauthenticated) → `null` out, always — same
 * contract `subjectFromAuthUser()` itself already establishes.
 */
export interface SubjectProvider {
  getSubject(user: AuthenticatedUserLike | null | undefined): Promise<Subject | null>;
}
