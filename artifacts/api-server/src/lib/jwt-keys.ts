/**
 * lib/jwt-keys.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 1, Phase 1A (Crypto Foundation, part A)
 *
 * Resolves the RSA keypair `lib/jwt.ts` uses to sign/verify session tokens
 * with RS256 instead of the old HS256 shared secret. This file only deals in
 * ONE active keypair — key rotation, multiple retained public keys, and the
 * JWKS/discovery HTTP endpoints that publish them are Phase 1B, on top of
 * this foundation.
 *
 * WHY RS256 (asymmetric) INSTEAD OF HS256 (shared secret)
 * HS256 needs the exact same secret to sign AND verify — so any service that
 * should be able to *check* a token also has the power to *forge* one. That
 * was fine while every AYZEN "sub-app" was really just a route in the same
 * codebase/process. It stops being fine once Sylo/Ryft/Wisp/Verve/Zynth (and
 * later third-party clients) become separate OIDC clients (Phase 2+): they
 * need to verify AYZEN-issued tokens without being handed the power to mint
 * new ones. RS256 splits that: AYZEN Central Account holds the PRIVATE key
 * and signs; every client only ever needs the PUBLIC key to verify.
 *
 * ENV VARS (production)
 *   AYZEN_JWT_PRIVATE_KEY  — PEM-encoded RSA private key (PKCS#8/PKCS#1).
 *   AYZEN_JWT_PUBLIC_KEY   — matching PEM-encoded RSA public key.
 *   AYZEN_JWT_KID          — short stable id for this keypair (goes in the
 *                            JWT header's `kid` claim; Phase 1B's JWKS
 *                            endpoint will key its published key set by this).
 *   Accepts either a real multi-line PEM value, a PEM with literal `\n`
 *   sequences (common when pasting into a single-line env var / dashboard
 *   secret field), or the whole PEM base64-encoded — see `normalizePem()`.
 *
 * DEV FALLBACK
 *   If the env vars aren't set and NODE_ENV !== "production", an ephemeral
 *   2048-bit RSA keypair is generated in-process (same philosophy as the old
 *   HS256 ephemeral-secret fallback in lib/jwt.ts) — regenerated every
 *   process start, never used in production, loud console warning either way.
 *
 * ROLLOUT (HS256 → RS256)
 *   Deploying this invalidates every previously-issued HS256 token by
 *   default — same call the project made for the original unsigned→HS256
 *   migration ("expected and necessary", see lib/jwt.ts header). If you need
 *   a softer rollout instead of forcing every device to re-login at once,
 *   set ALLOW_LEGACY_HS256_TOKENS=true for a grace period: verifyAuthToken()
 *   will then also accept old HS256 tokens signed with AYZEN_JWT_SECRET.
 *   Turn it back off once real logins have replaced old sessions (they
 *   expire within 7 days on their own).
 *
 * GENERATING A KEYPAIR
 *   npx tsx scripts/src/generate-jwt-keypair.ts
 *   — prints AYZEN_JWT_PRIVATE_KEY / AYZEN_JWT_PUBLIC_KEY / AYZEN_JWT_KID
 *     ready to paste into your environment.
 */

import { generateKeyPairSync, randomBytes, createPublicKey } from "crypto";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const isProd = process.env.NODE_ENV === "production";

export interface JwtKeypair {
  kid: string;
  privateKey: string; // PEM
  publicKey: string; // PEM
}

/**
 * Accepts a PEM either as-is (real newlines), with literal `\n` escape
 * sequences (single-line env var paste), or as the whole PEM base64-encoded
 * (no `-----BEGIN` marker at all — some secret managers prefer this because
 * it can't be mangled by whitespace-trimming tooling).
 */
function normalizePem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.includes("\\n") ? trimmed.replace(/\\n/g, "\n") : trimmed;
  }
  // Not a PEM literal — assume base64-encoded PEM.
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.includes("-----BEGIN")) return decoded;
  } catch {
    /* fall through */
  }
  throw new Error(
    "AYZEN_JWT_PRIVATE_KEY / AYZEN_JWT_PUBLIC_KEY must be a PEM (real or \\n-escaped newlines) or a base64-encoded PEM.",
  );
}

