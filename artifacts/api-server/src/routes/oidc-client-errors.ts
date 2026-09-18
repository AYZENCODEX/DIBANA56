/**
 * routes/oidc-client-errors.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5e-b: Token/Callback Errors (browser half).
 *
 * `routes/oidc-token.ts` already records every `POST /oidc/token` failure
 * under the "oidc" path (5c-d, `recordOidcLoginAttempt`) — that's the
 * server-observable half of "track protocol failures." The OTHER half,
 * `/oidc/callback`'s own closed set of failure states
 * (`SyloOidcCallbackErrorCode`, `lib/sylo-oidc-callback.ts`: `state_mismatch`,
 * `identity_mismatch`, `token_exchange_failed`, ...), happens entirely in
 * the browser — the backend has no other way to observe "the state
 * parameter didn't match" or "the ID token's nonce was wrong" than the
 * frontend telling it. This route is that one-way beacon:
 * `oidc-callback.tsx`'s existing catch block (5b-f) fires it, best-effort,
 * right alongside the UI it already shows — see
 * `lib/sylo-oidc-callback.ts`'s `reportSyloOidcCallbackError()` for the
 * frontend half of this pair.
 *
 * WHY A SEPARATE ROUTE, NOT REUSING /oidc/token's RECORDING
 * `/oidc/token` records a failure it ITSELF experienced, as a side effect
 * of handling a real request. This route has no request of its own to
 * handle — its entire job is "believe what the browser says happened to
 * IT" and file it under `OidcLoginAttemptPath`'s `"callback"` bucket
 * (5e-b's addition to `lib/oidc-login-attempts.ts`) so it doesn't get
 * confused with an actual `/oidc/token` failure the server can vouch for
 * itself.
 *
 * TRUST MODEL — a monitoring signal, not an audit log
 * Nothing about this beacon is authenticated (no session cookie required,
 * no bearer token — a callback error can legitimately happen before any
 * session exists) and nothing here is treated as ground truth for a
 * security decision: `evaluateOidcRolloutHealth()` (5e-c) folds `callback`
 * failures into the same "does this look broken right now" read as
 * `legacy`/`oidc`, exactly the same trust level `oidc-login-attempts.ts`'s
 * own file header already assigns the whole module (an in-memory,
 * per-process ROLLOUT-WINDOW signal, not an audit trail). A forged flood
 * of fake beacon hits could only ever make the dashboard look WORSE than
 * reality, never better, and `globalLimiter` below bounds how much of that
 * any one caller can do.
 *
 * BODY SHAPE: `{ appId: string, errorCode: string }` — deliberately no
 * free-text `message`/`description` field: the whole point of
 * `SyloOidcCallbackErrorCode` being a closed set (5b-f) is that a caller
 * only ever needs to report WHICH of a known handful of things happened,
 * not an arbitrary string this endpoint would otherwise have to sanitize,
 * cap the length of, and store. `errorCode` is accepted as any non-empty
 * string rather than validated against the closed set here — a future
 * frontend-side error code this backend doesn't recognize yet should
 * still show up in `topErrors` (5e-b) rather than being silently dropped;
 * the closed-set discipline lives in `lib/sylo-oidc-callback.ts`, this is
 * just a counter.
 *
 * RESPONSE SHAPE: always `204`, even on a malformed body — same
 * "monitoring must never surface as a failure to the thing it's
 * observing" discipline `recordOidcLoginAttempt()`'s own header states; a
 * beacon call failing loudly would just mean `oidc-callback.tsx` now has
 * to handle a SECOND error state for reporting the first one.
 *
 * MOUNTING: bare origin (not `/api`, not behind `apiKeyScopeGate`), same
 * tier as every other `/oidc/*` router — an unauthenticated browser tab
 * mid-callback-failure calls this directly against the issuer's origin,
 * same reasoning `routes/oidc-rollout-flag.ts`'s own header gives for
 * itself. `globalLimiter`, not `authLimiter` — this is a fire-and-forget
 * counter increment, not a credential-guessing surface, same distinction
 * `oidc-rollout-flag.ts`'s own header draws for its own read.
 */
import { Router, type IRouter } from "express";
import { globalLimiter } from "../middlewares/security";
import { recordOidcCallbackError } from "../lib/oidc-login-attempts";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.post("/oidc/client-errors", globalLimiter, (req, res): void => {
  try {
    const { appId, errorCode } = req.body as { appId?: unknown; errorCode?: unknown };
    if (typeof appId === "string" && appId.trim() && typeof errorCode === "string" && errorCode.trim()) {
      recordOidcCallbackError(appId.trim().toLowerCase(), errorCode.trim());
    } else {
      // Malformed body — logged for visibility (something in the frontend
      // beacon call is wrong), never surfaced to the caller as an error;
      // see file header's RESPONSE SHAPE note.
      logger.warn({ body: req.body }, "oidc.client_error.malformed_beacon");
    }
  } catch (err) {
    logger.warn({ err }, "oidc.client_error.route_failed");
  }
  res.status(204).end();
});

export default router;
