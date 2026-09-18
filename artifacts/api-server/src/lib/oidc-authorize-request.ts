/**
 * lib/oidc-authorize-request.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 2, Phase 3a: Authorization Request Validation.
 *
 * This is the first file in the roadmap that assembles a request to
 * `/oidc/authorize` itself, rather than one piece of client/redirect/scope
 * data in isolation. It composes:
 *   - `validateOidcClientRequest()`  (2E-a, ./oidc-client-request-validation)
 *     — client_id + redirect_uri + scope, unchanged from Phase 2.
 * and adds the request-shape checks Phase 2 deliberately left out (every
 * 2C/2D/2E file header says "nothing here validates response_type/state/
 * nonce/PKCE — that's Phase 3's job"):
 *   - 3a-a: Request Parser
 *   - 3a-c: Response-Type Validation
 *   - 3a-d: State Validation
 *   - 3a-e: Nonce Validation
 *   - 3a-f: PKCE Parameter Validation
 *   - 3a-g: Authorization Error Contract
 *
 * Scope discipline (this is 3a, not 3b/3c/3d):
 *   - Validates the REQUEST only. No session/login detection (3b-a), no
 *     authorization-code generation or persistence (3b-d/3b-e), no
 *     redirect-with-code callback (3b-f) — this file only decides whether
 *     the incoming request is well-formed enough to proceed to those
 *     later steps, and never gets there itself.
 *   - No PKCE *verifier* checking (`code_verifier`, the token-endpoint
 *     side) — that is Phase 3d. This file validates only the
 *     authorization-request-time PKCE parameters (`code_challenge`,
 *     `code_challenge_method`), per 3a-f's own wording ("required PKCE
 *     behavior" at the *request* stage, not the exchange stage).
 *   - Does not touch `lib/oidc-discovery.ts`. That file's `1E-d` header
 *     explicitly deferred `authorization_endpoint` until "Phase 3/4"
 *     builds the route; this sub-phase is request *validation*, not the
 *     route itself (that's paired in `routes/oidc-authorize.ts`) — whether
 *     discovery should now advertise `authorization_endpoint` is left as a
 *     follow-up note in this phase's CHANGES doc rather than acted on
 *     here, to keep this sub-phase's diff to what 3a-a..3a-g actually ask
 *     for.
 *
 * ORDER OF CHECKS
 * `client_id` presence, then `redirect_uri` presence, then the full
 * `validateOidcClientRequest()` (client -> redirect_uri -> scope, in that
 * order, per 2E's own fail-fast rationale) all happen BEFORE
 * response_type/state/PKCE are looked at — for the identical reason
 * `oidc-client-validation.ts`'s header already documents: until the
 * server knows WHICH client is asking and WHERE it's allowed to redirect
 * back to, it is not safe to redirect the user-agent anywhere, including
 * to report a bad response_type/state/PKCE parameter. Once client +
 * redirect_uri + scope are all verified, every remaining failure in this
 * file IS safe to report via a redirect back to that verified
 * `redirect_uri` (with `?error=...&state=...`, per the roadmap's global
 * error model, section 4) — see the `redirectable` field on
 * `OidcAuthorizeRequestValidationResult` below.
 *
 * SPLIT: DB-DEPENDENT ENTRYPOINT vs. PURE COMPOSITION
 * Same split every prior OIDC lib file in this roadmap uses
 * (`lib/jwt-keys.ts`, `oidc-client-request-validation.ts`, ...):
 *   - `validateOidcAuthorizeRequestForClient(clientRequest, raw)` is
 *     PURE — takes an already-resolved `{ client, redirectUri, scopes }`
 *     (2E-a's success shape) plus the parsed raw request, so 3a-h's tests
 *     can exercise every response_type/state/nonce/PKCE combination
 *     without a database.
 *   - `validateOidcAuthorizeRequest(raw)` is the public, DB-touching
 *     entrypoint: it runs `validateOidcClientRequest()` (the one DB call
 *     in this composition) and, only on success, delegates to the pure
 *     function above.
 */

import {
  validateOidcClientRequest,
  type OidcClientRequestValidationResult,
} from "./oidc-client-request-validation";
import type { OidcClient } from "./oidc-clients";
import { logger } from "./logger";

/**
 * 3a-a: Request Parser — the raw, unvalidated shape of an `/oidc/authorize`
 * request's query parameters. Every field is `string | undefined` (never
 * `null`, never an array) — the caller (`routes/oidc-authorize.ts`) is
 * responsible for handing this function already-deduplicated query values;
 * `firstQueryValue()` below defends against an array/non-string sneaking
 * in anyway (e.g. this function being unit-tested directly, or called from
 * a context that hasn't run `middlewares/security.ts`'s `dedupeQueryParams`)
 * so this parser has no hidden dependency on that middleware having run.
 */