function generateEphemeralKeypair(): JwtKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { kid: `dev-${randomBytes(4).toString("hex")}`, privateKey, publicKey };
}

function resolveKeypair(): JwtKeypair {
  const rawPrivate = process.env.AYZEN_JWT_PRIVATE_KEY;
  const rawPublic = process.env.AYZEN_JWT_PUBLIC_KEY;
  const kid = process.env.AYZEN_JWT_KID;

  if (rawPrivate && rawPublic && kid) {
    return {
      kid,
      privateKey: normalizePem(rawPrivate),
      publicKey: normalizePem(rawPublic),
    };
  }

  if (isProd) {
    throw new Error(
      "AYZEN_JWT_PRIVATE_KEY / AYZEN_JWT_PUBLIC_KEY / AYZEN_JWT_KID are not fully set. " +
        "Generate a keypair with: npx tsx scripts/src/generate-jwt-keypair.ts",
    );
  }

  logger.warn(
    "[security] AYZEN_JWT_PRIVATE_KEY/PUBLIC_KEY/KID not set — using an ephemeral " +
      "RS256 keypair generated for this dev process only (regenerates on every " +
      "restart). Set them in your environment before deploying.",
  );
  return generateEphemeralKeypair();
}

let cached: JwtKeypair | null = null;

/** The single active RS256 signing keypair. Cached for process lifetime — see lib/jwt.ts. */
export function getActiveKeypair(): JwtKeypair {
  if (!cached) cached = resolveKeypair();
  return cached;
}

// ─── Legacy HS256 secret (rollout grace period only) ───────────────────────
// Unchanged resolution logic moved here from the old lib/jwt.ts so that file
// can become RS256-only. Only ever consulted by verifyAuthToken() when
// ALLOW_LEGACY_HS256_TOKENS=true — see file header.

export const ALLOW_LEGACY_HS256_TOKENS = process.env.ALLOW_LEGACY_HS256_TOKENS === "true";

let cachedLegacySecret: string | null = null;

export function getLegacyHs256Secret(): string | null {
  if (cachedLegacySecret) return cachedLegacySecret;
  const configured = process.env.AYZEN_JWT_SECRET || process.env.JWT_SECRET;
  if (configured && configured.length >= 16) {
    cachedLegacySecret = configured;
    return cachedLegacySecret;
  }
  return null;
}

// ─── Phase 1D-c: Key lifecycle states ───────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1D-c (Key Rotation & Verification, part C).
//
// Phase 1C's schema (migration 078) already models three key states —
// 'active' | 'retiring' | 'retired' — and 1D-a/1D-b already behave
// correctly with respect to them (verify-eligible query excludes 'retired',
// mergeVerificationKeys() re-checks status defensively). What's been
// missing is a SINGLE, NAMED place that states the rule "which states may
// sign / which states may verify" — until now it was implicit in a SQL
// `WHERE status IN (...)` clause in one function and a hand-written
// `!== 'active' && !== 'retiring'` check in another, with nothing forcing
// the two to agree if either one changed independently. canSign()/
// canVerify() below are that single source of truth; 1D-a's
// fetchDbVerificationKeys()/mergeVerificationKeys() are refactored (below)
// to read the rule from here instead of re-stating it.
//
// This is NOT a fourth database state. The roadmap's illustrative
// ACTIVE → RETIRING → GRACE → REMOVED sketch and this table's actual
// ACTIVE → RETIRING → RETIRED columns describe the same lifecycle at
// different granularity: everything between "stopped signing" and "no
// longer verifiable" is exactly what migration 078 already calls
// 'retiring' — there is no separate observable state in between, so
// 'retiring' below is documented as covering both. Whether that window
// ever needs to be split into two DB-distinguishable states, and how long
// it lasts, is a retention-*policy* question — that's explicitly Phase
// 1D-e's job (Retention & Removal Policy), not this one; this sub-phase
// only names and enforces the sign/verify rule for the states that already
// exist.
//
// 'retired' is included in the type/rule table here (unlike JwtKeyStatus
// below, which — deliberately — still can't represent it) precisely so
// canSign()/canVerify() are total functions over every state the DB column
// can actually hold, not just the ones 1D-a happened to need. Nothing
// upstream constructs a VerificationKey with status: "retired" — the SQL
// filter and mergeVerificationKeys() both stop it at the boundary — but the
// rule functions themselves don't rely on that filtering having already
// happened.

