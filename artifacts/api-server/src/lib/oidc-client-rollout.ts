/**
 * lib/oidc-client-rollout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5c-a/5c-b: Rollout Flag Storage (data-access
 * half) + "keep the old cookie path intact".
 *
 * Read/write layer over `oidc_client_rollout_flags` (migration 083). Two
 * callers, one helper each:
 *   - `routes/oidc-rollout-flag.ts` (5c-a's public GET) calls
 *     `getOidcRolloutFlag()` only — it never writes.
 *   - `routes/admin-oidc-rollout.ts` (5c-c/5c-e/5d-b/5e-d's admin PATCH) and
 *     `scripts/src/set-oidc-rollout-flag.ts` (the identical CLI path) both
 *     call `setOidcRolloutFlag()` — the two ways an operator can flip the
 *     same underlying row, per that script's own file header.
 *
 * FAIL-SAFE, NOT FAIL-OPEN (5c-b: "keep the old cookie path intact")
 * `getOidcRolloutFlag()` resolves to `false` on ANY read failure — no row,
 * a `false` row, a connection error, a query timeout, all collapse to the
 * same answer. This is what makes 5c-b true by construction: a DB hiccup
 * degrades Sylo back to the old credential-form path
 * (`sylo-oidc-rollout-flag.ts`'s frontend read takes the identical
 * direction on ITS failure paths — network error, timeout, malformed
 * body — so a failure anywhere in the chain, frontend or backend, lands on
 * the same side).
 *
 * CACHED, SHORT TTL — same reasoning `sylo-oidc-rollout-flag.ts`'s own
 * header gives for its frontend cache: this is a live, operator-flippable
 * decision (5c-c/5c-e/5d-b/5e-d), not a static document, so the cache here
 * is short — `CACHE_TTL_MS` below is the exact value that file's own
 * comment promises ("matches the backend's own CACHE_TTL_MS") — rather
 * than "for the process lifetime". A write (`setOidcRolloutFlag()`)
 * invalidates this process's own cache entry immediately, so an operator
 * flipping the flag through THIS process's admin endpoint sees it take
 * effect on the very next read from this process; other processes (a
 * multi-instance deploy) still catch up within `CACHE_TTL_MS`, the same
 * bound the frontend's own tabs are already subject to.
 *
 * SCOPE DISCIPLINE (this is 5c-a/5c-b, not 5c-c/5c-d/5c-e or 5d/5e)
 *   - No route wiring — that's routes/oidc-rollout-flag.ts and
 *     routes/admin-oidc-rollout.ts.
 *   - No comparison/error-rate monitoring — that's
 *     lib/oidc-login-attempts.ts (5c-d/5e).
 *   - No safety-model enforcement ("refuse non-sylo without an explicit
 *     override") — that is each CALLER's job
 *     (set-oidc-rollout-flag.ts's `main()`, admin-oidc-rollout.ts's PATCH
 *     handler), same split that file's own header describes for why ITS
 *     safety check lives in `main()` and not in a shared DB helper: this
 *     module has no opinion on which `app_id` values are "expected" this
 *     phase, only on how to read/write whichever one it's given.
 */
import { eq } from "drizzle-orm";
import { db, oidcClientRolloutFlagsTable } from "@workspace/db";
import { logger } from "./logger";

/** Matches `sylo-oidc-rollout-flag.ts`'s `ROLLOUT_FLAG_CACHE_TTL_MS` exactly — see file header. */
export const CACHE_TTL_MS = 15_000;

interface CachedFlag { value: boolean; at: number }
const flagCache = new Map<string, CachedFlag>();

function normalizeAppId(appId: string): string {
  return appId.trim().toLowerCase();
}

/**
 * 5c-a: resolves whether OIDC login is currently enabled for `appId`.
 * Never throws — a DB error is logged and resolved to `false`, per the
 * file header's fail-safe reasoning. Cached per-app-id for `CACHE_TTL_MS`
 * so a rollout flag read on the hot path (every unauthenticated hit on an
 * in-scope subdomain, via `routes/oidc-rollout-flag.ts`) doesn't cost a DB
 * round trip per request.
 */
export async function getOidcRolloutFlag(appId: string): Promise<boolean> {
  const normalized = normalizeAppId(appId);

  const cached = flagCache.get(normalized);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let enabled = false;
  try {
    const [row] = await db
      .select()
      .from(oidcClientRolloutFlagsTable)
      .where(eq(oidcClientRolloutFlagsTable.appId, normalized));
    enabled = row?.oidcEnabled ?? false;
  } catch (err) {
    logger.warn({ appId: normalized, err }, "oidc.rollout_flag.read_failed");
    enabled = false;
  }

  flagCache.set(normalized, { value: enabled, at: Date.now() });
  return enabled;
}

/**
 * 5c-c/5c-e/5d-b/5e-d: writes the flag for `appId`, upserting the row if
 * none exists yet (mirrors `set-oidc-rollout-flag.ts`'s own
 * insert-or-update logic exactly, since both are the same underlying
 * operation reached two ways — see that script's own header). Invalidates
 * this process's cache entry for `appId` before returning so the very next
 * `getOidcRolloutFlag()` call in this process reflects the write
 * immediately rather than waiting out `CACHE_TTL_MS`.
 */
export async function setOidcRolloutFlag(appId: string, enabled: boolean): Promise<void> {
  const normalized = normalizeAppId(appId);

  const [existing] = await db
    .select()
    .from(oidcClientRolloutFlagsTable)
    .where(eq(oidcClientRolloutFlagsTable.appId, normalized));

  if (existing) {
    await db
      .update(oidcClientRolloutFlagsTable)
      .set({ oidcEnabled: enabled, updatedAt: new Date() })
      .where(eq(oidcClientRolloutFlagsTable.appId, normalized));
  } else {
    await db
      .insert(oidcClientRolloutFlagsTable)
      .values({ appId: normalized, oidcEnabled: enabled })
      .onConflictDoNothing();
  }

  flagCache.delete(normalized);
  logger.info({ appId: normalized, oidcEnabled: enabled }, "oidc.rollout_flag.updated");
}

/** Test-only escape hatch — clears the module cache. Never called from production code. */
export function __resetOidcRolloutFlagCacheForTests(): void {
  flagCache.clear();
}
