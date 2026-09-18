/**
 * lib/policy/rbac/permission-matcher.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 02 (RBAC).
 *
 * The AUTHORITATIVE implementation of the roadmap's permission-naming rule
 * ("product.resource.action", e.g. "sylo.vault.read") and its "carefully
 * constrained wildcards" requirement. `lib/db/src/schema/rbac.ts` has its
 * own shallow, duplicated shape check at the data-entry boundary (see that
 * file's header for why it can't just import this module), but THIS file —
 * consulted at every real authorization decision, not just at insert time —
 * is what actually decides whether a stored grant covers a requested
 * permission. Pure functions, no DB, no Express — same discipline
 * Phase 1A/1B/1C already established for the rest of lib/policy/*.
 *
 * ── Concrete permission keys ────────────────────────────────────────────
 * Exactly three dot-separated segments, each `[a-z0-9_-]+`:
 * "product.resource.action" — e.g. "sylo.vault.read". This is what a
 * `PolicyRule` receives as `AuthorizationRequest.action` once a caller
 * opts into the RBAC convention (Phase 01 left `action` an opaque string
 * precisely so Phase 02 could give it real structure without another
 * change to the engine).
 *
 * ── Grant patterns ───────────────────────────────────────────────────────
 * What a `role_permissions` row / seed data actually stores. Either:
 *   - a concrete permission key (matches exactly one action), or
 *   - a pattern whose FINAL segment is `*`:
 *       "sylo.vault.*"  → every action on sylo's vault resource
 *       "sylo.*"        → every resource/action under sylo
 *       "*"             → everything (the single-segment global wildcard)
 * A `*` anywhere except the last segment ("*.vault.read", "sylo.*.read")
 * is REJECTED by `isValidGrantPattern` and therefore never matches
 * anything via `permissionMatches` either, even if such a string somehow
 * ended up in storage — this function fails closed on malformed input by
 * design (roadmap's Phase 02 "invalid wildcard" test exists precisely to
 * pin this behavior down), it does not throw and does not treat a
 * malformed pattern as "matches everything".
 */

const SEGMENT_RE = /^[a-z0-9_-]+$/;

/** True for a concrete, fully-specified "product.resource.action" key —
 *  exactly 3 segments, no wildcards. This is the shape a real
 *  `AuthorizationRequest.action` must have for the RBAC rule to reason
 *  about it at all (see rbac-rule.ts). */
export function isValidPermissionKey(value: string): boolean {
  if (typeof value !== "string") return false;
  const segments = value.split(".");
  if (segments.length !== 3) return false;
  return segments.every((s) => SEGMENT_RE.test(s));
}

/**
 * True for a well-formed GRANT pattern: a valid concrete permission key,
 * OR 1-3 segments where the LAST segment is exactly "*" and every other
 * segment matches SEGMENT_RE. Rejects a wildcard in any non-final
 * position, an empty string, and anything with more than 3 segments.
 */
export function isValidGrantPattern(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value === "*") return true; // global wildcard: single segment, always valid
  const segments = value.split(".");
  if (segments.length === 0 || segments.length > 3) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    if (seg === "*") {
      if (!isLast) return false; // wildcard must be the trailing segment
      continue;
    }
    if (!SEGMENT_RE.test(seg)) return false;
  }
  // A pattern with no wildcard at all must be a complete 3-segment key —
  // "sylo.vault" (2 segments, no trailing "*") is not a valid grant: it is
  // neither a concrete permission nor an explicit wildcard, so treating it
  // as "matches sylo.vault.*" would silently widen a typo/omission into a
  // wildcard grant. Require the author to write the "*" explicitly.
  if (!segments.includes("*") && segments.length !== 3) return false;
  return true;
}

/**
 * Does `pattern` (a stored grant — validated with `isValidGrantPattern`
 * below before it is trusted) cover `required` (a concrete permission key
 * an `AuthorizationRequest.action` carries)?
 *
 * Fails closed: an invalid `pattern` or a non-concrete `required` always
 * returns false, never throws.
 */
export function permissionMatches(pattern: string, required: string): boolean {
  if (!isValidPermissionKey(required)) return false;
  if (!isValidGrantPattern(pattern)) return false;

  if (pattern === "*") return true;

  const patternSegments = pattern.split(".");
  const requiredSegments = required.split(".");

  for (let i = 0; i < patternSegments.length; i++) {
    const p = patternSegments[i];
    if (p === "*") {
      // Trailing wildcard (guaranteed last by isValidGrantPattern) — matches
      // this segment and everything after it in `required`.
      return true;
    }
    if (p !== requiredSegments[i]) return false;
  }

  // Every pattern segment matched positionally with no wildcard reached —
  // this is only a full match if the pattern was itself the complete
  // 3-segment key (isValidGrantPattern already guarantees a wildcard-free
  // pattern has exactly 3 segments, so this is always true here, but the
  // explicit length check keeps this function correct even if that
  // invariant ever changes).
  return patternSegments.length === requiredSegments.length;
}