/** Every state migration 078's `jwt_signing_keys.status` column can hold. */
export type JwtKeyLifecycleStatus = "active" | "retiring" | "retired";

const ALL_LIFECYCLE_STATUSES: readonly JwtKeyLifecycleStatus[] = ["active", "retiring", "retired"];

/**
 * May this key sign a NEW token? Exactly one row is allowed to be 'active'
 * at a time — enforced today by the DB's `jwt_signing_keys_single_active`
 * partial unique index (migration 078), not by this function. Only
 * `getActiveKeypair()`'s single env-resolved keypair actually signs
 * anything right now (signAuthToken()/signOAuthState() in lib/jwt.ts never
 * read jwt_signing_keys); canSign() exists so that Phase 1D-d's rotation
 * write path has one place to check "is it safe to promote this row to
 * active" instead of re-deriving the rule.
 */
export function canSign(status: JwtKeyLifecycleStatus): boolean {
  return status === "active";
}

/**
 * May this key verify an EXISTING token? This is the grace-period
 * guarantee the whole sub-phase is about: a key that has stopped signing
 * ('retiring') must keep verifying tokens issued while it was active,
 * until Phase 1D-e's retention policy is satisfied and it moves to
 * 'retired'. A 'retired' key verifies nothing, unconditionally.
 */
export function canVerify(status: JwtKeyLifecycleStatus): boolean {
  return status === "active" || status === "retiring";
}

/** The states canVerify() allows — derived, not re-typed, so the SQL filter and the type below can't silently drift from the rule function above. */
const VERIFY_ELIGIBLE_STATUSES = ALL_LIFECYCLE_STATUSES.filter(canVerify);

/**
 * Logs (does not throw — this runs on a read path, not a write path) if
 * more than one 'active' key is present after a merge. Should be
 * unreachable given the DB's single-active constraint plus
 * mergeVerificationKeys() only ever adding the env keypair as 'active' when
 * no DB row already claims that kid — but it's a one-line defensive check
 * against exactly the failure mode this sub-phase exists to rule out
 * ("exactly one intended signing key is active"), cheap enough to leave in
 * permanently rather than trust the invariant silently.
 */
function warnIfMultipleActive(keys: VerificationKey[]): void {
  const activeCount = keys.filter((k) => k.status === "active").length;
  if (activeCount > 1) {
    logger.warn(
      { activeKids: keys.filter((k) => k.status === "active").map((k) => k.kid) },
      "[jwt-keys] more than one verification key resolved as 'active' — jwt_signing_keys_single_active should make this impossible; signing still only ever uses getActiveKeypair()'s env keypair, but this indicates the retained-key table has drifted",
    );
  }
}

// ─── Phase 1D-a: Verification-key abstraction ───────────────────────────────
// OIDC Roadmap — Season 1, Phase 1D-a (Key Rotation & Verification, part A).
//
// Everything above this point is unchanged from Phase 1A/1B: exactly one
// active keypair, resolved from the env, used for both signing AND
// verification via getActiveKeypair(). That's the thing rotation can't
// tolerate — the moment AYZEN_JWT_KID/the env keys change, every token
// signed under the old kid becomes unverifiable instantly instead of
// expiring naturally.
//
// getVerificationKeys(kid?) below is the seam that fixes that, WITHOUT
// implementing rotation itself (that's 1D-d) or making lookup strictly
// kid-deterministic with defined unknown-kid behavior (that's 1D-b). It
// only separates "what key(s) can verify a token" from "what key signs a
// new one" — signAuthToken()/signOAuthState() (lib/jwt.ts) keep calling
// getActiveKeypair() directly and are untouched by anything below.
//
// Source of truth: the jwt_signing_keys table Phase 1C added (migration
// 078) — "active" and "retiring" rows are valid for verification, "retired"
// is not. Phase 1C shipped schema only, with no write path, so in practice
// that table is empty today; getVerificationKeys() falls back to the single
// env-resolved active keypair whenever the DB has nothing for the requested
// kid, which is exactly why current behavior is unchanged until Phase 1D-d
// starts actually writing rotated keys into it.

