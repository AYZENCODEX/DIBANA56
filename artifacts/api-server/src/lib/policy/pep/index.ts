/**
 * lib/policy/pep/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 19 (PEP / Express SDK) +
 * Phase 20 (Batch Authorization).
 *
 * Barrel for everything under `lib/policy/pep/*`. Unlike several earlier
 * phases' own barrels, there is no Drizzle provider to exclude here — this
 * whole directory is Express-request-shaping + in-memory rule composition,
 * never a direct `@workspace/db` import (any real DB-backed provider a
 * caller wires in — `RbacProvider`, `ApprovalRequestProvider`, etc. — is
 * supplied BY the caller to `requirePermission()`/`requireApproval()`,
 * never constructed inside this directory).
 *
 * Phase 20's `authorizeMany()`/`allowedKeys()` (./authorize-many.ts) live
 * in this same directory, not a separate top-level barrel — see that
 * file's own header for why batch authorization is a PEP concern (it
 * takes an Express `Request`, same as `authorize()`) rather than a new PDP
 * capability.
 */

export * from "./types";
export * from "./authorize";
export * from "./authorize-many";
export * from "./enforce";
export * from "./middleware";
