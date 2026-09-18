/**
 * lib/oidc-dynamic-client-redirect-uri-policy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 4, Phase 8d: Redirect URI নীতি (dynamically
 * registered client-এর জন্য কড়া).
 *
 * A first-party client's `redirect_uris` are set by AYZEN itself (an admin
 * migration/seed today, Phase 9's admin UI later) — `validateOidcRedirectUri()`
 * (`lib/oidc-client-validation.ts`, Season 1 Phase 2C) already does the one
 * thing that context needs: exact-match against whatever was registered, no
 * opinion on WHAT was registered. A dynamically-registered client
 * (Phase 8a — `POST /oidc/register`, bare-origin, unauthenticated, anyone on
 * the internet) is a different trust context: nobody at AYZEN reviewed what
 * gets submitted, so the submission itself needs a content policy on top of
 * "well-formed URL," not just at the point of exact-match comparison later.
 *
 * This is that content policy — a pure, DB-free predicate, deliberately
 * separate from `oidc-client-validation.ts`'s exact-match check (a different
 * question: "is this URI a SHAPE we'll ever accept from a self-registering
 * client" vs. "does this specific request's redirect_uri match what THIS
 * client already registered"). Two callers use it:
 *   - `lib/oidc-client-registration-request.ts`'s `validateRedirectUris()`
 *     (Phase 8a's own request validation, now hardened by this phase) — at
 *     `POST /oidc/register` time, every submitted `redirect_uris` entry.
 *   - The same file's `validateOidcClientRegistrationUpdateRequest()`
 *     (Phase 8e) — at `PUT /oidc/register/:client_id` time. Enforcing this
 *     only at creation and not at self-managed update would make 8d
 *     cosmetic: a client could register a compliant redirect_uri, get
 *     approved, then PUT its way to a wildcard/fragment/path-traversal one
 *     afterward.
 *
 * The roadmap names exactly three rules, all enforced below:
 *   1. `https://` required — except a localhost dev exception (below).
 *   2. No wildcard or path-traversal pattern.
 *   3. No fragment.
 *
 * WHY A LOCALHOST DEV EXCEPTION EXISTS AT ALL: the roadmap's own text
 * carves this out explicitly ("লোকালহোস্ট dev exception বাদে") — a
 * third-party developer building against a locally-running OIDC client
 * during development has no way to get a real TLS certificate for
 * `localhost`, and requiring one would make local development against this
 * provider impractical. This is the same shape of trade-off Phase 2A-d's
 * own seeded first-party test fixtures already accept for
 * `http://localhost:5173/oidc/callback` (see `scripts/src/seed-oidc-clients.ts`)
 * — a first-party dev client already gets this exception implicitly today
 * because 2C's exact-match check never restricted SCHEME at all. This file
 * is the first place that restriction is introduced, and it deliberately
 * preserves the pre-existing dev workflow rather than breaking it.
 *
 * WHY THIS DOESN'T DEFINE ITS OWN ERROR CODE OR RESULT SHAPE: unlike
 * `oidc-client-validation.ts`'s `invalid_redirect_uri` vs `invalid_client`
 * split (which exists because ONE of those two must never trigger a
 * redirect — see that file's own header), a redirect_uri failing 8d's
 * policy at REGISTRATION time never redirects anyone anywhere; it's a
 * direct JSON `400` on `POST/PUT /oidc/register*`. So this function is a
 * plain boolean predicate — the caller already owns a richer
 * `{ error, field }` result shape (`OidcClientRegistrationValidationResult`)
 * and just needs one more yes/no input to it, not a second parallel error
 * taxonomy.
 */

/**
 * Hostnames treated as "local machine" for the dev exception — the three
 * common ways a browser/OS resolves "this machine" today. Deliberately NOT
 * a broader check (e.g. any `*.localhost` suffix, any RFC 1918 private IP)
 * — widening this later is easy and low-risk; narrowing a shipped exception
 * after third parties depend on it is not, so this starts as small as the
 * roadmap's own wording ("লোকালহোস্ট") supports.
 */
const LOCAL_DEV_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * 8d: does this ALREADY-a-well-formed-URL string satisfy the stricter
 * policy a dynamically-registered client's `redirect_uris` must meet?
 *
 * Callers are expected to have already confirmed `uri` parses as a URL at
 * all (`lib/oidc-client-registration-request.ts` already does this as a
 * separate, prior check, same "malformed URL" failure it had before 8d
 * existed) — this function re-parses defensively anyway (never throws) so
 * it's safe to call standalone, e.g. directly from this file's own test
 * suite, without relying on a caller's ordering.
 */
export function isDynamicClientRedirectUriAllowed(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }

  // Rule 3 — no fragment. A fragment is never sent to the server by a
  // browser in the first place (RFC 6749 §3.1.2 already relies on this for
  // the implicit grant's own token-in-fragment convention elsewhere), so a
  // REGISTERED redirect_uri containing one is never meaningful for the
  // Authorization Code flow this provider implements — only ever a sign of
  // a copy-paste mistake or an attempt to smuggle extra client-side-only
  // state past this validator. Checking `parsed.hash` (not a raw
  // `uri.includes("#")`) means this is scheme/parse-aware, not a blind
  // substring check.
  if (parsed.hash !== "") return false;

  // Rule 2a — no wildcard pattern. This provider's redirect_uri matching
  // (`validateOidcRedirectUri()`, Phase 2C) is, and always will be, exact-
  // string matching — there is no glob/wildcard EXPANSION anywhere in this
  // codebase's redirect_uri handling. A `*` character in a submitted URI is
  // therefore never functionally a wildcard here; its only purpose could be
  // to mislead a human reviewer (Phase 9d's future admin approval screen)
  // into believing this client's callback is broader than the literal
  // string that will actually be matched. Rejecting it at registration time
  // removes that confusion instead of relying on every future reviewer to
  // notice.
  if (uri.includes("*")) return false;

  // Rule 2b — no path-traversal pattern. `URL` already normalizes `..`
  // segments out of `pathname` during parsing in most cases, but this
  // checks the ORIGINAL raw string, not the parsed/normalized one — the
  // concern isn't "will this URI resolve somewhere unexpected when a
  // browser navigates it" (parsing already prevents that), it's "does this
  // submission contain a pattern that has no legitimate reason to appear in
  // a callback URL a client is registering," the same reviewer-facing
  // reasoning as the wildcard check above.
  if (uri.includes("..")) return false;

  // Rule 1 — https required, localhost dev exception.
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:" && LOCAL_DEV_HOSTNAMES.has(parsed.hostname)) return true;
  return false;
}