/**
 * The subset of JwtKeyLifecycleStatus a VerificationKey can legitimately
 * carry. Written as an explicit union (not `Exclude<JwtKeyLifecycleStatus,
 * "retired">`) so a `VerificationKey` literal with `status: "retired"`
 * fails to typecheck outright rather than merely failing a runtime filter —
 * belt-and-suspenders alongside canVerify()/VERIFY_ELIGIBLE_STATUSES above,
 * which are the actual runtime source of truth this type is kept in sync
 * with by hand (there are only two verify-eligible states, so the
 * duplication is small and explicit rather than a type-level derivation
 * that would obscure what the two states actually are).
 */
export type JwtKeyStatus = "active" | "retiring";

export interface VerificationKey {
  kid: string;
  publicKey: string; // PEM, SPKI — verification only, never a private key
  status: JwtKeyStatus;
}

/**
 * Pure merge step: combine whatever verification-eligible rows the DB
 * returned with the single env-resolved active keypair, de-duplicate by
 * `kid`, and narrow to one `kid` if requested. Factored out (no I/O) so it
 * can be unit-tested without a database connection — see
 * scripts/src/test-verification-keys.ts.
 *
 * `dbKeys` is trusted to already be filtered to active/retiring by the
 * caller's SQL (fetchDbVerificationKeys() below) — this function also
 * defensively re-checks status so a future caller can't accidentally leak
 * a "retired" row into a token verification attempt just by passing
 * unfiltered rows in.
 *
 * The env keypair is only added when the DB didn't already return a row
 * for that exact kid, so once Phase 1D-d starts writing real rotation rows
 * (whose "active" row will always match AYZEN_JWT_KID) this fallback stops
 * contributing anything on its own.
 */
export function mergeVerificationKeys(
  dbKeys: VerificationKey[],
  envKeypair: JwtKeypair,
  kid?: string,
): VerificationKey[] {
  const byKid = new Map<string, VerificationKey>();
  for (const k of dbKeys) {
    if (!canVerify(k.status)) continue; // Phase 1D-c: single source of truth for "which states may verify"
    byKid.set(k.kid, k);
  }
  if (!byKid.has(envKeypair.kid)) {
    byKid.set(envKeypair.kid, { kid: envKeypair.kid, publicKey: envKeypair.publicKey, status: "active" });
  }
  const all = [...byKid.values()];
  warnIfMultipleActive(all); // Phase 1D-c: "exactly one intended signing key is active" sanity check
  return kid === undefined ? all : all.filter((k) => k.kid === kid);
}

/**
 * Reads verify-eligible rows from jwt_signing_keys (Phase 1C). The status
 * list comes from VERIFY_ELIGIBLE_STATUSES (Phase 1D-c, derived from
 * canVerify()) rather than being hand-written here a second time, so this
 * query can never drift from mergeVerificationKeys()'s own filtering —
 * both ultimately answer "may this status verify?" from the same place.
 * Never returns 'retired' rows — those aren't valid for verification.
 */
async function fetchDbVerificationKeys(kid?: string): Promise<VerificationKey[]> {
  const r = kid
    ? await pool.query(
        `SELECT kid, public_key, status FROM jwt_signing_keys WHERE status = ANY($1::text[]) AND kid = $2`,
        [VERIFY_ELIGIBLE_STATUSES, kid],
      )
    : await pool.query(
        `SELECT kid, public_key, status FROM jwt_signing_keys WHERE status = ANY($1::text[])`,
        [VERIFY_ELIGIBLE_STATUSES],
      );
  return r.rows.map((row: { kid: string; public_key: string; status: JwtKeyStatus }) => ({
    kid: row.kid,
    publicKey: row.public_key,
    status: row.status,
  }));
}

/**
 * The verification-key abstraction Phase 1D-a introduces. Returns every key
 * currently valid for verifying a token — active + retiring, narrowed to a
 * specific `kid` when one is passed (e.g. from a JWT's header once 1D-b
 * wires that in) — sourced from jwt_signing_keys with the single
 * env-resolved active keypair as a fallback (see file header above for why
 * that fallback matters today).
 *
 * Read-only and additive: does not change verifyAuthToken()/
 * verifyOAuthState() (lib/jwt.ts) behavior yet — they still call
 * getActiveKeypair() directly, unchanged. Wiring them to call this instead,
 * with defined unknown-kid/rotated-kid semantics, is Phase 1D-b's job, not
 * this one.
 */
