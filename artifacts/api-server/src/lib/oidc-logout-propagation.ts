/**
 * lib/oidc-logout-propagation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6e-a: Propagation Interface.
 *
 * Phase 6d (see `CHANGES_OIDC_LOGOUT_PROPAGATION_DECISION_PHASE6D.md`)
 * chose OIDC Back-Channel Logout 1.0 for propagating a logout from this
 * provider to Sylo (and, per that doc's Decision Record, to any other
 * first-party client later, without the model itself needing to change).
 * This file is 6e-a's own scope, and ONLY 6e-a's:
 *
 *   "Create a clean abstraction" — nothing here dispatches a real HTTP
 *   request, nothing here reads `oidc_clients` for a real
 *   `backchannel_logout_uri` (that column does not exist yet — Phase
 *   6d-c's own "যা মাথায় রাখতে হবে" note), and nothing here is wired into
 *   `routes/oidc-logout.ts`, `routes/auth.ts`, or the Security page's
 *   revoke handlers.
 *
 * WHAT THIS FILE IS
 *   `buildLogoutTokenClaims()` / `issueOidcLogoutToken()` — pure claim
 *   assembly + RS256 signing, the exact same split
 *   `buildIdTokenClaims()`/`issueOidcIdToken()` (`lib/oidc-id-token.ts`,
 *   Phase 4a) already established: same active keypair
 *   (`getActiveKeypair()`), same published-JWKS trust chain (Phase 1e) a
 *   receiving RP would verify against, same "pure builder takes an
 *   explicit `now`, signer is a thin wrapper around it" discipline.
 *
 *   `propagateBackchannelLogout()` — the propagation interface itself,
 *   built around ONE injected effectful boundary (`deliver`), following
 *   this codebase's own "inject the effectful boundary" convention —
 *   `CHANGES_OIDC_LOGOUT_SESSION_PHASE6A_6C.md`'s design note on
 *   `resolveClient` (`lib/oidc-logout-request.ts`) is the most recent
 *   precedent for exactly this shape. `deliver` is REQUIRED, never
 *   defaulted to a real `fetch()` call — there is no real registered
 *   `backchannel_logout_uri` to call yet (see above), so a default
 *   implementation would have nothing real to do and nothing real to be
 *   tested against. 6e-b supplies both the real `deliver` and the real
 *   per-client target resolution once `oidc_clients.backchannel_logout_uri`
 *   exists.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 3, Phase 6e-b: Sylo Integration.
 *
 * Added below, appended after 6e-a's own content (left otherwise
 * unchanged — every function above this note is exactly what 6e-a shipped):
 *   - `resolveBackchannelLogoutTargets()` — the real target lookup 6e-a's
 *     header said didn't exist yet, backed by migration 085's
 *     `oidc_clients.backchannel_logout_uri` column via
 *     `lib/oidc-clients.ts`'s `listBackchannelLogoutTargets()`.
 *   - `deliverBackchannelLogoutOverHttp` — the real `OidcBackchannelLogoutDeliverFn`
 *     6e-a deliberately left undefaulted; a single-attempt HTTP POST, no
 *     retry (retry/backoff is still 6e-c's own scope, not started here).
 *   - `dispatchBackchannelLogoutForUser()` — the one function every
 *     session-revoking call site in the codebase now calls
 *     (`routes/auth.ts`, `routes/oidc-logout.ts`), userId-scoped per this
 *     file's own `OidcLogoutTokenBinding.sid` design (still `null` on
 *     every call — this provider does not populate a `sid` on the
 *     sending side, see that field's own doc comment above).
 *
 * Still NOT this file's scope after 6e-b (unchanged from 6e-a's own list):
 *   - No `oidc.backchannel_logout.*` metrics/alerting beyond the
 *     `logger.info`/`logger.warn`/`logger.error` calls in this file —
 *     structured dashboards/alerting is 6e-d (Monitoring).
 *   - No resolution of "which of Sylo's OWN `user_sessions` rows a given
 *     Logout Token's `sub` maps to" — that is the RECEIVING side's job,
 *     `lib/oidc-backchannel-logout-receive.ts` (Sylo's own
 *     `routes/oidc-backchannel-logout.ts` endpoint), a separate file this
 *     one only ever sends to, never reads from.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UPDATE — Season 3, Phase 6e-c: Failure Handling.
 *
 * Both 6e-a's and 6e-b's own headers above deliberately reserved this
 * exact scope for later: `OidcBackchannelLogoutDeliveryResult`'s own doc
 * comment says "Deliberately has no `attempt`/`retryAfter`-style fields
 * yet — that's 6e-c's own shape to add"; `deliverBackchannelLogoutOverHttp`'s
 * says "Retry/backoff policy is explicitly 6e-c's own scope, not
 * speculated in this function." This section is that scope, appended
 * after 6e-b's own content the same way 6e-b was appended after 6e-a's —
 * every function above this note is exactly what 6e-a/6e-b shipped,
 * unmodified, except `dispatchBackchannelLogoutForUser()` itself, whose
 * failure branches now call `enqueueBackchannelLogoutRetry()` below
 * instead of only logging and dropping the event.
 *
 * WHAT WAS MISSING BEFORE THIS
 *   `dispatchBackchannelLogoutForUser()` made exactly ONE HTTP POST
 *   attempt per registered target. On failure (network error, non-2xx, or
 *   an unexpected thrown error) it logged a `logger.warn` and moved on —
 *   no durable record survived a process restart, so a Sylo outage (a
 *   deploy, a restart, a transient network blip) at the wrong moment
 *   permanently desynced that user's Sylo session from their actual
 *   Central logout/revoke, with nothing anywhere recording that it
 *   happened.
 *
 * WHAT THIS SECTION ADDS
 *   A durable retry queue, deliberately mirroring `lib/mail-send-queue.ts`'s
 *   own proven shape (migrations 047/048) rather than inventing a second
 *   retry convention in this codebase — durable table (migration 087) +
 *   `FOR UPDATE SKIP LOCKED` claim + exponential backoff with jitter +
 *   stale-lock/startup crash recovery + give-up-after-N-attempts:
 *     - `enqueueBackchannelLogoutRetry()` — called by
 *       `dispatchBackchannelLogoutForUser()` ONLY when the inline first
 *       attempt fails (never on success — a durable row would have
 *       nothing left to do). Itself never throws.
 *     - `nextBackchannelLogoutRetryDelay()` — pure backoff calculation,
 *       exported so tests can assert its shape without a live DB, same
 *       split `computeAuthorizationCodeExpiry()`-style pure helpers in
 *       this codebase already keep from their DB-touching callers.
 *     - `runBackchannelLogoutQueueSweep()` — one worker tick: claim due
 *       rows, retry each via the SAME `deliverBackchannelLogoutOverHttp`
 *       boundary the inline first attempt already uses (re-used, not
 *       re-implemented), back off on failure, move to `dead_letter` after
 *       `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS`.
 *     - `startBackchannelLogoutQueueWorker()` — registered in `index.ts`
 *       alongside `startSendQueueWorker()`, the same "one `cron.schedule`
 *       call per durable queue" convention this codebase already uses for
 *       every other durable queue/cron it has.
 *
 * WHY A DURABLE TABLE, NOT AN IN-PROCESS RETRY (e.g. `setTimeout`)
 *   An in-memory retry dies with the process — the exact same durability
 *   gap `lib/mail-send-queue.ts`'s own header describes for the pre-
 *   Phase-1 inline send path it replaced. A deploy/restart landing between
 *   a failed first attempt and its in-memory retry would silently lose
 *   the retry entirely, defeating the entire point of "Failure Handling."
 *
 * WHY EACH RETRY MINTS A FRESH LOGOUT TOKEN, NOT A STORED ONE
 *   `LOGOUT_TOKEN_TTL_SECONDS` is 2 minutes — a Logout Token is a live,
 *   short-TTL event notification, not a credential meant to be replayed
 *   later (see that constant's own doc comment, and
 *   `lib/oidc-backchannel-logout-receive.ts`'s header: the receiving side
 *   DOES enforce `exp`, unlike an `id_token_hint`). A backoff-delayed
 *   retry running minutes after the original failure would be replaying
 *   an already-expired token if one were stored. So the queue table
 *   (migration 087) stores the BINDING a retry needs to remint one
 *   (`user_id`, `client_id`, `backchannel_logout_uri`), never a signed
 *   JWT string — `processBackchannelLogoutQueueRow()` calls
 *   `issueOidcLogoutToken()` fresh on every attempt, exactly like the
 *   inline first attempt does via `propagateBackchannelLogout()`.
 *
 * WHY DEAD-LETTER, NOT "RETRY FOREVER"
 *   A target that is permanently gone (Sylo decommissioned, its
 *   `backchannel_logout_uri` rotated without the corresponding
 *   `oidc_clients` row being updated) would otherwise accumulate an
 *   unbounded number of queue rows retried forever.
 *   `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS` bounds this the same way
 *   `MAX_SEND_ATTEMPTS` bounds `lib/mail-send-queue.ts`'s own retries —
 *   once the last attempt fails, the row moves to a terminal
 *   `'dead_letter'` status instead of continuing to retry, logged via
 *   `logger.error`/`logBus.error` as a REQUIRES-ATTENTION event (6e-d's
 *   future dashboards/alerting, not built here, would key off this exact
 *   status column rather than parsing log lines).
 *
 * WHY THE SNAPSHOT `backchannel_logout_uri` IS NOT RE-RESOLVED PER RETRY
 *   A queued row retries against the URI captured at enqueue time, not a
 *   fresh `oidc_clients` lookup on every attempt. This keeps a single
 *   queued row's retry history aimed at the one target it was actually
 *   created for — if an operator rotates a client's registered URI mid-
 *   retry-window, the OLD queued rows finish (or dead-letter) against the
 *   URI that was live when they failed, and any NEW logout event created
 *   after the rotation naturally uses the new URI via
 *   `resolveBackchannelLogoutTargets()`'s always-fresh lookup. Re-
 *   resolving on every retry would also reopen a subtler bug: a client
 *   that unregisters entirely (`backchannel_logout_uri` set back to
 *   `NULL`) would make a live re-lookup return nothing, and a naive
 *   "skip this attempt, but don't dead-letter it either" branch would
 *   need inventing — a fixed snapshot avoids that with no added shape.
 *
 * WHAT THIS SECTION DELIBERATELY IS NOT (still not this phase's scope)
 *   - No admin UI/endpoint to list or manually replay dead-lettered rows.
 *     Not asked for by 6e-c's own task list ("define safe behavior when
 *     propagation fails") — `lib/mail-send-queue.ts`'s own dead-letter
 *     equivalent (Drafts) is a surface the user already has for other
 *     reasons; this queue has no such existing surface to piggyback on.
 *   - No structured `oidc.backchannel_logout.*` metrics/dashboards beyond
 *     the `logger`/`logBus` calls this section adds — 6e-d (Monitoring).
 *   - No change to `dispatchBackchannelLogoutForUser()`'s own userId-
 *     scoped, one-event-per-registered-client shape, or to any of the
 *     three call sites that invoke it — this section only changes what
 *     happens AFTER a delivery attempt fails, nothing about when one is
 *     triggered.
 */
