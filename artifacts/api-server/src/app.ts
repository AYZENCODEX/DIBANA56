import express, { type Express } from "express";
import pinoHttp from "pino-http";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes";
import wellKnownJwksRouter from "./routes/well-known-jwks";
import wellKnownOpenidConfigurationRouter from "./routes/well-known-openid-configuration";
import oidcAuthorizeRouter from "./routes/oidc-authorize";
import oidcTokenRouter from "./routes/oidc-token";
import oidcUserinfoRouter from "./routes/oidc-userinfo";
import oidcResourceRouter from "./routes/oidc-resource";
import oidcRolloutFlagRouter from "./routes/oidc-rollout-flag";
import oidcClientErrorsRouter from "./routes/oidc-client-errors";
import oidcLogoutRouter from "./routes/oidc-logout";
import oidcBackchannelLogoutRouter from "./routes/oidc-backchannel-logout";
import oidcConsentRouter from "./routes/oidc-consent";
// Season 4, Phase 7d (route half) + Season 5, Phase 10d — see
// routes/oidc-connected-apps.ts's own header for the full request/response
// contract. Same bare-origin, non-`/api`, no-`apiKeyScopeGate`,
// `requireAuth`-gated mounting as oidcConsentRouter just above.
import oidcConnectedAppsRouter from "./routes/oidc-connected-apps";
// OIDC Roadmap — Season 4, Phase 8a/8e. Same bare-origin, non-`/api`,
// no-`apiKeyScopeGate` mounting as every other `/oidc/*` router above —
// see routes/oidc-register.ts's own header for the full request/response
// flow and why `POST /oidc/register` in particular must stay
// unauthenticated.
import oidcRegisterRouter from "./routes/oidc-register";

// Season 5, Phase 10a — see routes/oidc-introspect.ts's own header for
// the full request/response contract and why it's mounted bare-origin,
// same as every other `/oidc/*` router in this file.
import oidcIntrospectRouter from "./routes/oidc-introspect";
// Season 5, Phase 10b — see routes/oidc-revoke.ts's own header for the
// full request/response contract; same bare-origin/authLimiter mounting
// tier as oidcIntrospectRouter just above.
import oidcRevokeRouter from "./routes/oidc-revoke";
import { logger } from "./lib/logger";
import { logBus } from "./lib/log-bus";
import { globalErrorHandler, notFoundHandler } from "./middlewares/error-handler";
import {
  securityHeaders,
  corsMiddleware,
  globalLimiter,
  dedupeQueryParams,
  sanitizeBody,
  JSON_BODY_LIMIT,
} from "./middlewares/security";
import { apiKeyScopeGate } from "./middlewares/api-key-scope";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { runWithTraceContext, traceContextFromHeaders } from "./lib/trace-context";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();

// Behind Render/Replit's reverse proxy — needed so req.ip and the rate
// limiter see the real client IP (X-Forwarded-For) instead of the proxy's.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// J3 — establish one trace context for every request. AsyncLocalStorage
// carries it through route/service/event/scheduler calls without requiring
// every domain method to thread an optional request object.
app.use((req, res, next) => {
  const context = traceContextFromHeaders(req.headers);
  res.setHeader("x-trace-id", context.traceId);
  if (context.correlationId) res.setHeader("x-correlation-id", context.correlationId);
  runWithTraceContext(context, next);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const code = res.statusCode;
    const level = code >= 500 ? "ERROR" : code >= 400 ? "WARN" : "INFO";
    const route = req.url?.split("?")[0] ?? "/";
    logBus.push({
      time: Date.now(),
      level,
      msg: `${req.method} ${route} → ${code}`,
      method: req.method,
      url: route,
      statusCode: code,
      ms: durationMs,
    });
    // Write to request_metrics table (fire-and-forget, only for /api/* routes).
    // Uses drizzle's parameterized `sql` tag (bind params) instead of sql.raw
    // + manual string interpolation — the previous version built the query
    // with string concatenation, which is the exact pattern SQL injection
    // comes from even when individual fields look "safe enough to escape".
    if (route.startsWith("/api/")) {
      db.execute(
        sql`INSERT INTO request_metrics (route, method, status_code, duration_ms)
            VALUES (${route}, ${req.method}, ${code}, ${durationMs})`,
      ).catch(() => { /* ignore until table exists after migration */ });
    }
  });
  next();
});