export async function getVerificationKeys(kid?: string): Promise<VerificationKey[]> {
  const envKeypair = getActiveKeypair();
  let dbKeys: VerificationKey[] = [];
  try {
    dbKeys = await fetchDbVerificationKeys(kid);
  } catch (err) {
    logger.warn(
      { err },
      "[jwt-keys] failed to read jwt_signing_keys — falling back to the single env-resolved active keypair only",
    );
  }
  return mergeVerificationKeys(dbKeys, envKeypair, kid);
}

// ─── Phase 1D-b: kid-based verification lookup (sync, cached) ──────────────
// OIDC Roadmap — Season 1, Phase 1D-b (Key Rotation & Verification, part B).
//
// verifyAuthToken()/verifyOAuthState() (lib/jwt.ts) run on the hot path of
// every authenticated request and have always been synchronous.
// getVerificationKeys() above is async (it reads jwt_signing_keys) — calling
// it there directly would force every caller of verifyAuthToken()/
// verifyOAuthState() across the codebase (routes, middleware, sessions.ts,
// auth-utils.ts, ...) to become async too, which is exactly the kind of
// unrelated-architecture change the roadmap says not to make for one
// sub-phase. Instead this follows the same shape lib/vault-crypto.ts already
// uses for its DEK cache (loadKeyManager()): an in-memory cache, refreshed
// asynchronously, read synchronously on the hot path, self-healing once the
// first async load resolves.
//
// resolveVerificationKeys(kid?) is what makes lookup *deterministic*: a
// `kid` either resolves to the exact key(s) that `kid` names, or resolves to
// nothing at all — it never falls back to "well, try the active key anyway"
// for a `kid` that was actually looked up and not found. The only fallback
// that exists is for the narrow pre-cache-load window at process boot (see
// below), and even that fallback still refuses any `kid` other than the
// current env keypair's own.

const verificationKeyCache = new Map<string, VerificationKey>();
let verificationCacheReady = false;
let verificationCacheLoadInFlight: Promise<void> | null = null;

/**
 * Populates the in-memory verification-key cache from getVerificationKeys().
 * Safe to call more than once — replaces the cache wholesale each time, so
 * a future rotation (Phase 1D-d) can call this again after writing a new
 * row to refresh what resolveVerificationKeys() sees. Not currently called
 * from anywhere but resolveVerificationKeys()'s own lazy self-heal below —
 * wiring an explicit boot-time call (mirroring vault-crypto's
 * waitForDbThenMigrate) is left to whichever later phase wants the cache
 * warm before the first request, since that's an index.ts change and out of
 * scope for this sub-phase.
 */
export async function loadVerificationKeyCache(): Promise<void> {
  const keys = await getVerificationKeys();
  verificationKeyCache.clear();
  for (const k of keys) verificationKeyCache.set(k.kid, k);
  verificationCacheReady = true;
}

/**
 * Synchronous, kid-based verification-key lookup — what lib/jwt.ts's
 * verifyAuthToken()/verifyOAuthState() now call instead of
 * getActiveKeypair().
 *
 * - Cache already loaded, `kid` given → returns exactly that key, or `[]`
 *   if `kid` isn't a currently active/retiring verification key. `[]` means
 *   the caller's verify loop simply has nothing to try — this is the
 *   "unknown kid fails safely" behavior; it is never treated as "so try the
 *   active key instead".
 * - Cache already loaded, no `kid` given → every currently valid key (for
 *   legacy/kid-less tokens — same permissiveness verifyAuthToken() always
 *   had pre-Phase-1D, now just multi-key-aware).
 * - Cache NOT loaded yet (only possible in the brief window before the
 *   first call anywhere in the process — see loadVerificationKeyCache()) →
 *   falls back to the single env-resolved active keypair, but ONLY when
 *   `kid` is undefined or exactly matches that keypair's own `kid`; any
 *   other requested `kid` still returns `[]` even pre-cache, so a rotated/
 *   retired `kid` can never slip through just because the cache hasn't
 *   loaded yet. Kicks off the async load in the background (fire-and-
 *   forget, retried on the next call if it fails) so this fallback window
 *   only ever applies to the first few calls after process start.
 */