import jwt from "jsonwebtoken";
import cron from "node-cron";
import { randomUUID } from "node:crypto";
import { pool, db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getActiveKeypair } from "./jwt-keys";
import { resolveIssuer } from "./oidc-discovery";
// OIDC Roadmap — Season 3, Phase 6e-b (Sylo Integration): the real target
// registry this file's own 6e-a header said didn't exist yet
// ("nothing here reads `oidc_clients` for a real `backchannel_logout_uri`
// (that column does not exist yet)") — migration 085 adds the column,
// `listBackchannelLogoutTargets()` (lib/oidc-clients.ts) is its one
// reader, `resolveBackchannelLogoutTargets()` below is this file's own
// thin wrapper over it.
import { listBackchannelLogoutTargets } from "./oidc-clients";
import { logger } from "./logger";
// OIDC Roadmap — Season 3, Phase 6e-c (Failure Handling): same `logBus`
// operator-facing stream `lib/mail-send-queue.ts` already uses alongside
// `logger` for its own durable queue's sweep/recovery/give-up events.
import { logBus } from "./log-bus";
// OIDC Roadmap — Season 3, Phase 6e-d (Monitoring): `db`/`usersTable`/`eq`
// (drizzle, not the raw `pool` this file otherwise uses for the queue
// table itself) + `sendEmail` are ONLY for the admin-alert path below —
// same "raw pool for the queue's own rows, drizzle for the one admin
// lookup" split `lib/dr-test-cron.ts`/`lib/vault-backup-alerts.ts` already
// use for their own admin-notification code.
import { sendEmail } from "./email";

/**
 * OpenID Back-Channel Logout 1.0 §2.4 — the one fixed member every Logout
 * Token's `events` claim carries, always as an empty object (the spec
 * reserves this member's value for possible future extension; this
 * provider never populates it).
 */
export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout" as const;

/**
 * 6e-a: Logout Token lifetime. Short — this token is a single fire-and-
 * forget event notification, consumed (or retried — 6e-c) within seconds
 * of being issued, never re-presented later the way an ID token can be
 * re-decoded well after issuance. 2 minutes comfortably covers real
 * network latency/retry without leaving a long-lived signed artifact with
 * no purpose beyond "prove I told you to log out" in circulation.
 */
export const LOGOUT_TOKEN_TTL_SECONDS = 2 * 60;

/**
 * 6e-a: what this file needs to build ONE Logout Token about. `sid`, per
 * spec §3, lets an RP disambiguate which of ITS OWN sessions the event
 * concerns when it tracks more than one per subject — this provider does
 * not populate one today (see file header's "what this file deliberately
 * is not"), so it's `string | null`, mirroring `OidcIdTokenBinding.nonce`'s
 * own `null`-means-omit shape (Phase 4b) rather than an optional field a
 * caller could forget to pass at all.
 */
export interface OidcLogoutTokenBinding {
  userId: number;
  clientId: string;
  sid: string | null;
}

/**
 * OpenID Back-Channel Logout 1.0 §2.4's claim set. Deliberately does NOT
 * extend `IdTokenClaims` (`lib/oidc-id-token.ts`) even though several
 * fields overlap — the spec (§2.4) requires a Logout Token to OMIT
 * `nonce` entirely (a Logout Token is never an authentication-freshness
 * proof the way an ID token is) and to carry `events`/optionally `sid`,
 * neither of which belongs on `IdTokenClaims` at all. Sharing a type
 * would let a future edit accidentally add `nonce` support to both at
 * once.
 */
export interface LogoutTokenClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  events: { [BACKCHANNEL_LOGOUT_EVENT]: Record<string, never> };
  sid?: string;
}

/**
 * 6e-a: pure claim assembly — no signing, no I/O. Both `jti` and `now`
 * take explicit values so this file's own tests (and 6e-b's future
 * callers) never race the real clock or `randomUUID()`'s own
 * non-determinism — the identical discipline `buildIdTokenClaims()` and
 * `computeAuthorizationCodeExpiry()` already established.
 *
 * The `sid` key is added via a conditional spread, not assigned directly
 * — the same reason `buildIdTokenClaims()` spreads `nonce` rather than
 * assigning `resolveIdTokenNonce(...)`: assigning `undefined` to a key
 * still creates that key on the object (though not on the wire once
 * `JSON.stringify`'d), and the spread is the one construction that
 * structurally cannot produce a `sid` key at all when `binding.sid` is
 * `null`.
 */