// ── Security layer ───────────────────────────────────────────────────────────
// See middlewares/security.ts for the full rationale behind each piece.
app.use(securityHeaders);
app.use(corsMiddleware);
// Reads the AYZEN Account session cookie (lib/session-cookie.ts) so
// getTokenFromReq() can fall back to it when a request has no
// Authorization header — this is what lets *.ayzen.tech subdomains share
// one login without each one re-sending a bearer token. Unsigned (JWT
// verification happens later, same as the header path) — just parsing.
app.use(cookieParser());
// Resend's inbound webhook needs the RAW body to verify its Svix signature
// (see routes/resend-webhook.ts) — carve it out before the global json/urlencoded
// parsers touch anything under /api, or the raw bytes are gone by the time we see them.
const RESEND_WEBHOOK_PATH = "/api/webhooks/resend/inbound";
app.use(RESEND_WEBHOOK_PATH, express.raw({ type: "*/*", limit: "10mb" }));
app.use((req, res, next) => (req.originalUrl === RESEND_WEBHOOK_PATH ? next() : express.json({ limit: JSON_BODY_LIMIT })(req, res, next)));
app.use((req, res, next) => (req.originalUrl === RESEND_WEBHOOK_PATH ? next() : express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT })(req, res, next)));
// Accepts raw CSV body (e.g. vault bulk import/export) alongside JSON.
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use(dedupeQueryParams);
app.use(sanitizeBody);

// OIDC discovery well-known endpoints — deliberately mounted at the bare
// origin (not under /api, and not behind apiKeyScopeGate): OIDC/RFC 8414
// clients resolve these relative to the issuer's origin, and a JWKS
// endpoint that verifies tokens (plus the discovery document that points
// at it) is by definition public (see routes/well-known-jwks.ts and
// routes/well-known-openid-configuration.ts for the rest of the
// rationale).
app.use(wellKnownJwksRouter);
app.use(wellKnownOpenidConfigurationRouter);

// `/oidc/authorize` — Season 2, Phase 3a (Authorization Request
// Validation only; see routes/oidc-authorize.ts for the full scope
// boundary). Mounted at the bare origin for the same reason as the two
// `well-known` routers above — an OIDC client builds this URL directly
// against the issuer's origin, not through `/api` — and NOT behind
// `apiKeyScopeGate`, which exists to scope THIS deployment's internal API
// key usage, not to gate a public OIDC endpoint a client is never expected
// to hold that key for. It has its own rate limiting (`authLimiter`,
// applied in the route file) instead of `globalLimiter`.
app.use(oidcAuthorizeRouter);

// `/oidc/token` — Season 2, Phase 3c (Token Endpoint) + Phase 3d (PKCE
// Enforcement). Same bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting
// as `/oidc/authorize` above and for the identical reason: an OIDC client's
// backend calls this URL directly against the issuer's origin. See
// routes/oidc-token.ts for the full scope boundary and rate-limiting
// rationale (`authLimiter`, applied in the route file).
app.use(oidcTokenRouter);

// `/oidc/userinfo` — Season 2, Phase 4c (UserInfo). Same bare-origin,
// non-`/api`, no-`apiKeyScopeGate` mounting as `/oidc/authorize` and
// `/oidc/token` above, for the identical reason: an OIDC client's backend
// calls this URL directly against the issuer's origin. See
// routes/oidc-userinfo.ts for the full scope boundary, RFC 6750 error
// shape, and rate-limiting rationale (`globalLimiter`, not `authLimiter`
// — applied in the route file).
app.use(oidcUserinfoRouter);