export function resolveVerificationKeys(kid?: string): VerificationKey[] {
  if (!verificationCacheReady) {
    if (!verificationCacheLoadInFlight) {
      verificationCacheLoadInFlight = loadVerificationKeyCache().catch((err) => {
        logger.warn({ err }, "[jwt-keys] background verification-key cache load failed — will retry on next call");
        verificationCacheLoadInFlight = null; // allow the next call to retry
      });
    }
    const envKeypair = getActiveKeypair();
    if (kid !== undefined && kid !== envKeypair.kid) return [];
    return [{ kid: envKeypair.kid, publicKey: envKeypair.publicKey, status: "active" }];
  }

  if (kid === undefined) return [...verificationKeyCache.values()];
  const match = verificationKeyCache.get(kid);
  return match ? [match] : [];
}

/** Test-only escape hatch to reset cache module state between test cases. Not used by any production code path. */
export function __resetVerificationKeyCacheForTests(): void {
  verificationKeyCache.clear();
  verificationCacheReady = false;
  verificationCacheLoadInFlight = null;
}

// ─── Phase 1D-e: Retention & Removal Policy ─────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1D-e (Key Rotation & Verification, part E).
//
// Phase 1D-d's rotate-jwt-signing-key.ts moves the outgoing key straight to
// 'retiring' and never writes 'retired' — deliberately, that script's job
// was only "is it safe to START the overlap window", not "is it safe to END
// it". This sub-phase is that other half: given a key that's been
// 'retiring' for a while, when is it actually safe to stop verifying with
// it (move it to 'retired')?
//
// The answer has to be grounded in something real, not a guess: a
// 'retiring' key must keep verifying for as long as a token signed under it
// while it was still 'active' could still be unexpired. The longest-lived
// token lib/jwt.ts ever signs is signAuthToken()'s DEFAULT_EXPIRY ("7d") —
// so a key retired any sooner than 7 days after it stopped signing could
// reject an in-flight session that hasn't hit its own natural expiry yet.
// On top of that, add a clock-skew allowance: the moment a key flips to
// 'retiring' (rotate-jwt-signing-key.ts's NOW()) and the moment some other
// process later evaluates whether it's safe to retire aren't guaranteed to
// be measured by clocks that agree to the second, so the retention window
// pads the raw token lifetime rather than cutting it exactly at 7d.
//
// "Removal" here means the DB status moving to 'retired' — NOT a DELETE.
// Migration 078's trigger refuses deletes outright ("rows are never
// deleted... kept as an audit trail"); the roadmap's illustrative REMOVED
// state and this codebase's 'retired' status are the same thing (see the
// 1D-c mapping note above) — a row that verifies nothing but still exists.

/**
 * The longest `expiresIn` lib/jwt.ts's signAuthToken() ever passes to
 * jwt.sign() — its DEFAULT_EXPIRY constant. Restated here as an explicit,
 * independently-set value rather than imported, because lib/jwt.ts already
 * imports FROM this file (getActiveKeypair, resolveVerificationKeys, ...);
 * importing back would be circular. Same small, explicit-duplication
 * tradeoff JwtKeyStatus made in Phase 1D-a for the same reason. If
 * lib/jwt.ts's DEFAULT_EXPIRY ever changes, update this too —
 * test-rotation-lifecycle.ts (Phase 1D-f) asserts the two values agree so a
 * future drift fails a test instead of silently under-retaining keys.
 *
 * signOAuthState()'s tokens are much shorter-lived (10m default) and don't
 * drive this constant — the retention window only needs to cover the
 * LONGEST token any caller might still be holding, and session tokens are
 * always the longer of the two.
 */
