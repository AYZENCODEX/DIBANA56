/**
 * middlewares/auth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/api-server/src/middlewares/auth.ts
 *
 * SECURITY FIXES applied:
 *  1. getRequestUser() — removed the fallback that parsed an unverified base64
 *     token and blindly trusted the role field inside it. An attacker could
 *     craft  btoa('{"userId":1,"role":"admin"}')  and bypass role checks on
 *     any route that called getRequestUser() without requireAuth middleware.
 *     Now it ONLY returns req.user (set by a middleware after a DB lookup).
 *
 *  2. getRequestUserId() — same fix; returns null instead of a forged userId.
 *
 * ROUTE INTEGRATION ROADMAP — SEASON A, PHASE A2 (RBAC-PEP shim):
 * `requireAdmin`/`requireDev`/`requireRoles()` used to compare `user.role`
 * against a fixed list by hand, inline, with their own ad hoc 403 body — no
 * `Decision`, no reason code, invisible to the Policy & Authorization Mega
 * Engine's PDP/telemetry entirely. Their role check now runs through that
 * same PDP via `lib/policy/pep/middleware.ts`'s `requireRole()` (Phase 19),
 * which produces a real `AuthorizationDecision` (`req.authorization`,
 * `EXPLICIT_ALLOW`/`EXPLICIT_DENY`, a `requestId`) the exact same way any
 * other PEP-gated route already does.
 *
 * This is a regression-only phase — every one of these functions' EXTERNAL
 * behavior (status code, `error`/`code`/`solution` body) is byte-for-byte
 * unchanged; a caller checking `response.code === "NOT_ADMIN"` today keeps
 * working tomorrow without touching a single line. `requireRole()`'s own
 * default DENY rendering is NOT used here — each function below passes its
 * own `onDeny` to `requireRole()` so the response shape stays exactly what
 * it already was, and only the DECISION-MAKING underneath moves to the PDP.
 * `requireAuth`/`requireSessionAuth` are deliberately NOT touched in this
 * phase — neither makes a role/RBAC decision (the former just authenticates,
 * the latter checks `authType`, not `role`), so there is no RBAC check here
 * for the PDP to take over. See `CHANGES_ROUTE_INTEGRATION_PHASE_A2.md`.
 *
 * ROUTE INTEGRATION ROADMAP — SEASON A, PHASE A3 (Telemetry hookup):
 * Phase A2's `requireRole()` engines produced real `AuthorizationDecision`s,
 * but nothing observed them — no metric, no durable audit row. This phase
 * attaches one `pepDecisionObserver` (built once, near the RBAC-PEP shim
 * below) to all three role checks below via the new `onDecision` seam
 * `lib/policy/pep/types.ts` now exposes: it feeds
 * `routes/authorization-telemetry.ts`'s metrics/access-pattern dashboards
 * AND persists an `authorization_audit_log` row per decision. Purely
 * additive — `onDeny` (hence every external response shape) is untouched.
 * See `pepDecisionObserver`'s own comment below, and
 * `CHANGES_ROUTE_INTEGRATION_PHASE_A3.md`.
 *
 * HOW AUTH WORKS IN AYZEN (reminder):
 *  requireAuth / requireAdmin / requireDev / requireRoles
 *    → call getUserFromToken() [auth-utils.ts]
 *    → verifies JWT or legacy base64 token + re-reads role from DB
 *    → sets req.user = { userId, role }
 *  Route handlers then call getRequestUser(req) or req.user directly.
 *  Nothing in a route handler should ever parse the raw token itself.
 */