export interface RawOidcAuthorizeRequest {
  clientId: string | undefined;
  redirectUri: string | undefined;
  responseType: string | undefined;
  scope: string | undefined;
  state: string | undefined;
  nonce: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
}

/**
 * Normalizes one query-parameter value (Express's `req.query[key]`, which
 * can legally be `string | ParsedQs | (string | ParsedQs)[] | undefined`)
 * down to `string | undefined`: a single string passes through unchanged
 * (empty string treated as absent), an array picks its first string entry
 * (matching this codebase's general "duplicate query key" handling
 * elsewhere is last-wins, but a *parser* has no way to know intent from an
 * array alone — first-string-or-undefined is the conservative, doesn't-
 * silently-prefer-an-attacker-appended-duplicate choice), and anything
 * else (a nested object, `ParsedQs`) is treated as absent rather than
 * coerced/stringified.
 */
function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    const first = value.find((v): v is string => typeof v === "string" && v.length > 0);
    return first;
  }
  return undefined;
}

/**
 * 3a-a: Request Parser.
 *
 * Pure, DB-free, throws nothing — an absent/malformed query object simply
 * parses to every field `undefined`, letting the validation checks below
 * report the specific missing/invalid parameter rather than this function
 * failing loudly on a shape it doesn't recognize.
 */
export function parseOidcAuthorizeRequest(query: Record<string, unknown> | null | undefined): RawOidcAuthorizeRequest {
  const q = query ?? {};
  return {
    clientId: firstQueryValue(q.client_id),
    redirectUri: firstQueryValue(q.redirect_uri),
    responseType: firstQueryValue(q.response_type),
    scope: firstQueryValue(q.scope),
    state: firstQueryValue(q.state),
    nonce: firstQueryValue(q.nonce),
    codeChallenge: firstQueryValue(q.code_challenge),
    codeChallengeMethod: firstQueryValue(q.code_challenge_method),
  };
}

/**
 * 3a-f: PKCE Parameter Validation — `code_challenge` format.
 *
 * RFC 7636 §4.2: the code challenge is the base64url encoding (no padding)
 * of a SHA-256 digest when `code_challenge_method=S256` (the only method
 * this provider accepts — see below), which is always exactly 43
 * characters. RFC 7636 §4.1 additionally bounds any `code_verifier` (and
 * therefore, transitively, what a spec-compliant `code_challenge` can look
 * like) to 43-128 characters drawn from `[A-Za-z0-9\-._~]`; since this
 * provider only accepts `S256`, a *valid* challenge is always exactly the
 * 43-character unpadded-base64url alphabet `[A-Za-z0-9\-_]`. Accepting the
 * full 43-128 range here (rather than hard-coding 43) costs nothing and
 * avoids this file silently assuming its own single-method policy in two
 * places if a future phase ever widens `code_challenge_method`.
 */
const CODE_CHALLENGE_FORMAT = /^[A-Za-z0-9\-_]{43,128}$/;

function isWellFormedCodeChallenge(value: string): boolean {
  return CODE_CHALLENGE_FORMAT.test(value);
}

/**
 * 3a-f: the only `code_challenge_method` this provider accepts.
 * `"plain"` (RFC 7636's other defined method, and its default when the
 * parameter is omitted) is deliberately never accepted: `plain` sends the
 * verifier itself as the challenge, which defeats PKCE's protection
 * against a stolen authorization code entirely. Per 3a-f's task wording
 * ("supported code_challenge_method") and the roadmap's Authorization
 * Code security review (section 3.4: codes must be "bound to PKCE
 * challenge"), a binding that can be trivially replayed is not a binding.
 * `code_challenge_method` is therefore REQUIRED and must be exactly
 * `"S256"` — never defaulted to `"plain"` the way a spec-literal RFC 7636
 * implementation would for a request that omits it.
 */
const REQUIRED_CODE_CHALLENGE_METHOD = "S256";

/** 3a-c: the only `response_type` this provider ever plans to support — see `lib/oidc-discovery.ts`'s `RESPONSE_TYPES_SUPPORTED` (Phase 1E-d), which already declares only `"code"`. Implicit/hybrid are out of scope entirely, not just "not yet". */
const SUPPORTED_RESPONSE_TYPE = "code";