export const MAX_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/**
 * How much clock disagreement between the process that flipped a key to
 * 'retiring' (rotate-jwt-signing-key.ts, using the DB server's NOW()) and
 * the process later deciding whether it's safe to retire it (this file's
 * isRetirementSafe(), using whatever host's Date.now() calls it) to
 * tolerate before trusting "the retention window has elapsed". 10 minutes
 * is generous relative to realistic NTP drift between a DB server and an
 * app host — the cost of being generous here is a handful of extra minutes
 * a 'retiring' key stays verification-eligible, not a security regression;
 * the cost of being too tight would be retiring a key while a real token
 * signed under it is still technically unexpired.
 */
export const CLOCK_SKEW_ALLOWANCE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Total time a 'retiring' key must remain verification-eligible before
 * it's safe to move to 'retired': long enough that no token signed while it
 * was still 'active' can still be unexpired, plus the clock-skew allowance
 * above. This is the single number every other function/script in this
 * sub-phase derives from — nothing below re-picks "how long" independently.
 */
export const RETENTION_PERIOD_MS = MAX_TOKEN_LIFETIME_MS + CLOCK_SKEW_ALLOWANCE_MS;

/** The subset of a jwt_signing_keys row planRetirement()/retire-jwt-signing-keys.ts (below/scripts) need — just enough to decide, not the whole row. */
export interface RetiringKeyRow {
  kid: string;
  /** migration 078's `retiring_at` — set (NOT NULL, enforced by jwt_signing_keys_retiring_at_ck) the instant a key stops signing. */
  retiringAt: Date;
}

/**
 * The earliest instant a 'retiring' key becomes safe to move to 'retired':
 * `retiringAt + RETENTION_PERIOD_MS`. Pure, no I/O, no clock read — callers
 * that want "is it safe right now" use isRetirementSafe() below, which
 * compares this against `now`.
 */
export function retirementEligibleAt(retiringAt: Date): Date {
  return new Date(retiringAt.getTime() + RETENTION_PERIOD_MS);
}

/**
 * True once `now` has reached retirementEligibleAt(retiringAt) — i.e. every
 * token that could ever have been signed under this key while it was
 * 'active' has either already expired or is within this function's own
 * skew tolerance of expiring. `now` defaults to the real clock but takes an
 * explicit Date so retire-jwt-signing-keys.ts's tests (and
 * test-rotation-lifecycle.ts, 1D-f) can exercise both sides of the boundary
 * deterministically instead of racing the real clock.
 */
export function isRetirementSafe(retiringAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= retirementEligibleAt(retiringAt).getTime();
}

export type RetirementDecision =
  | { kid: string; safe: true }
  | { kid: string; safe: false; eligibleAt: Date };

/**
 * Pure planning step for scripts/src/retire-jwt-signing-keys.ts: given every
 * row currently 'retiring', decide which are safe to move to 'retired'
 * right now and which must keep waiting (and until when). This is the thing
 * that actually "prevents removal while valid tokens may still depend on"
 * a key — a caller that only ever writes status='retired' for rows this
 * function marked `safe: true` cannot retire a key early, full stop; there
 * is no other path to 'retired' anywhere in this codebase.
 *
 * `retiringRows` is trusted to already be filtered to status='retiring' by
 * the caller's SQL (retire-jwt-signing-keys.ts's query does this, same
 * discipline as fetchDbVerificationKeys() in 1D-a) — this function never
 * decides to retire an 'active' key; it has no way to even represent one.
 */
export function planRetirement(retiringRows: RetiringKeyRow[], now: Date = new Date()): RetirementDecision[] {
  return retiringRows.map((row) =>
    isRetirementSafe(row.retiringAt, now)
      ? { kid: row.kid, safe: true }
      : { kid: row.kid, safe: false, eligibleAt: retirementEligibleAt(row.retiringAt) },
  );
}

// ─── Phase 1E-a: RSA-to-JWK conversion ──────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1E-a (OIDC Discovery & JWKS, part A).
//
// Converts a VerificationKey (the type 1D-a already narrowed to "public PEM
// + kid + verify-eligible status", never a private key) into the JSON Web
// Key shape a JWKS response publishes. Uses Node's built-in
// crypto.createPublicKey(pem).export({ format: "jwk" }) — no new dependency
// (no `jose`/`node-jose` in package.json, and none is added here) — which,
// for an RSA SPKI public key, only ever returns `{ kty: "RSA", n, e }`.
//
// "publish only public material" (the roadmap's 1E-a acceptance line) holds
// structurally, not just by convention: this function's only input is
// VerificationKey.publicKey, which is documented (1D-a) as "PEM, SPKI —
// verification only, never a private key". There is no parameter, branch,
// or fallback anywhere below that can reach JwtKeypair.privateKey — a
// private key literally never reaches this function to be exported.