export function buildLogoutTokenClaims(
  binding: OidcLogoutTokenBinding,
  jti: string,
  now: Date = new Date(),
): LogoutTokenClaims {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + LOGOUT_TOKEN_TTL_SECONDS;

  return {
    iss: resolveIssuer(),
    sub: String(binding.userId),
    aud: binding.clientId,
    iat,
    exp,
    jti,
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...(binding.sid !== null ? { sid: binding.sid } : {}),
  };
}

/**
 * 6e-a: signs `buildLogoutTokenClaims(...)` with the same active RS256
 * keypair every other token in this codebase uses — same
 * `noTimestamp`/pre-built-claims reasoning `issueOidcIdToken()`'s own doc
 * comment gives (no second, parallel `iat`/`exp` computation path).
 *
 * `jti` defaults to a fresh `randomUUID()` per call — `lib/sessions.ts`'s
 * own `generateSessionId()` uses the sibling `randomBytes(...).toString
 * ("hex")` for a different, longer-lived identifier (a `user_sessions`
 * row's primary lookup key); a Logout Token's `jti` only needs Back-
 * Channel Logout 1.0 §2.4's "unique identifier for the token" property,
 * not that file's own device-session shape, so it uses the simpler
 * built-in (`mail-send-queue.ts`'s `WORKER_ID` is this codebase's existing
 * `randomUUID()` precedent).
 */
export function issueOidcLogoutToken(
  binding: OidcLogoutTokenBinding,
  now: Date = new Date(),
  jti: string = randomUUID(),
): string {
  const { privateKey, kid } = getActiveKeypair();
  const claims = buildLogoutTokenClaims(binding, jti, now);
  return jwt.sign(claims, privateKey, {
    algorithm: "RS256",
    keyid: kid,
    noTimestamp: true,
  });
}

// ─── 6e-a: dispatch abstraction (injected, not implemented) ─────────────────

/**
 * 6e-a: one registered receiver of this provider's back-channel logout
 * events. `backchannelLogoutUri` is deliberately typed as a plain
 * `string` here, not sourced from any DB row — that lookup is 6e-b's job
 * once `oidc_clients.backchannel_logout_uri` exists (Phase 6d-c).
 */
export interface OidcBackchannelLogoutTarget {
  clientId: string;
  backchannelLogoutUri: string;
}

/**
 * Outcome of one delivery attempt — a closed, inspectable result rather
 * than a thrown exception, since 6e-c (Failure Handling) will need to
 * branch on WHY a delivery failed (network vs a non-2xx response) without
 * every caller needing a try/catch around this file's own dispatch
 * function. Deliberately has no `attempt`/`retryAfter`-style fields yet —
 * that's 6e-c's own shape to add, not speculated here.
 */
export type OidcBackchannelLogoutDeliveryResult =
  | { ok: true }
  | { ok: false; reason: "network_error" | "non_2xx_response"; detail?: string };

/**
 * 6e-a's one injected effectful boundary — the actual HTTP POST of a
 * signed Logout Token to a target's `backchannelLogoutUri`, per OpenID
 * Back-Channel Logout 1.0 §2.5 (`application/x-www-form-urlencoded` body,
 * `logout_token=<JWT>`). REQUIRED, never defaulted to a real `fetch()`
 * implementation — see file header for why there is no real call to make
 * yet.
 */
export type OidcBackchannelLogoutDeliverFn = (
  target: OidcBackchannelLogoutTarget,
  logoutToken: string,
) => Promise<OidcBackchannelLogoutDeliveryResult>;

/**
 * 6e-a: the propagation interface itself — builds one target's Logout
 * Token and hands it to the injected `deliver` boundary. Deliberately
 * does NOT loop over "every client the user is currently logged into"
 * (that requires the `oidc_clients.backchannel_logout_uri` lookup 6e-b
 * adds) — this is the ONE-target unit 6e-b's own multi-target loop will
 * call once per registered client with a back-channel URI.
 */
export async function propagateBackchannelLogout(
  binding: OidcLogoutTokenBinding,
  target: OidcBackchannelLogoutTarget,
  deliver: OidcBackchannelLogoutDeliverFn,
  now: Date = new Date(),
): Promise<OidcBackchannelLogoutDeliveryResult> {
  const logoutToken = issueOidcLogoutToken(binding, now);
  return deliver(target, logoutToken);
}

// ─── 6e-b: Sylo Integration — real target resolution + dispatch ────────────

/**
 * 6e-b: every currently-registered receiver of this provider's
 * Back-Channel Logout events — a thin wrapper over
 * `lib/oidc-clients.ts`'s `listBackchannelLogoutTargets()`, mapped into
 * this file's own `OidcBackchannelLogoutTarget` shape (kept as a separate
 * function, not inlined into `dispatchBackchannelLogoutForUser()` below,
 * so this file's own tests can stub target resolution independently of
 * dispatch, the same split `propagateBackchannelLogout()` already keeps
 * between "build+send one" and "who gets one").
 *
 * Deliberately cheap even when it returns an empty/short list (today:
 * just Sylo) — `dispatchBackchannelLogoutForUser()` awaits this on EVERY
 * session-revoke call site in the codebase, so an empty result must stay
 * a fast, harmless no-op rather than something a caller needs to
 * special-case.
 */
export async function resolveBackchannelLogoutTargets(): Promise<OidcBackchannelLogoutTarget[]> {
  const rows = await listBackchannelLogoutTargets();
  return rows.map((r) => ({ clientId: r.clientId, backchannelLogoutUri: r.backchannelLogoutUri }));
}

/**
 * 6e-b's real `OidcBackchannelLogoutDeliverFn` — an actual HTTP POST per
 * OpenID Back-Channel Logout 1.0 §2.5 (`application/x-www-form-urlencoded`
 * body, `logout_token=<JWT>`). Per Phase 6d-c's own note, Sylo today runs
 * in this SAME Express process (see `app.ts`'s own header on subdomain
 * scoping — "This is intentionally NOT a separate build/deploy"), so in
 * production this `fetch()` targets this same deployment's own
 * `/oidc/backchannel-logout` route (`routes/oidc-backchannel-logout.ts`)
 * rather than a genuinely separate service — but it is written exactly as
 * it would be for a real, independently-deployed RP (Ryft/Wisp/Verve/
 * Zynth, future scope), per that Decision Record's own requirement that
 * this model not need to change once they are.
 *
 * A single attempt, ok/not-ok handed back unchanged — no retry here.
 * Retry/backoff policy is explicitly 6e-c's own scope (see file header),
 * not speculated in this function.
 */
export const deliverBackchannelLogoutOverHttp: OidcBackchannelLogoutDeliverFn = async (target, logoutToken) => {
  try {
    const res = await fetch(target.backchannelLogoutUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `logout_token=${encodeURIComponent(logoutToken)}`,
    });
    if (res.ok) return { ok: true };
    return { ok: false, reason: "non_2xx_response", detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }
};