/**
 * 3a-g: Authorization Error Contract.
 *
 * A direct extension of 2E-b's `OidcClientRequestValidationResult` union:
 * `invalid_client` / `invalid_redirect_uri` keep 2C's non-redirectable
 * treatment unchanged (`redirectable: false` — there is no verified
 * redirect target yet, so these must be rendered directly, never used to
 * build a redirect URL; see `oidc-client-validation.ts`'s header for the
 * open-redirect rationale). Every other failure below happens only AFTER
 * `validateOidcClientRequest()` has already verified client + redirect_uri
 * + scope, so each carries the now-verified `redirectUri` and is safely
 * `redirectable: true` — the roadmap's global error model (section 4) says
 * such failures report back to the client via `?error=...` on that
 * redirect_uri, which is exactly what `routes/oidc-authorize.ts` does with
 * this field.
 *
 * `invalid_request`'s `reason` is, like 2D's `unknown_scope` /
 * `disallowed_scope` split, an internal-only detail alongside the one
 * public OAuth code the global error model actually defines
 * (`invalid_request` covers "missing required parameter" / "malformed
 * parameter" generically per RFC 6749 §4.1.2.1 — there is no more specific
 * standard code for "your state is missing" or "your code_challenge is
 * the wrong shape").
 */
export type OidcAuthorizeRequestValidationResult =
  | {
      ok: true;
      client: OidcClient;
      redirectUri: string;
      scopes: string[];
      responseType: "code";
      /** Present because 3a-d requires it — never undefined in a success result. */
      state: string;
      /** 3a-e: accepted as-provided; `null` when the (optional) request omitted it. Persisting this binding is Phase 3b's job — this file only carries it through. */
      nonce: string | null;
      codeChallenge: string;
      codeChallengeMethod: "S256";
    }
  | { ok: false; redirectable: false; error: "invalid_client" }
  | { ok: false; redirectable: false; error: "invalid_redirect_uri" }
  | {
      ok: false;
      redirectable: true;
      redirectUri: string;
      error: "invalid_scope";
      reason: "unknown_scope" | "disallowed_scope";
      scope: string;
    }
  | { ok: false; redirectable: true; redirectUri: string; error: "unsupported_response_type" }
  | {
      ok: false;
      redirectable: true;
      redirectUri: string;
      error: "invalid_request";
      reason: "missing_state" | "missing_code_challenge" | "malformed_code_challenge" | "missing_code_challenge_method" | "unsupported_code_challenge_method";
    };

/**
 * Pure composition — see file header. Takes an already-resolved client +
 * verified redirect_uri + verified scopes (2E-a's success shape) plus the
 * parsed raw request, and runs 3a-c/3a-d/3a-e/3a-f in the order the
 * roadmap lists them. No DB access, no async.
 */
export function validateOidcAuthorizeRequestForClient(
  clientRequest: { client: OidcClient; redirectUri: string; scopes: string[] },
  raw: RawOidcAuthorizeRequest,
): OidcAuthorizeRequestValidationResult {
  const { client, redirectUri, scopes } = clientRequest;

  // 3a-c — Response-Type Validation. Only "code" is ever supported (see
  // SUPPORTED_RESPONSE_TYPE's doc comment) — a missing response_type is
  // rejected the same way as any other unsupported value, not treated as
  // "assume code".
  if (raw.responseType !== SUPPORTED_RESPONSE_TYPE) {
    logger.warn(
      { clientId: client.clientId, responseType: raw.responseType },
      "[oidc-authorize-request] unsupported (or missing) response_type rejected",
    );
    return { ok: false, redirectable: true, redirectUri, error: "unsupported_response_type" };
  }

  // 3a-d — State Validation. "Require/preserve state for the first-party
  // flow": every first-party client in this roadmap's scope is expected to
  // send one (CSRF protection for the redirect back from this endpoint),
  // so it is required here, not merely echoed back if present. This layer
  // only checks presence/non-emptiness — state is an opaque value from
  // this provider's point of view; it is preserved verbatim, never parsed
  // or interpreted.
  if (!raw.state) {
    logger.warn({ clientId: client.clientId }, "[oidc-authorize-request] missing state rejected");
    return { ok: false, redirectable: true, redirectUri, error: "invalid_request", reason: "missing_state" };
  }

  // 3a-e — Nonce Validation. Optional per OIDC Core 1.0 §3.1.2.1 for the
  // Authorization Code flow (only implicit/hybrid flows require it, and
  // this provider never supports those — see SUPPORTED_RESPONSE_TYPE).
  // "Accept and persist nonce binding": accepting is this file's job;
  // persisting the binding onto an issued authorization code is Phase
  // 3b-e's job. There is no failure case here — an absent nonce is valid,
  // not an error — so this step never returns early.
  const nonce = raw.nonce ?? null;

  // 3a-f — PKCE Parameter Validation.
  if (!raw.codeChallenge) {
    logger.warn({ clientId: client.clientId }, "[oidc-authorize-request] missing code_challenge rejected");
    return { ok: false, redirectable: true, redirectUri, error: "invalid_request", reason: "missing_code_challenge" };
  }
  if (!isWellFormedCodeChallenge(raw.codeChallenge)) {
    logger.warn({ clientId: client.clientId }, "[oidc-authorize-request] malformed code_challenge rejected");
    return { ok: false, redirectable: true, redirectUri, error: "invalid_request", reason: "malformed_code_challenge" };
  }
  if (!raw.codeChallengeMethod) {
    logger.warn({ clientId: client.clientId }, "[oidc-authorize-request] missing code_challenge_method rejected");
    return { ok: false, redirectable: true, redirectUri, error: "invalid_request", reason: "missing_code_challenge_method" };
  }
  if (raw.codeChallengeMethod !== REQUIRED_CODE_CHALLENGE_METHOD) {
    logger.warn(
      { clientId: client.clientId, codeChallengeMethod: raw.codeChallengeMethod },
      "[oidc-authorize-request] unsupported code_challenge_method rejected",
    );
    return {
      ok: false,
      redirectable: true,
      redirectUri,
      error: "invalid_request",
      reason: "unsupported_code_challenge_method",
    };
  }

  return {
    ok: true,
    client,
    redirectUri,
    scopes,
    responseType: "code",
    state: raw.state,
    nonce,
    codeChallenge: raw.codeChallenge,
    codeChallengeMethod: "S256",
  };
}