/** The published shape of one RS256 verification key. `use`/`alg` are fixed literals — every key this codebase issues signs ID/session tokens with RS256, never encrypts. */
export interface RsaJwk {
  kty: "RSA";
  use: "sig";
  alg: "RS256";
  kid: string;
  n: string;
  e: string;
}

/**
 * Converts one VerificationKey to its JWK form. Throws if `publicKey` isn't
 * a parseable RSA public key — every key this codebase ever generates
 * (generateEphemeralKeypair, generate-jwt-keypair.ts, migration 078's
 * jwt_signing_keys rows) is RSA, so this should be unreachable in practice;
 * treated as a hard failure (not a silent skip) here so a corrupt row is
 * caught close to its source. buildJwks() (1E-b) is the caller that decides
 * whether one bad key should fail an entire JWKS response.
 */
export function verificationKeyToJwk(key: VerificationKey): RsaJwk {
  const keyObject = createPublicKey(key.publicKey);
  if (keyObject.asymmetricKeyType !== "rsa") {
    throw new Error(
      `[jwt-keys] verificationKeyToJwk: kid "${key.kid}" is a "${keyObject.asymmetricKeyType}" key, not RSA — cannot publish as an RS256 JWK`,
    );
  }
  // Node's JWK export of an RSA public key is exactly { kty: "RSA", n, e } —
  // asserted narrowly rather than spread, so an unexpected extra field
  // (e.g. a future Node version) can never leak into the published JWK
  // un-reviewed.
  const exported = keyObject.export({ format: "jwk" }) as { kty: string; n: string; e: string };
  return { kty: "RSA", use: "sig", alg: "RS256", kid: key.kid, n: exported.n, e: exported.e };
}

// ─── Phase 1E-b: JWKS response builder ─────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1E-b (OIDC Discovery & JWKS, part B).
//
// Builds the stable `{ keys: [...] }` JWKS object from whatever set of
// VerificationKeys the caller currently has resolved (getVerificationKeys()/
// resolveVerificationKeys(), 1D-a/1D-b — active + retiring). "Exclude
// removed keys" (the roadmap's 1E-b acceptance line) is free here, not a
// filter this function has to apply: VerificationKey's status type
// (JwtKeyStatus, 1D-a) structurally cannot hold "retired" — canVerify()
// already stopped those rows before they became a VerificationKey at all.
// A "removed"/retired key is never in the input array to begin with.
//
// Pure and I/O-free, same discipline as mergeVerificationKeys() (1D-a): no
// route, no HTTP framing, no caching policy — 1E-c's endpoint (out of scope
// here) is what will call this with a live key source and wrap the result
// in an HTTP response.

export interface Jwks {
  keys: RsaJwk[];
}

/**
 * VerificationKey[] → JWKS. Deterministic: same input array (same keys, same
 * order) always produces the same output array in the same order — callers
 * that want a specific ordering (e.g. active before retiring) sort before
 * calling this; it does not re-sort.
 *
 * Empty input → `{ keys: [] }`— not an error, not a thrown exception. An
 * empty JWKS is a structurally valid response (e.g. the verification-key
 * cache hasn't loaded yet, 1D-b) and 1E-c's endpoint should be able to
 * return it as-is rather than special-casing "no keys".
 *
 * A single key that fails RSA-to-JWK conversion (verificationKeyToJwk
 * throwing — see its own doc comment for when that's possible) is logged
 * and skipped rather than failing the whole response: one malformed row
 * should not take every other still-valid key down with it.
 */
export function buildJwks(keys: VerificationKey[]): Jwks {
  const jwks: RsaJwk[] = [];
  for (const key of keys) {
    try {
      jwks.push(verificationKeyToJwk(key));
    } catch (err) {
      logger.warn({ err, kid: key.kid }, "[jwt-keys] buildJwks: skipping a key that failed RSA-to-JWK conversion");
    }
  }
  return { keys: jwks };
}