// `/oidc/resource/*` — Season 2, Phase 4e (Middleware Rollout). Same
// bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as the three
// OIDC routers above, for the identical reason. See
// routes/oidc-resource.ts for why these two routes (not any existing
// `/api/*` route) are what 4e-a selected, and for the scope-enforcement
// wiring itself (4e-b).
app.use(oidcResourceRouter);

// `/oidc/rollout-flags/:appId` — Season 3, Phase 5c-a. Same bare-origin,
// non-`/api`, no-`apiKeyScopeGate`, `globalLimiter` mounting as the OIDC
// routers above, and public rather than `requireAuth`-gated for the
// identical "before any session exists" reason — see
// routes/oidc-rollout-flag.ts's own header.
app.use(oidcRolloutFlagRouter);

// `/oidc/client-errors` — Season 3, Phase 5e-b. Bare-origin,
// `globalLimiter`, unauthenticated one-way beacon for `/oidc/callback`'s
// browser-only failure states — see routes/oidc-client-errors.ts's own
// header for the full trust model.
app.use(oidcClientErrorsRouter);

// `/oidc/logout` — Season 3, Phase 6a (RP-Initiated Logout Request) +
// Phase 6b (Session Termination) — this provider's `end_session_endpoint`.
// Same bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as the other
// `/oidc/*` routers above, for the identical reason — see
// routes/oidc-logout.ts's own header for the full request/response flow
// and why it reuses POST /auth/logout's exact session-revocation
// mechanism rather than a new one.
app.use(oidcLogoutRouter);

// `/oidc/backchannel-logout` — Season 3, Phase 6e-b (Sylo Integration).
// Same bare-origin, no-`/api`, no-`apiKeyScopeGate` mounting as every
// other `/oidc/*` router above — see routes/oidc-backchannel-logout.ts's
// own header for the full request/response contract.
app.use(oidcBackchannelLogoutRouter);

// `/oidc/consent/*` — Season 4, Phase 7b (Consent UI, backend half). Same
// bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as every other
// `/oidc/*` router above — see routes/oidc-consent.ts's own header for the
// full request/response contract. Unlike the routers above, every route
// in this one is `requireAuth`-gated (applied per-route in the file
// itself) — there is no anonymous caller for a screen shown "after
// login."
app.use(oidcConsentRouter);

// `/oidc/connected-apps`, `/oidc/connected-apps/:clientId/revoke` — Season
// 4, Phase 7d (route half, built out) + Season 5, Phase 10d (cascade
// wiring). Same bare-origin, non-`/api`, no-`apiKeyScopeGate` mounting as
// oidcConsentRouter above, and same `requireAuth` (not `apiKeyScopeGate`)
// gate applied per-route in the file itself — see
// routes/oidc-connected-apps.ts's own header for the full contract.
app.use(oidcConnectedAppsRouter);

// `/oidc/register`, `/oidc/register/:client_id` — Season 4, Phase 8a
// (register) + Phase 8e (self-management GET/PUT). Same bare-origin,
// non-`/api`, no-`apiKeyScopeGate` mounting as every other `/oidc/*`
// router above — see routes/oidc-register.ts's own header for the full
// scope boundary (`POST` unauthenticated by design; `GET`/`PUT
// /oidc/register/:client_id` bearer-authenticated via
// `registration_access_token`, not an AYZEN session).
app.use(oidcRegisterRouter);

// `/oidc/introspect` — Season 5, Phase 10a (Introspection Endpoint, RFC
// 7662-scoped-down). Same bare-origin, non-`/api`, no-`apiKeyScopeGate`
// mounting as every other `/oidc/*` router above, and same `authLimiter`
// tier as `/oidc/token` — see routes/oidc-introspect.ts's own header for
// the full request/response contract.
app.use(oidcIntrospectRouter);