import type { Request, Response, NextFunction } from "express";
import { getTokenFromReq, getUserFromToken } from "../lib/auth-utils";
import { requireRole as pepRequireRole } from "../lib/policy/pep/middleware";
import { composeObservers, authorizationObserver } from "../lib/policy/observability";
import { createAuthorizationAuditObserver } from "../lib/policy/audit";
import { DrizzleAuthorizationAuditWriter } from "../lib/policy/audit/drizzle-audit-writer";
import { DrizzleRbacProvider } from "../lib/policy/rbac/drizzle-rbac-provider";
import type { RbacProvider } from "../lib/policy/rbac/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  userId: number;
  role: string;
  /**
   * How this request was authenticated. "apikey" = AYZEN developer API key.
   * "oidc" = a bearer access token issued by this codebase's own OIDC
   * provider (lib/oidc-access-token.ts) — added in the Route Integration
   * Roadmap's Season A / Phase A1 so `requireAuth`/`requireRoles`/etc. work
   * unchanged for a caller presenting an OIDC token instead of a session
   * JWT or API key; see lib/auth-utils.ts's `getUserFromToken()` for the
   * verification + revocation-check details.
   */
  authType?: "session" | "apikey" | "legacy" | "oidc";
  /** Only set when authType === "apikey". "full" = no restriction. "scoped" = limited to `scopes`. */
  keyType?: "full" | "scoped";
  /**
   * Only meaningful when keyType === "scoped" (API key scopes, lib/api-scopes.ts)
   * OR when authType === "oidc" (the OAuth scopes the token's authorization
   * code was granted, e.g. "profile"/"email" — lib/oidc-scope-validation.ts).
   * These are two different scope vocabularies that happen to share this
   * field's shape; a caller must check `authType`/`keyType` first to know
   * which one it's reading.
   */
  scopes?: string[];
  /** Only set when authType === "oidc" — the client (`aud`) this token was minted for. */
  oidcClientId?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getTokenFromReq(req);
  if (!token) {
    res.status(401).json({
      error: "Unauthorized",
      code: "NO_TOKEN",
      solution: "Include a valid Authorization: Bearer <token> header.",
    });
    return;
  }
  const user = await getUserFromToken(token);
  if (!user) {
    res.status(401).json({
      error: "Unauthorized",
      code: "INVALID_TOKEN",
      solution: "Token is invalid or expired. Please log in again.",
    });
    return;
  }
  req.user = user;
  next();
}

/**
 * Like requireAuth, but rejects requests authenticated via an AYZEN API key.
 * Use this on the API-key management routes themselves (create/rotate/revoke)
 * so a leaked key can never be used to mint itself more keys or lock the
 * real owner out — managing keys always requires a real login session.
 */
export async function requireSessionAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getTokenFromReq(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN", solution: "Include a valid Authorization: Bearer <token> header." });
    return;
  }
  const user = await getUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN", solution: "Token is invalid or expired. Please log in again." });
    return;
  }
  if (user.authType === "apikey") {
    res.status(403).json({
      error: "Forbidden",
      code: "SESSION_REQUIRED",
      solution: "This action requires a real login session, not an API key. Log in via the app to manage your API keys.",
    });
    return;
  }
  req.user = user;
  next();
}

