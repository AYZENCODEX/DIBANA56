/**
 * lib/policy/pip/policy-information-point.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The concrete answer to this phase's own roadmap framing: "PDP requests
 * context through providers instead of arbitrary DB queries." Given
 * whichever providers a caller constructs (every slot optional), this class
 * produces a fully-attributed `Subject`/`PolicyContext` without the PDP (or
 * a future PEP) needing to know which table backs which attribute, or in
 * which order the enrichment steps compose.
 *
 * ── Composition only — no query of its own ────────────────────────────────
 * This class contains zero DB access. Every actual read happens inside
 * whichever provider it was handed (or does not happen at all, if a given
 * slot is left `undefined` — the caller gets back exactly what it put in,
 * same as calling none of these adapters directly). This file itself stays
 * DB-free and unit-testable, same posture every DB-free adapter in this
 * directory already has — it is safe to include in `lib/policy/index.ts`'s
 * barrel (unlike every `drizzle-*` file in this directory).
 *
 * ── Why `resource`/`organization`/`relationship` are NOT provider slots here ─
 * Every existing rule that needs one of those three already receives its
 * own provider directly as a constructor argument, from the phase that
 * built it:
 *   - `createExplicitResourceGrantRule(resourceGrantProvider)`  (Phase 3B)
 *   - `createRebacRule(relationshipProvider, ...)`              (Phase 04)
 *   - `createSeparationOfDutiesRule(relationshipProvider)`      (Phase 13)
 * Routing those same providers through THIS facade too would be a second,
 * parallel way to hand the identical object to the identical rule — not a
 * simplification, and not what "instead of arbitrary DB queries" is asking
 * for (those call sites were never arbitrary DB queries to begin with; they
 * were already provider-mediated). `ResourceAttributeProvider` and
 * `OrganizationProvider` additionally have no real implementation to
 * compose at all yet (see each file's own header) — a facade slot for a
 * provider nothing implements would be dead surface area.
 *
 * Nothing in the app constructs a `PolicyInformationPoint` yet — same
 * additive, unwired posture every phase in this engine has shipped with.
 * Wiring one into an actual request path is Phase 19's (PEP) concern.
 */

import type { Subject, PolicyContext } from "../types";
import { subjectFromAuthUser, type AuthenticatedUserLike } from "./subject-adapter";
import { withRiskLevel } from "./risk-level-adapter";
import { withSessionAge } from "./session-context-adapter";
import { withDeviceTrust } from "./device-trust-adapter";
import type { SubjectProvider, RiskProvider, SessionProvider, DeviceProvider } from "./types";

/** Every slot optional — a `PolicyInformationPoint` constructed with none
 *  of them behaves identically to calling `subjectFromAuthUser()` directly
 *  and leaving `context` untouched (see `resolveSubject()`/
 *  `resolveContext()`'s own fallback behavior below), so this class is
 *  always safe to construct, including in a test with zero providers. */
export interface PolicyInformationPointProviders {
  subject?: SubjectProvider;
  risk?: RiskProvider;
  session?: SessionProvider;
  device?: DeviceProvider;
}

export class PolicyInformationPoint {
  constructor(private readonly providers: PolicyInformationPointProviders = {}) {}

  /**
   * WHO, fully attributed: identity reshape (via `providers.subject`, if
   * supplied — otherwise the DB-free `subjectFromAuthUser()` fallback) →
   * `riskLevel` (via `providers.risk`, if supplied — evaluated against
   * `context.ip`, so this step runs only once a `PolicyContext` already
   * exists). `null` in (unauthenticated) → `null` out, always, same
   * contract every layer here already establishes.
   */
  async resolveSubject(
    user: AuthenticatedUserLike | null | undefined,
    context: PolicyContext,
  ): Promise<Subject | null> {
    let subject: Subject | null = this.providers.subject
      ? await this.providers.subject.getSubject(user)
      : subjectFromAuthUser(user);

    if (!subject) return null;

    if (this.providers.risk) {
      subject = await withRiskLevel(subject, context, this.providers.risk);
    }

    return subject;
  }

  /**
   * Ambient request context, enriched: `sessionAgeSeconds` (via
   * `providers.session`) and `deviceTrust` (via `providers.device`, only
   * when `opts.userId`/`opts.userAgent` are both supplied — see
   * `withDeviceTrust()`'s own no-op guard for a missing/blank
   * `userAgent`). Either or both providers may be omitted; omitted steps
   * leave `context` exactly as given, same as calling neither adapter.
   */
  async resolveContext(
    context: PolicyContext,
    opts: { userId?: number; userAgent?: string } = {},
  ): Promise<PolicyContext> {
    let resolved = context;

    if (this.providers.session) {
      resolved = await withSessionAge(resolved, this.providers.session);
    }

    if (this.providers.device && opts.userId !== undefined) {
      resolved = await withDeviceTrust(resolved, opts.userId, opts.userAgent, this.providers.device);
    }

    return resolved;
  }
}