/**
 * Maps a failing `OidcClientRequestValidationResult` (2E-b's shape) onto
 * this file's result union, attaching the `redirectable` field 2E's own
 * shape doesn't carry (2E-c's worked example switches on `invalid_client`
 * / `invalid_redirect_uri` / `invalid_scope` directly — this file is the
 * first caller that actually needs to know which of those is safe to
 * redirect on, so that distinction is made explicit here rather than
 * pushed back into 2E's file, which has no route to reason about yet).
 */
function fromClientRequestFailure(
  result: Extract<OidcClientRequestValidationResult, { ok: false }>,
  redirectUri: string,
): OidcAuthorizeRequestValidationResult {
  if (result.error === "invalid_scope") {
    return { ok: false, redirectable: true, redirectUri, error: "invalid_scope", reason: result.reason, scope: result.scope };
  }
  // "invalid_client" — no verified redirect target exists at all.
  // "invalid_redirect_uri" — the caller-supplied redirect_uri specifically
  // is what failed, so it is never reused to build a redirect either.
  return { ok: false, redirectable: false, error: result.error };
}

/**
 * 3a-b + entrypoint: the public, DB-touching `/oidc/authorize` request
 * validator. Runs `validateOidcClientRequest()` (2E-a — the one DB call in
 * this whole composition) and, only on success, delegates to the pure
 * function above for 3a-c..3a-f.
 *
 * `client_id`/`redirect_uri` presence is checked here, before
 * `validateOidcClientRequest()` is even called: that function already
 * treats an empty/missing `redirect_uri` as "no match" (`invalid_redirect_uri`,
 * see `validateOidcRedirectUri()`), and `getOidcClientById()` already
 * treats an empty/missing `client_id` as "not found" (`invalid_client`) —
 * so these two guards are not new validation logic, only an explicit,
 * cheap short-circuit that avoids a wasted DB round-trip for the most
 * common malformed request (a client that forgot a required query
 * parameter entirely).
 */
export async function validateOidcAuthorizeRequest(
  raw: RawOidcAuthorizeRequest,
): Promise<OidcAuthorizeRequestValidationResult> {
  if (!raw.clientId) {
    logger.warn({}, "[oidc-authorize-request] missing client_id rejected");
    return { ok: false, redirectable: false, error: "invalid_client" };
  }
  if (!raw.redirectUri) {
    logger.warn({ clientId: raw.clientId }, "[oidc-authorize-request] missing redirect_uri rejected");
    return { ok: false, redirectable: false, error: "invalid_redirect_uri" };
  }

  const clientResult = await validateOidcClientRequest(raw.clientId, raw.redirectUri, raw.scope);
  if (!clientResult.ok) {
    return fromClientRequestFailure(clientResult, raw.redirectUri);
  }

  return validateOidcAuthorizeRequestForClient(clientResult, raw);
}