// ─── Telemetry hookup (Phase A3) ─────────────────────────────────────────────
// Route Integration Roadmap — Season A, Phase A3: this is the one real call
// site (per `lib/policy/audit/index.ts`'s own header — "import
// ./audit/drizzle-audit-writer directly at the one real call site that
// actually constructs it") that wires a `PolicyEngine`'s `onDecision` hook
// to anything at all in this app. Built once, at module load — same
// "cheap, stateless, build it once" posture `adminRoleCheck`/`devRoleCheck`
// below already apply to their own engines.
//
// `composeObservers()` (Phase 24) fans this one decision out to two places:
//   - `authorizationObserver` (Phase 24, DB-free, in-memory) — feeds the
//     SAME `metricsRegistry`/`accessPatternRegistry` singletons
//     `routes/authorization-telemetry.ts` already reads. Before this
//     phase, nothing in the app ever fed them, so that route's dashboards
//     rendered honest-but-permanent zeroes; the RBAC-PEP shim's role
//     checks (Phase A2) are now real, observed traffic.
//   - `createAuthorizationAuditObserver(new DrizzleAuthorizationAuditWriter())`
//     (Phase 17) — persists one `authorization_audit_log` row per decision.
//     This is deliberately NOT constructed inside `lib/policy/pep/*` (that
//     directory's own documented invariant is "never a direct
//     `@workspace/db` import" — see `lib/policy/pep/index.ts`'s header);
//     `requireRole()` only exposes the generic `onDecision` pass-through
//     seam (Phase A3, `lib/policy/pep/types.ts`), and this file — outside
//     `lib/policy/*` entirely — is what plugs a concrete, DB-backed
//     observer into it.
//
// Scope, honestly: this only covers `requireRole()`'s own throwaway engine
// — i.e. every route still gated by `requireAdmin`/`requireDev`/
// `requireRoles()` (the 106-route Phase A2 shim). `requirePermission()`/
// `requireOwnership()`/`requireStepUp()`/`requireApproval()` (`pep/
// middleware.ts`) support the exact same `onDecision` option now.
// Exported (not just module-local) as of Route Integration Roadmap —
// Season B, Phase B1: `routes/finance.ts` is the first route file to
// import this same observer instance and pass it into its own
// `requireOwnership()` calls, so Finance's new ownership decisions land in
// the exact same `authorization_audit_log` table / metrics/access-pattern
// registries as every RBAC-PEP-shim decision above — one observer, every
// PDP decision in the app, not a second parallel one per feature. See
// `CHANGES_ROUTE_INTEGRATION_PHASE_B1.md`.
//
// Route Integration Roadmap — Season B, Phase B3 (Admin consoles /
// dogfooding): this same instance is now ALSO passed into the new PEP
// checks `routes/admin-policy-console.ts`, `routes/admin-rbac-console.ts`,
// `routes/admin-resource-console.ts`, and `routes/authorization-telemetry.ts`
// add in front of their existing `requireDev` gate — see
// `getPepRbacProvider()` just below this const, and
// `CHANGES_ROUTE_INTEGRATION_PHASE_B3.md`.
export const pepDecisionObserver = composeObservers(
  authorizationObserver,
  createAuthorizationAuditObserver(new DrizzleAuthorizationAuditWriter()),
);

// ─── Shared RbacProvider for PEP-level permission checks (Phase B3) ────────
// Route Integration Roadmap — Season B, Phase B3 (Admin consoles /
// dogfooding): `routes/admin-policy-console.ts`, `routes/admin-rbac-console.ts`,
// `routes/admin-resource-console.ts`, and `routes/authorization-telemetry.ts`
// each need an `RbacProvider` to build a `requirePermission()`/
// `requirePolicy()`+`createAnyPermissionRule()` check. `DrizzleRbacProvider`
// (lib/policy/rbac/drizzle-rbac-provider.ts) is stateless — a thin wrapper
// over the shared `@workspace/db` client, no per-request state to isolate
// — so ONE lazily-constructed singleton here, reused by every PEP call site
// in this app, is the same "cheap to build, build it once" posture
// `adminRoleCheck`/`devRoleCheck` below already apply. This is deliberately
// a SEPARATE instance from the ones `lib/policy-admin-console.ts`/
// `lib/rbac-admin-console.ts`/`lib/resource-admin-console.ts` each already
// construct for their own internal `RbacPolicyAdminAuthorizer`/
// `RbacRbacAdminAuthorizer`/`RbacResourceAdminAuthorizer` checks (Rule: this
// file never reaches into another module's private singleton) — but the
// SAME underlying tables, so both layers always see identical grants.
let pepRbacProviderSingleton: RbacProvider | null = null;
export function getPepRbacProvider(): RbacProvider {
  if (!pepRbacProviderSingleton) pepRbacProviderSingleton = new DrizzleRbacProvider();
  return pepRbacProviderSingleton;
}