/**
 * 6e-b: the one function every session-revoking call site in the
 * codebase now calls — `routes/auth.ts`'s `POST /auth/logout`,
 * `revokeSession`, and `revokeAllSessionsExcept` handlers, and
 * `routes/oidc-logout.ts`'s RP-initiated logout handler. See each call
 * site's own comment for why it's always `void`-called there, never
 * `await`ed: propagation must never block or fail the caller's own,
 * already-succeeded, session revocation.
 *
 * Userid-scoped, not session-scoped: a Logout Token only ever carries
 * `sub` (this file's own `OidcLogoutTokenBinding.sid` stays `null` on
 * every call below — see that field's own doc comment above for why this
 * provider doesn't populate one on the sending side), so this dispatches
 * one event per REGISTERED CLIENT for the user, not one per revoked
 * `user_sessions` row. The receiving side
 * (`lib/oidc-backchannel-logout-receive.ts`) is what narrows "every
 * session" back down to "just this client's session(s)" via
 * `origin_client_id` (migration 086).
 *
 * Swallows every failure itself — a target-resolution error, a delivery
 * failure, or any unexpected thrown error — logged via `logger.warn`,
 * never re-thrown, so a Sylo outage (or a DB hiccup reading
 * `oidc_clients`) can never surface as a broken Central logout/revoke
 * response for the user who triggered it. This is why every caller can
 * safely `void` this call rather than wrapping it in its own try/catch.
 */
