/**
 * lib/oidc-cutover-gate.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5d-c: Disable Old Login Path (Sylo only).
 *
 * "Disable only for Sylo" (roadmap 5d-c) is not a second flag — it is the
 * SAME rollout flag 5c-a already built (`lib/oidc-client-rollout.ts`'s
 * `getOidcRolloutFlag()`), read from the one place the old path is
 * actually reachable: `routes/auth.ts`'s `POST /auth/login`. Cutover
 * (5d-b, "make OIDC the active Sylo login path") and disabling the old
 * path (5d-c) are therefore one and the same flip for Sylo — flipping
 * `oidc_client_rollout_flags.sylo.oidc_enabled` to `true` simultaneously
 * (a) makes `App.tsx`'s `ProtectedRoute` start the OIDC redirect instead
 * of showing the credential form (5b-a, already true since 5b) and (b)
 * makes THIS gate reject a direct `POST /auth/login` call that reached
 * the API without ever going through that redirect — closing the one
 * bypass a stale bookmark, a cached page, or a non-browser client hitting
 * the endpoint directly would otherwise have. Rollback (5c-e/5e-d) is the
 * same flip in reverse, on the same flag, with no separate "re-enable
 * legacy" step to forget.
 *
 * SAFETY MODEL — same "Sylo only" boundary as every other 5c/5d file
 * `set-oidc-rollout-flag.ts` and `routes/admin-oidc-rollout.ts` each
 * duplicate this exact boundary rather than share a module (see either
 * file's own header for why) — this is the third, read-side copy, for
 * the identical reason: small enough that duplicating one `Set.has()`
 * check is lower risk than a shared module three very different call
 * sites (a CLI script, an Express admin route, an Express auth route)
 * all have to agree to import correctly. If a rollout-flag row somehow
 * existed for a non-Sylo `app_id` (the write-side guard means it
 * shouldn't, but this function does not trust that), the legacy path is
 * still never blocked for it — 5d's own scope, per the roadmap's Season 3
 * goal, is "migrate the first real client, Sylo," not every app.
 *
 * WHY A SEPARATE PURE FUNCTION, NOT INLINE IN routes/auth.ts's HANDLER
 * Same "inject the effectful boundary, unit-test the decision table"
 * discipline every `test-*.ts` file in this roadmap already follows (see
 * `test-oidc-rollout-flag.ts`'s own header) — `evaluateLegacyLoginGate()`
 * below is the one piece of 5d-c's logic with a real decision table
 * (blocked / not-blocked × app_id resolved / unresolved × Sylo /
 * non-Sylo × flag on / off) worth testing without a live DB, a live
 * Express request, or a live cache.
 */

/** 5d's own scope boundary — see file header. Season 3 migrates Sylo only; a future season adding Ryft/Wisp/Verve/Zynth extends this set as part of ITS OWN cutover phase, not by editing 5d-c's logic. */
const CUTOVER_SCOPED_APP_IDS = new Set(["sylo"]);

export type LegacyLoginGateCode = "OIDC_REQUIRED";

export interface LegacyLoginGateResult {
  blocked: boolean;
  /** Only set when `blocked` is true — the machine-readable reason a caller (the API response, a log line) can key off. */
  code?: LegacyLoginGateCode;
}

/**
 * 5d-c: given the `app_id` `resolveLegacyLoginAppId()` (5c-d,
 * `lib/oidc-login-attempts.ts`) resolved for this `POST /auth/login`
 * request — `null` when the request's `Origin`/`Referer` didn't
 * identify a currently-migrated app — and whether OIDC is currently
 * enabled for that app (`getOidcRolloutFlag()`, 5c-a), decides whether
 * the legacy credential-form login should be rejected in favor of OIDC.
 *
 * `appId: null` never blocks — same "don't touch what you can't
 * attribute" discipline `resolveLegacyLoginAppId()`'s own header
 * describes for its `null` return: a request this gate can't confidently
 * attribute to Sylo (a non-browser client with no Origin/Referer, an
 * unrelated app, a dev tool) must not have its login rejected on a
 * guess.
 */
export function evaluateLegacyLoginGate(appId: string | null, oidcEnabledForApp: boolean): LegacyLoginGateResult {
  if (!appId) return { blocked: false };
  if (!CUTOVER_SCOPED_APP_IDS.has(appId)) return { blocked: false };
  if (!oidcEnabledForApp) return { blocked: false };
  return { blocked: true, code: "OIDC_REQUIRED" };
}