// ─── RBAC-PEP shim (Phase A2) ───────────────────────────────────────────────
// One `requireRole()`-built middleware per fixed role set, constructed ONCE
// at module load (not per-request — same "cheap to build, build it once"
// posture `requireRoles()` below applies at its own factory-call time) since
// `["admin"]` / `["dev", "admin"]` never change. Each supplies its own
// `onDeny` so the rendered body is exactly what this file always returned,
// not `requireRole()`'s generic default (see file header). `onDecision:
// pepDecisionObserver` (Phase A3, above) is new; `onDeny` is unchanged from
// Phase A2.

const adminRoleCheck = pepRequireRole(["admin"], {
  onDecision: pepDecisionObserver,
  onDeny: (_req, res) => {
    res.status(403).json({ error: "Forbidden", code: "NOT_ADMIN", solution: "This action requires admin privileges." });
  },
});

const devRoleCheck = pepRequireRole(["dev", "admin"], {
  onDecision: pepDecisionObserver,
  onDeny: (_req, res) => {
    res.status(403).json({ error: "Forbidden", code: "NOT_DEV", solution: "This action requires developer privileges." });
  },
});

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getTokenFromReq(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN", solution: "Include a valid Authorization: Bearer <token> header." });
    return;
  }
  const user = await getUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN", solution: "Token is invalid or expired. Please log in again." });
    return;
  }
  // req.user must be set BEFORE the PDP call — authorize() (lib/policy/pep/
  // authorize.ts) reads the Subject straight off req.user, the same way
  // every other PEP-gated route already expects it to be there.
  req.user = user;
  await adminRoleCheck(req, res, next);
}

export async function requireDev(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = getTokenFromReq(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN", solution: "Include a valid Authorization: Bearer <token> header." });
    return;
  }
  const user = await getUserFromToken(token);
  if (!user) {
    res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN", solution: "Token is invalid or expired. Please log in again." });
    return;
  }
  req.user = user;
  await devRoleCheck(req, res, next);
}

export function requireRoles(...roles: string[]) {
  // Built once per call to requireRoles(...) — i.e. once per route file's
  // module load, not once per request — same reasoning as adminRoleCheck/
  // devRoleCheck above.
  const roleCheck = pepRequireRole(roles, {
    onDecision: pepDecisionObserver,
    onDeny: (_req, res) => {
      res.status(403).json({
        error: "Forbidden",
        code: "NOT_ALLOWED",
        solution: `This action requires one of these roles: ${roles.join(", ")}.`,
      });
    },
  });
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = getTokenFromReq(req);
    if (!token) {
      res.status(401).json({ error: "Unauthorized", code: "NO_TOKEN", solution: "Include a valid Authorization: Bearer <token> header." });
      return;
    }
    const user = await getUserFromToken(token);
    if (!user) {
      res.status(401).json({ error: "Unauthorized", code: "INVALID_TOKEN", solution: "Token is invalid or expired. Please log in again." });
      return;
    }
    req.user = user;
    await roleCheck(req, res, next);
  };
}

// ─── Route-level helpers ──────────────────────────────────────────────────────

/**
 * Returns the authenticated user set by a middleware (requireAuth etc.).
 * Returns null if no middleware ran — does NOT fall back to parsing the raw
 * token, because doing so would trust an unverified, forgeable role field.
 *
 * Always use a requireAuth/requireAdmin/requireRoles middleware BEFORE calling
 * this in your route handler.
 */
export function getRequestUser(req: Request): AuthUser | null {
  // FIX: only trust req.user set by verified middleware — no raw token fallback
  return req.user ?? null;
}

/**
 * Returns the authenticated user's ID, or null if not authenticated.
 * Never returns a fallback ID — callers must handle null explicitly.
 */
export function getRequestUserId(req: Request): number | null {
  return req.user?.userId ?? null;
}