// `/oidc/revoke` — Season 5, Phase 10b (Revocation Endpoint, RFC
// 7009-scoped-down). Same bare-origin, non-`/api`, no-`apiKeyScopeGate`,
// `authLimiter` mounting as `oidcIntrospectRouter` just above — see
// routes/oidc-revoke.ts's own header for the full request/response
// contract. Phase 10c's cascade functions and Phase 10d's actual 7d/9c/9d
// call sites + backchannel-logout hook are wired in via
// `oidcConnectedAppsRouter` (7d) and `routes/admin-oidc-clients.ts` (9c/9d)
// — see each file's own header. Discovery metadata (`revocation_endpoint`
// on `/.well-known/openid-configuration`), Phase 10e, is still not wired.
app.use(oidcRevokeRouter);

app.use("/api", globalLimiter, apiKeyScopeGate, router);

app.use("/api/{*splat}", notFoundHandler);
app.use(globalErrorHandler as any);

// ── Serve built frontend in production ───────────────────────────────────────
// AYZEN Workspace subdomain scoping (master plan §7 Phase 2 — Sylo split;
// Phase 3 — Ryft/Wisp/Verve added the same way). This is still ONE deployed
// app serving every *.ayzen.tech host — the subdomain-scoped behavior
// (restricted nav, route redirects) is handled client-side once the SPA
// boots (see lib/subdomain-app.ts). The one thing worth doing server-side is
// redirecting a bare "/" hit on a scoped hostname straight to that app's
// home route BEFORE the full Workspace shell's index.html even loads, so a
// visitor never sees a flash of the wrong app.
//
// One entry per split app, each independently configurable via its own
// `<ID>_HOSTS` env var (comma-separated) so hostnames can be rolled out one
// at a time — defaults match the matching `VITE_<ID>_HOSTS` fallback in
// subdomain-app.ts (`<id>.ayzen.tech`). Zynth is intentionally absent here
// too — see subdomain-app.ts's header for why (no user-facing route yet).
interface SplitAppHostConfig { id: string; hosts: string[]; homePath: string }

const SPLIT_APP_HOST_CONFIG: SplitAppHostConfig[] = [
  { id: "sylo", hosts: process.env.SYLO_HOSTS ?? "sylo.ayzen.tech", homePath: "/vault" },
  { id: "ryft", hosts: process.env.RYFT_HOSTS ?? "ryft.ayzen.tech", homePath: "/wallet" },
  { id: "wisp", hosts: process.env.WISP_HOSTS ?? "wisp.ayzen.tech", homePath: "/mailbox" },
  { id: "verve", hosts: process.env.VERVE_HOSTS ?? "verve.ayzen.tech", homePath: "/marketplace/hub" },
  { id: "skarn", hosts: process.env.SKARN_HOSTS ?? "skarn.ayzen.tech", homePath: "/projects" },
  { id: "zynth", hosts: process.env.ZYNTH_HOSTS ?? "zynth.ayzen.tech", homePath: "/assistant" },
  { id: "warde", hosts: process.env.WARDE_HOSTS ?? "warde.ayzen.tech", homePath: "/teams" },
].map((c) => ({
  id: c.id,
  hosts: c.hosts.split(",").map((h) => h.trim()).filter(Boolean),
  homePath: c.homePath,
}));

// Flat hostname → homePath lookup built once at startup, so the per-request
// redirect check below is a single Map.get() rather than looping every app
// on every request.
const SPLIT_APP_HOME_BY_HOST = new Map<string, string>(
  SPLIT_APP_HOST_CONFIG.flatMap((c) => c.hosts.map((h) => [h, c.homePath] as const)),
);

if (process.env.NODE_ENV === "production") {
  const distPath = path.resolve(__dirname, "../../ayzen/dist/public");
  app.use(express.static(distPath));
  app.get("/{*splat}", (req, res) => {
    const homePath = SPLIT_APP_HOME_BY_HOST.get(req.hostname);
    if ((req.path === "/" || req.path === "") && homePath) {
      res.redirect(302, homePath);
      return;
    }
    res.sendFile(path.join(distPath, "index.html"));
  });
}

export default app;