export async function dispatchBackchannelLogoutForUser(userId: number): Promise<void> {
  let targets: OidcBackchannelLogoutTarget[];
  try {
    targets = await resolveBackchannelLogoutTargets();
  } catch (err) {
    logger.warn({ err, userId }, "oidc.backchannel_logout.dispatch.target_resolution_failed");
    return;
  }

  for (const target of targets) {
    const binding: OidcLogoutTokenBinding = { userId, clientId: target.clientId, sid: null };
    try {
      const result = await propagateBackchannelLogout(binding, target, deliverBackchannelLogoutOverHttp);
      if (result.ok) {
        logger.info({ userId, clientId: target.clientId }, "oidc.backchannel_logout.dispatched");
      } else {
        logger.warn(
          { userId, clientId: target.clientId, reason: result.reason, detail: result.detail },
          "oidc.backchannel_logout.dispatch_failed",
        );
        // 6e-c: the inline attempt above is a single try, same as before —
        // what's new is that a failure no longer just gets logged and
        // dropped. See file header's own "WHAT THIS SECTION ADDS" for why
        // this hands off to a durable queue instead of retrying in-process.
        await enqueueBackchannelLogoutRetry({
          userId,
          clientId: target.clientId,
          backchannelLogoutUri: target.backchannelLogoutUri,
          lastError: result.detail ?? result.reason,
        });
      }
    } catch (err) {
      logger.warn({ err, userId, clientId: target.clientId }, "oidc.backchannel_logout.dispatch_unexpected_error");
      await enqueueBackchannelLogoutRetry({
        userId,
        clientId: target.clientId,
        backchannelLogoutUri: target.backchannelLogoutUri,
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * UPDATE — Season 5, Phase 10d: Cascade Call-Site Wiring.
 *
 * `dispatchBackchannelLogoutForUser()` above dispatches one event per
 * REGISTERED CLIENT for a user — correct for a whole-account logout
 * (`routes/auth.ts`, `routes/oidc-logout.ts`), wrong for a
 * single-client cascade: 7d's own consent-revoke
 * (`routes/oidc-connected-apps.ts`) only ever wants to notify the ONE
 * client the user just disconnected, not every OTHER client that user is
 * still perfectly validly logged into. `lib/oidc-user-consents.ts`'s own
 * header names this exact function
 * (`dispatchBackchannelLogoutForUserAndClient()`) as "the one real effect
 * 7d composes alongside [its] own `revokeConsent()`" — this is that
 * function, built for the first time in this pass.
 *
 * Same single-attempt-then-durable-retry shape as
 * `dispatchBackchannelLogoutForUser()` (reuses
 * `deliverBackchannelLogoutOverHttp` and `enqueueBackchannelLogoutRetry()`
 * as-is, no second delivery/retry mechanism invented for the
 * single-client case), narrowed to the one target named by `clientId`
 * instead of looping `resolveBackchannelLogoutTargets()`'s full list. A
 * `clientId` with no registered `backchannel_logout_uri` (or one that
 * isn't a real client at all) is a harmless, silent no-op — identical
 * posture to `dispatchBackchannelLogoutForUser()`'s own "empty target
 * list is a fast, harmless no-op," just narrowed to zero-or-one target
 * instead of zero-or-many.
 *
 * Same "swallow every failure, never re-throw" contract as
 * `dispatchBackchannelLogoutForUser()` — every real caller (7d's route,
 * and 10d's own admin-suspend/admin-delete call sites in
 * `routes/admin-oidc-clients.ts`) `void`-calls this rather than awaiting
 * it inline, for the identical reason: propagation must never block or
 * fail an already-succeeded consent-revoke/token-cascade response.
 */
export async function dispatchBackchannelLogoutForUserAndClient(userId: number, clientId: string): Promise<void> {
  let targets: OidcBackchannelLogoutTarget[];
  try {
    targets = await resolveBackchannelLogoutTargets();
  } catch (err) {
    logger.warn({ err, userId, clientId }, "oidc.backchannel_logout.dispatch.target_resolution_failed");
    return;
  }

  const target = targets.find((t) => t.clientId === clientId);
  if (!target) {
    // No registered backchannel_logout_uri for this client (or it isn't a
    // real client at all) — nothing to notify, same silent no-op posture
    // dispatchBackchannelLogoutForUser() takes for an empty target list.
    return;
  }

  const binding: OidcLogoutTokenBinding = { userId, clientId: target.clientId, sid: null };
  try {
    const result = await propagateBackchannelLogout(binding, target, deliverBackchannelLogoutOverHttp);
    if (result.ok) {
      logger.info({ userId, clientId: target.clientId }, "oidc.backchannel_logout.dispatched");
      return;
    }
    logger.warn(
      { userId, clientId: target.clientId, reason: result.reason, detail: result.detail },
      "oidc.backchannel_logout.dispatch_failed",
    );
    await enqueueBackchannelLogoutRetry({
      userId,
      clientId: target.clientId,
      backchannelLogoutUri: target.backchannelLogoutUri,
      lastError: result.detail ?? result.reason,
    });
  } catch (err) {
    logger.warn({ err, userId, clientId: target.clientId }, "oidc.backchannel_logout.dispatch_unexpected_error");
    await enqueueBackchannelLogoutRetry({
      userId,
      clientId: target.clientId,
      backchannelLogoutUri: target.backchannelLogoutUri,
      lastError: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── 6e-c: durable retry queue (migration 087) ──────────────────────────────

/**
 * 6e-c: how many total delivery attempts a queued row gets before it's
 * moved to `'dead_letter'` — counted INCLUDING the inline first attempt
 * that failed and caused the row to be enqueued (see
 * `enqueueBackchannelLogoutRetry()`'s own `attempts: 1` insert below), so
 * this is really "1 inline attempt + up to
 * `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS - 1` queued retries." Same value
 * `mail-send-queue.ts`'s `MAX_SEND_ATTEMPTS` uses, for the same reason:
 * bounded, not tuned per-queue without a concrete reason to diverge.
 */
export const MAX_BACKCHANNEL_LOGOUT_ATTEMPTS = 5;

// Backoff: baseMs * 2^(attempts-1), capped at maxMs, ±20% jitter — the
// identical formula `mail-send-queue.ts`'s `nextAttemptDelay()` uses (see
// that function's own comment for why jitter matters: a mass failure,
// e.g. Sylo itself is down, shouldn't retry every queued row in
// lockstep). `attempts` here already includes the failed attempt that
// just happened, so attempts=1..4 (the 4 retries before dead-letter) ->
// roughly 10s, 20s, 40s, 80s.
const BACKCHANNEL_LOGOUT_BACKOFF_BASE_MS = 10_000;
const BACKCHANNEL_LOGOUT_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * 6e-c: pure backoff calculation, deliberately exported and side-effect
 * free (no DB, no clock read beyond what's passed in via the caller's own
 * `Date.now()`) — same "pure calculation, thin effectful wrapper around
 * it" split this file already keeps for `buildLogoutTokenClaims()` vs
 * `issueOidcLogoutToken()`. Lets tests assert the backoff curve's shape
 * without touching a live DB.
 */
export function nextBackchannelLogoutRetryDelayMs(attempts: number): number {
  const raw = Math.min(BACKCHANNEL_LOGOUT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKCHANNEL_LOGOUT_BACKOFF_MAX_MS);
  const jitter = raw * 0.2 * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(raw + jitter));
}

// How long a row can sit locked in 'sending' before the stale-lock sweep
// reclaims it as abandoned — mirrors `mail-send-queue.ts`'s
// `SEND_STUCK_TIMEOUT_MS` reasoning exactly: long enough that a
// legitimately slow HTTP POST doesn't get reclaimed out from under
// itself, short enough that a truly stuck row (worker died, never
// restarted) isn't stranded indefinitely.
const BACKCHANNEL_LOGOUT_STUCK_TIMEOUT_MS = 5 * 60_000;

const BACKCHANNEL_LOGOUT_CLAIM_BATCH_SIZE = 10;

// One id per process, stamped onto locked_by when a row is claimed — same
// shape `mail-send-queue.ts`'s own `WORKER_ID` uses, kept as a SEPARATE
// constant (not shared across files) since the two queues' worker
// processes have no reason to share an identity.
const BACKCHANNEL_LOGOUT_WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`;

interface BackchannelLogoutQueueRow {
  id: number;
  userId: number;
  clientId: string;
  backchannelLogoutUri: string;
  status: "pending" | "sending" | "delivered" | "dead_letter";
  attempts: number;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: Date;
}

function rowFromDb(row: any): BackchannelLogoutQueueRow {
  return {
    id: row.id,
    userId: row.user_id,
    clientId: row.client_id,
    backchannelLogoutUri: row.backchannel_logout_uri,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    createdAt: row.created_at,
  };
}

/**
 * 6e-c: durably records a failed delivery attempt so it survives a
 * process restart and gets retried with backoff. Called by
 * `dispatchBackchannelLogoutForUser()` above ONLY when the inline first
 * attempt fails — never on success (nothing to retry) and never called
 * directly by any route.
 *
 * `attempts` starts at 1, not 0 — this row's very existence IS the record
 * of one already-failed attempt (the inline one that just happened), so
 * the count `processBackchannelLogoutQueueRow()` checks against
 * `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS` stays accurate without a separate
 * "attempts before this row existed" tally.
 *
 * Never throws — a failure to enqueue a retry must not turn into a
 * second, unhandled failure on top of the delivery failure that's already
 * being handled. Same "catch, log via logger.warn, return" contract every
 * other DB-touching function in this file/`lib/oidc-clients.ts` already
 * uses.
 */
export async function enqueueBackchannelLogoutRetry(params: {
  userId: number;
  clientId: string;
  backchannelLogoutUri: string;
  lastError: string;
}): Promise<void> {
  const { userId, clientId, backchannelLogoutUri, lastError } = params;
  const delay = nextBackchannelLogoutRetryDelayMs(1);
  // Computed here in JS (Date, not a SQL interval expression) — same
  // "pass an already-computed timestamp, let the pg driver bind it
  // directly" convention `mail-send-queue.ts`'s own `enqueueSend()` uses
  // (`nextAttemptAt: new Date(Date.now() + delayMs)`), rather than doing
  // the arithmetic in SQL.
  const nextAttemptAt = new Date(Date.now() + delay);
  try {
    await pool.query(
      `INSERT INTO ayzen_oidc_backchannel_logout_queue
         (user_id, client_id, backchannel_logout_uri, status, attempts, next_attempt_at, last_error)
       VALUES ($1, $2, $3, 'pending', 1, $4, $5)`,
      [userId, clientId, backchannelLogoutUri, nextAttemptAt, lastError],
    );
    logger.info({ userId, clientId, retryInMs: delay }, "oidc.backchannel_logout.retry_enqueued");
  } catch (err) {
    logger.warn({ err, userId, clientId }, "oidc.backchannel_logout.retry_enqueue_failed");
  }
}

/**
 * Atomically claims up to `limit` due rows via `FOR UPDATE SKIP LOCKED` —
 * same reasoning `mail-send-queue.ts`'s `claimNextBatch()` gives: more
 * than one API server instance can run this worker concurrently without
 * ever claiming the same row twice, with no separate distributed lock
 * needed. This file's own queries elsewhere in the codebase use the raw
 * `pool` (not drizzle's `db`), so this uses `pool.connect()` +
 * `BEGIN`/`COMMIT` directly rather than drizzle's `db.transaction(...)`
 * wrapper `mail-send-queue.ts` gets for free — same guarantee, this
 * file's own existing convention.
 */
async function claimNextBackchannelLogoutBatch(limit: number): Promise<BackchannelLogoutQueueRow[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimable = await client.query(
      `SELECT id FROM ayzen_oidc_backchannel_logout_queue
       WHERE status = 'pending' AND next_attempt_at <= now()
       ORDER BY created_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    const ids = claimable.rows.map((r: { id: number }) => r.id);
    if (!ids.length) {
      await client.query("COMMIT");
      return [];
    }

    const claimed = await client.query(
      `UPDATE ayzen_oidc_backchannel_logout_queue
       SET status = 'sending', locked_at = now(), locked_by = $1
       WHERE id = ANY($2::int[])
       RETURNING *`,
      [BACKCHANNEL_LOGOUT_WORKER_ID, ids],
    );
    await client.query("COMMIT");
    return claimed.rows.map(rowFromDb);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retries one claimed row: mints a FRESH Logout Token (see file header's
 * own "WHY EACH RETRY MINTS A FRESH LOGOUT TOKEN" for why the row never
 * stores one) and hands it to the SAME `deliverBackchannelLogoutOverHttp`
 * boundary the inline first attempt uses. On success, the row becomes
 * terminal (`'delivered'`). On failure, either backs off (bump `attempts`,
 * push `next_attempt_at` forward, back to `'pending'`) or, once
 * `MAX_BACKCHANNEL_LOGOUT_ATTEMPTS` is reached, becomes terminal
 * (`'dead_letter'`) — same two-branch shape
 * `mail-send-queue.ts`'s `processQueueRow()` failure handling uses.
 */
async function processBackchannelLogoutQueueRow(row: BackchannelLogoutQueueRow): Promise<"delivered" | "retrying" | "dead_letter"> {
  const binding: OidcLogoutTokenBinding = { userId: row.userId, clientId: row.clientId, sid: null };
  const target: OidcBackchannelLogoutTarget = { clientId: row.clientId, backchannelLogoutUri: row.backchannelLogoutUri };

  let result: OidcBackchannelLogoutDeliveryResult;
  try {
    result = await propagateBackchannelLogout(binding, target, deliverBackchannelLogoutOverHttp);
  } catch (err) {
    result = { ok: false, reason: "network_error", detail: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    await pool.query(
      `UPDATE ayzen_oidc_backchannel_logout_queue SET status = 'delivered', last_error = NULL WHERE id = $1`,
      [row.id],
    );
    logger.info({ userId: row.userId, clientId: row.clientId, queueId: row.id, attempts: row.attempts }, "oidc.backchannel_logout.retry_delivered");
    return "delivered";
  }

  const errorMessage = result.detail ?? result.reason;
  const attempts = row.attempts + 1;

  if (attempts >= MAX_BACKCHANNEL_LOGOUT_ATTEMPTS) {
    await pool.query(
      `UPDATE ayzen_oidc_backchannel_logout_queue
       SET status = 'dead_letter', attempts = $2, last_error = $3
       WHERE id = $1`,
      [row.id, attempts, errorMessage],
    );
    logger.error(
      { userId: row.userId, clientId: row.clientId, queueId: row.id, attempts, lastError: errorMessage },
      "oidc.backchannel_logout.dead_lettered",
    );
    logBus.error(
      `OIDC Back-Channel Logout: user ${row.userId} -> client "${row.clientId}" gave up after ${attempts}x — dead-lettered: ${errorMessage}`,
    );
    // 6e-d: this is the exact transition CHANGES_..._PHASE6E_C.md's own
    // "what's next" section named ("6e-d's future dashboards/alerting
    // would key off this exact status") — fires once, right here, at the
    // moment a row actually BECOMES dead_letter (never re-fired on
    // subsequent sweeps, since dead_letter is terminal and this branch
    // only runs on the transition into it). Awaited, not void-called: the
    // row's own status update above already committed, so there is
    // nothing left for a slow/failed alert to block — same "await it,
    // let its own internal try/catch swallow failures" shape
    // `lib/dr-test-cron.ts`'s `runScheduledDrTest()` uses for
    // `alertAdminsOfFailure()`.
    await alertAdminsOfDeadLetteredBackchannelLogout(row, attempts, errorMessage).catch((err) => {
      logger.error({ err, queueId: row.id }, "oidc.backchannel_logout.dead_letter_alert_failed");
    });
    return "dead_letter";
  }

  const delay = nextBackchannelLogoutRetryDelayMs(attempts);
  const nextAttemptAt = new Date(Date.now() + delay);
  await pool.query(
    `UPDATE ayzen_oidc_backchannel_logout_queue
     SET status = 'pending', attempts = $2, last_error = $3,
         next_attempt_at = $4,
         locked_at = NULL, locked_by = NULL
     WHERE id = $1`,
    [row.id, attempts, errorMessage, nextAttemptAt],
  );
  logger.warn(
    { userId: row.userId, clientId: row.clientId, queueId: row.id, attempts, retryInMs: delay, lastError: errorMessage },
    "oidc.backchannel_logout.retry_failed",
  );
  logBus.warn(
    `OIDC Back-Channel Logout: user ${row.userId} -> client "${row.clientId}" attempt ${attempts}/${MAX_BACKCHANNEL_LOGOUT_ATTEMPTS} failed, retrying in ~${Math.round(delay / 1000)}s: ${errorMessage}`,
  );
  return "retrying";
}

/** One worker tick: claim a batch, process each row sequentially. Exposed for tests/manual triggering, same as `mail-send-queue.ts`'s `runSendQueueSweep()`. */
export async function runBackchannelLogoutQueueSweep(): Promise<{ claimed: number; delivered: number; retrying: number; deadLettered: number }> {
  await recoverStaleBackchannelLogoutLocks();

  const batch = await claimNextBackchannelLogoutBatch(BACKCHANNEL_LOGOUT_CLAIM_BATCH_SIZE);
  if (!batch.length) return { claimed: 0, delivered: 0, retrying: 0, deadLettered: 0 };

  let delivered = 0, retrying = 0, deadLettered = 0;
  for (const row of batch) {
    const outcome = await processBackchannelLogoutQueueRow(row);
    if (outcome === "delivered") delivered++;
    else if (outcome === "dead_letter") deadLettered++;
    else retrying++;
  }

  logBus.system(`🔁 OIDC Back-Channel Logout retry sweep: ${delivered} delivered, ${retrying} retrying, ${deadLettered} dead-lettered (of ${batch.length} claimed)`);
  return { claimed: batch.length, delivered, retrying, deadLettered };
}

/**
 * Per-tick stale-lock sweep: reclaims any row still 'sending' whose
 * locked_at is older than BACKCHANNEL_LOGOUT_STUCK_TIMEOUT_MS. Mirrors
 * `mail-send-queue.ts`'s `recoverStaleLocks()` exactly, including not
 * bumping `attempts` — this is recovering an interrupted attempt, not
 * counting a new failure.
 */
async function recoverStaleBackchannelLogoutLocks(): Promise<void> {
  const cutoff = new Date(Date.now() - BACKCHANNEL_LOGOUT_STUCK_TIMEOUT_MS);
  const result = await pool.query(
    `UPDATE ayzen_oidc_backchannel_logout_queue
     SET status = 'pending', next_attempt_at = now(), locked_at = NULL, locked_by = NULL
     WHERE status = 'sending' AND locked_at < $1
     RETURNING id`,
    [cutoff],
  );
  const rows = result.rows as { id: number }[];
  if (!rows.length) return;

  logger.warn({ count: rows.length, ids: rows.map((r) => r.id) }, "oidc.backchannel_logout.reclaimed_stale_locks");
  logBus.warn(`OIDC Back-Channel Logout: reclaimed ${rows.length} row(s) stuck in 'sending' past ${BACKCHANNEL_LOGOUT_STUCK_TIMEOUT_MS / 1000}s (worker likely died mid-attempt)`);
}

/**
 * Startup recovery: resets any row left in 'sending' back to 'pending'
 * the instant the worker boots — same "a fresh process is itself the
 * recovery point for whatever its predecessor left mid-attempt" reasoning
 * `mail-send-queue.ts`'s `recoverOnStartup()` uses. Does NOT bump
 * `attempts`.
 */
async function recoverBackchannelLogoutQueueOnStartup(): Promise<void> {
  const result = await pool.query(
    `UPDATE ayzen_oidc_backchannel_logout_queue
     SET status = 'pending', next_attempt_at = now(), locked_at = NULL, locked_by = NULL
     WHERE status = 'sending'
     RETURNING id`,
  );
  const count = (result.rows as { id: number }[]).length;
  if (!count) return;

  logger.warn({ count }, "oidc.backchannel_logout.reset_on_startup");
  logBus.warn(`OIDC Back-Channel Logout: reset ${count} row(s) left in 'sending' on startup — recovering from a previous instance's crash/restart`);
}

let backchannelLogoutQueueScheduled = false;

/**
 * Starts the backchannel-logout retry queue's poll loop. Registered in
 * `index.ts` alongside `startSendQueueWorker()` and every other durable
 * queue/cron this codebase already runs. Default interval (15s) is slower
 * than `mail-send-queue.ts`'s 5s — a delivery retry is not a "hit Send
 * and it goes out" latency-sensitive path the way an outbound email is;
 * `nextBackchannelLogoutRetryDelayMs()`'s own backoff floor (10s) already
 * means nothing is claimable sooner than that anyway.
 */
export function startBackchannelLogoutQueueWorker(): void {
  if (backchannelLogoutQueueScheduled) return; // guard against double-init (e.g. hot reload)
  backchannelLogoutQueueScheduled = true;

  const expr = process.env.OIDC_BACKCHANNEL_LOGOUT_QUEUE_CRON ?? "*/15 * * * * *"; // every 15s
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "OIDC_BACKCHANNEL_LOGOUT_QUEUE_CRON is not a valid cron expression — Back-Channel Logout retry worker disabled");
    logBus.warn(`OIDC Back-Channel Logout retry worker disabled: invalid schedule "${expr}"`);
    return;
  }

  recoverBackchannelLogoutQueueOnStartup().catch((err) => {
    logger.error({ err }, "OIDC Back-Channel Logout retry queue startup recovery failed");
    logBus.error(`OIDC Back-Channel Logout retry queue startup recovery failed: ${err?.message ?? err}`);
  }).finally(() => {
    cron.schedule(expr, () => {
      runBackchannelLogoutQueueSweep().catch((err) => {
        logger.error({ err }, "OIDC Back-Channel Logout retry sweep failed");
        logBus.error(`OIDC Back-Channel Logout retry sweep failed: ${err?.message ?? err}`);
      });
    });

    logBus.system(`✅ OIDC Back-Channel Logout retry worker scheduled ("${expr}")`);
    logger.info({ expr, workerId: BACKCHANNEL_LOGOUT_WORKER_ID }, "OIDC Back-Channel Logout retry worker scheduled");
  });
}

// ─── 6e-d: Monitoring (structured metrics + dashboard read + dead-letter alert) ─
//
// OIDC Roadmap — Season 3, Phase 6e-d: Monitoring. 6e-c's own "what's
// intentionally not here" section named this exactly: "oidc.backchannel_logout.*
// এর জন্য structured metrics/dashboards/alerting (এই পাসে শুধু logger/logBus
// call যোগ হয়েছে, কোনো নতুন observability infrastructure না) — 6e-d
// (Monitoring)." This section is that — nothing above this line changes,
// this only READS the queue table 6e-c already durably writes to.
//
// SHAPE PRECEDENT: `lib/oidc-login-attempts.ts` (Phase 5c-d/5e-a/5e-b/5e-c)
// is the most recent "stats + health-threshold" pair in this roadmap, and
// `routes/admin-oidc-rollout.ts`'s GET handler is its one consumer. This
// section mirrors that exact split — `getBackchannelLogoutQueueStats()` is
// the stats side, `computeBackchannelLogoutQueueHealth()` /
// `evaluateBackchannelLogoutQueueHealth()` is the pure-calculation /
// effectful-wrapper pair `evaluateOidcRolloutHealth()` already establishes
// — but the underlying data source is different on purpose: login attempts
// have no durable table (an in-memory ring buffer is genuinely the right
// tradeoff there, per that file's own "WHY IN-MEMORY, NOT A TABLE" note),
// while the backchannel-logout queue is ALREADY a durable Postgres table
// (migration 087, 6e-c) — so there is no separate in-memory tally to
// maintain here. "Metrics" for this queue just means "query the table
// that's already the source of truth," the same way `routes/admin-wallet.ts`-
// style admin reads elsewhere in this codebase are thin aggregates over an
// existing table, not a parallel counter.
//
// WHY THE HEALTH CHECK ALSO WATCHES PENDING BACKLOG AGE, NOT JUST
// dead_letter COUNT: a dead_letter row means "we tried and gave up" — a
// real per-target failure. But a worker that silently stopped ticking
// (`startBackchannelLogoutQueueWorker()` never got called, or a deploy
// dropped the cron) would produce ZERO dead_letter rows — every row would
// just sit in 'pending' forever, looking identical to "queue is empty and
// healthy" unless something inspects HOW LONG the oldest pending row has
// been waiting. This is the exact "silence looks like nothing to report"
// gap `lib/vault-backup-alerts.ts`'s own `alertUserOfMissedBackup()` header
// describes for its own watchdog case — same shape, applied to this queue.

/** How far back the dead-letter COUNT and sample list look by default — the "recent" window, not the queue's full lifetime history. Same order of magnitude as `oidc-login-attempts.ts`'s `DEFAULT_STATS_WINDOW_MS`, widened somewhat since a logout dead-letter is a rarer, lower-volume event than a login attempt. */
export const DEFAULT_BACKCHANNEL_LOGOUT_STATS_WINDOW_MS = 60 * 60_000; // 1h

/** Cap on how many recent dead-letter rows `getBackchannelLogoutQueueStats()` returns inline — enough for an operator to see what's actually failing without the admin response growing unbounded on a bad day. Same role `oidc-login-attempts.ts`'s `MAX_TOP_ERRORS` plays for its own response. */
const MAX_DEAD_LETTER_SAMPLES = 20;

export interface BackchannelLogoutQueueStatusCounts {
  pending: number;
  sending: number;
  delivered: number;
  deadLetter: number;
}

export interface BackchannelLogoutDeadLetterSample {
  id: number;
  userId: number;
  clientId: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
}

export interface BackchannelLogoutQueueStats {
  windowMs: number;
  /** Rows CREATED within the window, bucketed by their CURRENT status — mirrors `getOidcLoginAttemptStats()`'s own "since" framing, just against a durable table instead of an in-memory log. */
  countsInWindow: BackchannelLogoutQueueStatusCounts;
  /** All-time counts, unwindowed — lets a caller tell "nothing happening" apart from "the window is just narrow"; `oidc-login-attempts.ts` has no equivalent of this because it has no all-time store to ask. */
  countsAllTime: BackchannelLogoutQueueStatusCounts;
  /** Age (ms) of the longest-waiting row still in 'pending', or `null` when nothing is pending. This is the one number `evaluateBackchannelLogoutQueueHealth()`'s backlog check keys off — see section header's own "WHY THE HEALTH CHECK ALSO WATCHES PENDING BACKLOG AGE" note. */
  oldestPendingAgeMs: number | null;
  /** Most recent dead-lettered rows within the window, most recent first, capped at `MAX_DEAD_LETTER_SAMPLES` — the "what's actually failing" detail a count alone can't show. */
  recentDeadLetters: BackchannelLogoutDeadLetterSample[];
}

function emptyStatusCounts(): BackchannelLogoutQueueStatusCounts {
  return { pending: 0, sending: 0, delivered: 0, deadLetter: 0 };
}

function statusCountsFromRows(rows: Array<{ status: string; count: string }>): BackchannelLogoutQueueStatusCounts {
  const counts = emptyStatusCounts();
  for (const row of rows) {
    const n = Number(row.count) || 0;
    if (row.status === "pending") counts.pending = n;
    else if (row.status === "sending") counts.sending = n;
    else if (row.status === "delivered") counts.delivered = n;
    else if (row.status === "dead_letter") counts.deadLetter = n;
  }
  return counts;
}

/**
 * 6e-d: reads current queue state straight from `ayzen_oidc_backchannel_logout_queue`
 * — four small queries (windowed counts, all-time counts, oldest-pending
 * age, recent dead-letter samples), same raw `pool` this file's own queue
 * code already uses throughout (see `claimNextBackchannelLogoutBatch()`'s
 * own comment on why `pool` rather than drizzle `db` here). Read-only,
 * never called from any hot path — this is `routes/admin-oidc-backchannel-logout.ts`'s
 * one data source, same "route calls the lib function fresh on every GET,
 * nothing cached" shape `routes/admin-oidc-rollout.ts` already uses for
 * `getOidcLoginAttemptStats()`.
 */
export async function getBackchannelLogoutQueueStats(
  windowMs: number = DEFAULT_BACKCHANNEL_LOGOUT_STATS_WINDOW_MS,
): Promise<BackchannelLogoutQueueStats> {
  const since = new Date(Date.now() - windowMs);

  const [windowResult, allTimeResult, oldestPendingResult, deadLetterResult] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::text AS count FROM ayzen_oidc_backchannel_logout_queue
       WHERE created_at >= $1 GROUP BY status`,
      [since],
    ),
    pool.query(
      `SELECT status, COUNT(*)::text AS count FROM ayzen_oidc_backchannel_logout_queue GROUP BY status`,
    ),
    pool.query(
      `SELECT MIN(created_at) AS oldest FROM ayzen_oidc_backchannel_logout_queue WHERE status = 'pending'`,
    ),
    pool.query(
      `SELECT id, user_id, client_id, attempts, last_error, created_at
       FROM ayzen_oidc_backchannel_logout_queue
       WHERE status = 'dead_letter' AND created_at >= $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [since, MAX_DEAD_LETTER_SAMPLES],
    ),
  ]);

  const oldest: Date | null = oldestPendingResult.rows[0]?.oldest ?? null;

  return {
    windowMs,
    countsInWindow: statusCountsFromRows(windowResult.rows),
    countsAllTime: statusCountsFromRows(allTimeResult.rows),
    oldestPendingAgeMs: oldest ? Date.now() - new Date(oldest).getTime() : null,
    recentDeadLetters: (deadLetterResult.rows as any[]).map((r) => ({
      id: r.id,
      userId: r.user_id,
      clientId: r.client_id,
      attempts: r.attempts,
      lastError: r.last_error,
      createdAt: r.created_at,
    })),
  };
}

// ── 6e-d: Alert Thresholds — same "two plain numbers, not a rules engine" ──
// discipline `oidc-login-attempts.ts`'s own Alert Thresholds section
// documents for why it isn't more elaborate than this.

export interface BackchannelLogoutQueueHealthThresholds {
  /** More than this many dead-lettered rows within the stats window reports unhealthy. */
  maxDeadLettersInWindow: number;
  /** A pending row waiting longer than this (ms) reports unhealthy — see section header's own note on why this catches a stalled/never-started worker that produces zero dead_letter rows. Default (10m) is comfortably above the worker's own backoff ceiling (`BACKCHANNEL_LOGOUT_BACKOFF_MAX_MS`, 30m) is deliberately NOT used here — a single row legitimately backing off can sit pending for up to 30m on its own; this threshold is instead sized off the poll INTERVAL (15s) plus generous slack, since a healthy worker claims a due 'pending' row within one tick of `next_attempt_at`, not within a full backoff cycle. */
  maxPendingBacklogAgeMs: number;
}

/** 6e-d's own defaults — same "starting point, not a claim of correctness for every deployment" framing `DEFAULT_OIDC_ROLLOUT_HEALTH_THRESHOLDS` already carries. */
export const DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS: BackchannelLogoutQueueHealthThresholds = {
  maxDeadLettersInWindow: 5,
  maxPendingBacklogAgeMs: 10 * 60_000, // 10m
};

export interface BackchannelLogoutQueueHealthResult {
  healthy: boolean;
  /** Empty when `healthy` is true — one entry per threshold actually crossed, same "don't just report the first one" shape `OidcRolloutHealthResult.reasons` already uses. */
  reasons: string[];
  thresholds: BackchannelLogoutQueueHealthThresholds;
  /** Echoes the exact stats the decision was made from — same "never make the caller re-fetch to see what tripped it" discipline `OidcRolloutHealthResult.stats` already follows. */
  stats: BackchannelLogoutQueueStats;
}

/**
 * 6e-d: pure threshold check over an already-fetched `BackchannelLogoutQueueStats`
 * — deliberately split from `evaluateBackchannelLogoutQueueHealth()` below
 * the same way `buildLogoutTokenClaims()`/`nextBackchannelLogoutRetryDelayMs()`
 * are split from their own effectful callers elsewhere in this file, so
 * `scripts/src/test-oidc-backchannel-logout-monitoring.ts` can assert the
 * threshold logic against hand-built stats without touching a live DB.
 */
export function computeBackchannelLogoutQueueHealth(
  stats: BackchannelLogoutQueueStats,
  thresholds: BackchannelLogoutQueueHealthThresholds = DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS,
): BackchannelLogoutQueueHealthResult {
  const reasons: string[] = [];

  if (stats.countsInWindow.deadLetter > thresholds.maxDeadLettersInWindow) {
    reasons.push(
      `${stats.countsInWindow.deadLetter} row(s) dead-lettered in the last ${Math.round(stats.windowMs / 60_000)}m, exceeding the threshold of ${thresholds.maxDeadLettersInWindow}`,
    );
  }

  if (stats.oldestPendingAgeMs !== null && stats.oldestPendingAgeMs > thresholds.maxPendingBacklogAgeMs) {
    reasons.push(
      `oldest pending row has been waiting ${Math.round(stats.oldestPendingAgeMs / 1000)}s, exceeding the backlog threshold of ${Math.round(thresholds.maxPendingBacklogAgeMs / 1000)}s — the retry worker may not be running`,
    );
  }

  return { healthy: reasons.length === 0, reasons, thresholds, stats };
}

/**
 * 6e-d: effectful wrapper — fetches fresh stats, then applies
 * `computeBackchannelLogoutQueueHealth()`. `routes/admin-oidc-backchannel-logout.ts`'s
 * one caller, same "route calls straight through, no caching" shape
 * `routes/admin-oidc-rollout.ts` already uses for `evaluateOidcRolloutHealth()`.
 * Never writes anything, never pages/alerts anyone by itself — same SCOPE
 * DISCIPLINE `evaluateOidcRolloutHealth()`'s own file header states:
 * reporting is not the same thing as acting.
 */
export async function evaluateBackchannelLogoutQueueHealth(
  windowMs: number = DEFAULT_BACKCHANNEL_LOGOUT_STATS_WINDOW_MS,
  thresholds: BackchannelLogoutQueueHealthThresholds = DEFAULT_BACKCHANNEL_LOGOUT_HEALTH_THRESHOLDS,
): Promise<BackchannelLogoutQueueHealthResult> {
  const stats = await getBackchannelLogoutQueueStats(windowMs);
  return computeBackchannelLogoutQueueHealth(stats, thresholds);
}

/**
 * 6e-d: the "actionable alert" CHANGES_..._PHASE6E_C.md's own "what's next"
 * section named for the `dead_letter` transition specifically. Fires once,
 * from `processBackchannelLogoutQueueRow()`'s dead_letter branch above, the
 * moment a row actually becomes dead-lettered. Same admin-broadcast shape
 * `lib/dr-test-cron.ts`'s `alertAdminsOfFailure()` and
 * `lib/vault-backup-alerts.ts`'s `alertAdminsOfStaleKeyRotation()` already
 * use: query every `role = 'admin'` user via drizzle `db` (not the raw
 * `pool` the rest of this file's queue code uses — this one lookup is
 * against `usersTable`, not the queue table, so it follows THAT table's
 * own established access pattern instead), email each one independently,
 * and never let one admin's bounced email stop the rest or bubble up to
 * the caller.
 */
async function alertAdminsOfDeadLetteredBackchannelLogout(
  row: BackchannelLogoutQueueRow,
  attempts: number,
  lastError: string,
): Promise<void> {
  const admins = await db.select({ email: usersTable.email }).from(usersTable).where(eq(usersTable.role, "admin"));
  const subject = `⚠️ AYZEN — OIDC Back-Channel Logout dead-lettered (user ${row.userId} → ${row.clientId})`;
  const html = `
    <p>A Back-Channel Logout notification to <b>${row.clientId}</b> for user
       <b>${row.userId}</b> gave up after <b>${attempts}</b> attempt(s) and has
       been dead-lettered.</p>
    <p><b>Last error:</b> ${lastError}</p>
    <p><b>Target URI:</b> <code>${row.backchannelLogoutUri}</code></p>
    <p>This means that user's session on <b>${row.clientId}</b> may still be
       active even though it was revoked on AYZEN Central — the client never
       confirmed the logout. This does not retry further automatically; see
       <code>GET /api/admin/oidc-backchannel-logout/status</code> for the
       current queue state, and confirm the target's
       <code>backchannel_logout_uri</code>/reachability before treating this
       as resolved.</p>
  `;
  for (const admin of admins) {
    if (!admin.email) continue;
    try {
      await sendEmail({
        to: admin.email,
        subject,
        html,
        text: `OIDC Back-Channel Logout dead-lettered: user ${row.userId} -> client "${row.clientId}" after ${attempts} attempt(s). Last error: ${lastError}. Target: ${row.backchannelLogoutUri}`,
      });
    } catch (err: any) {
      // Same discipline as alertAdminsOfFailure()/alertAdminsOfStaleKeyRotation():
      // one admin's bounced email must never block sending to the rest, and
      // must never surface as a failure of the dead-letter transition itself
      // (that DB write already committed before this function was called).
      logger.warn({ err, admin: admin.email, queueId: row.id }, "oidc.backchannel_logout.dead_letter_alert_email_failed");
    }
  }
}
