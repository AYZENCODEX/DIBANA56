/**
 * lib/policy/policy-context.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 1A.
 *
 * `createPolicyContext()` is the one place a `PolicyContext.requestId` gets
 * generated, so every caller gets the same correlation-ID behavior for free
 * instead of re-implementing "generate a UUID if none was given" at every
 * call site.
 *
 * Phase 05 (ABAC) added three new optional environment fields to
 * `PolicyContext` (`deviceTrust`, `sessionAgeSeconds`,
 * `authenticationFreshnessSeconds` — see ../types.ts's doc comments). This
 * file's `CreatePolicyContextInput`/`createPolicyContext()` were updated in
 * lockstep so those fields can actually reach a built `PolicyContext` (and
 * therefore an ABAC condition's `environment.*` attributes) via the same
 * one construction path every other context field already uses — nothing
 * about `requestId` generation or any other pre-Phase-05 behavior changed.
 *
 * Deliberately NOT included in 1A: an Express-request adapter (something
 * like `policyContextFromReq(req)`). That belongs to the PEP layer, which is
 * out of scope until this engine is actually wired into routes — see the
 * "NOT part of Phase 1A" section of CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE1A.md.
 */

import { randomUUID } from "node:crypto";
import type { PolicyContext } from "./types";

export interface CreatePolicyContextInput {
  /** Supply your own correlation ID to propagate one that already exists
   *  (e.g. an upstream request-id header). Omit to have one generated. */
  requestId?: string;
  ip?: string;
  sessionId?: string;
  /** Phase 05 (ABAC) environment attributes — see ../types.ts's
   *  `PolicyContext` doc comments for what each means and who is expected
   *  to eventually populate them. All optional; omitting them here behaves
   *  exactly as it did before Phase 05 (the field is simply left
   *  `undefined` on the resulting `PolicyContext`, same as `ip`/`sessionId`
   *  already do when omitted). */
  deviceTrust?: string;
  sessionAgeSeconds?: number;
  authenticationFreshnessSeconds?: number;
  extra?: Readonly<Record<string, unknown>>;
}

export function createPolicyContext(input: CreatePolicyContextInput = {}): PolicyContext {
  return {
    requestId: input.requestId && input.requestId.length > 0 ? input.requestId : randomUUID(),
    timestamp: new Date(),
    ip: input.ip,
    sessionId: input.sessionId,
    deviceTrust: input.deviceTrust,
    sessionAgeSeconds: input.sessionAgeSeconds,
    authenticationFreshnessSeconds: input.authenticationFreshnessSeconds,
    extra: input.extra,
  };
}
