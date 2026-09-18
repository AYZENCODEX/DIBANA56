/**
 * lib/oidc-login-attempts.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 5c-d (Comparison Monitoring) + 5e-a/5e-b/5e-c
 * (Monitoring & Rollback's "login failure metrics" / "token+callback error"
 * / "alert thresholds" trio).
 *
 * A per-process, in-memory tally of login attempts on THREE paths — the old
 * cookie-hack form (`POST /auth/login`, path `"legacy"`), the new OIDC token
 * exchange (`POST /oidc/token`, path `"oidc"`), and the OIDC browser
 * callback (`/oidc/callback`'s error states, path `"callback"`, 5e-b) —
 * bucketed by `appId` and a fixed set of minute-wide windows, so
 * `routes/admin-oidc-rollout.ts`'s GET endpoint can answer both 5c-d's
 * question ("is the new path's failure rate meaningfully worse than the old
 * path's, right now") and 5e's ("does this look broken enough to alert on /
 * roll back"), without requiring a person to go read raw logs.
 *
 * PHASE BOUNDARY NOTE (5c-d vs 5e-a/5e-b/5e-c)
 * The roadmap lists these as separate sub-phases, but they are the same
 * underlying signal viewed two ways, not two systems: 5c-d's dual-run
 * comparison ("is oidc worse than legacy, right now") and 5e-a/5e-b's
 * failure-metric tracking ("how many login/token/callback failures, and of
 * what kind") both need the identical per-path, per-outcome attempt log this
 * file already builds for the dual-run — 5e-a/5e-b add error-CODE
 * granularity (`errorCode` below) on top of the win/loss counts 5c-d already
 * had, and 5e-c (`evaluateOidcRolloutHealth()`) is a threshold function
 * layered over both. There was no reason to fork a second in-memory store
 * for what is one comparison, refined.
 *
 * WHY IN-MEMORY, NOT A TABLE
 * Every other piece of durable state in this roadmap (clients, codes,
 * refresh tokens, the rollout flag itself) is a Postgres row, so this is a
 * deliberate departure — called out explicitly, the same way this
 * roadmap's CHANGES docs already disclose every other sandbox limitation:
 *   - This is a ROLLOUT-WINDOW signal, not an audit trail. Its whole job is
 *     "does the last few minutes look healthy", not "what happened on
 *     March 3rd" — `logger.info`/`logger.warn` calls already exist at
 *     every one of these call sites (see routes/auth.ts, routes/oidc-token.ts,
 *     and the new routes/oidc-client-errors.ts, 5e-b) for anyone who needs a
 *     durable, queryable record; this module is additive to that, not a
 *     replacement.
 *   - A real per-request Postgres INSERT on the token endpoint's hot path
 *     is exactly the kind of latency/write-amplification cost section 3's
 *     "resource server" performance expectations already push back on
 *     elsewhere in this roadmap (see oidc-access-token-verification.ts's
 *     own "no DB round trip on every resource request" precedent) — an
 *     in-process counter is the same tradeoff applied to attempt-counting.
 *   - Multi-instance deploys each keep their own counters (same limitation
 *     `log-bus.ts`'s existing in-memory ring buffer already has, and the
 *     precedent this module otherwise follows) — the admin endpoint's
 *     response is "this instance's recent view", not a fleet-wide total.
 *     Good enough for the rollback trigger 5e actually needs ("does this
 *     look broken right now"); not a substitute for real observability
 *     infrastructure, which is out of this roadmap's scope entirely.
 *
 * SCOPE DISCIPLINE (this is 5c-d/5e-a/5e-b/5e-c, not 5c-a/5c-b/5c-c or 5d)
 *   - Does not read or write the rollout flag itself — that's
 *     lib/oidc-client-rollout.ts.
 *   - Does not decide to roll back, and does not itself page/notify anyone
 *     — `evaluateOidcRolloutHealth()` (5e-c) only REPORTS whether current
 *     numbers cross a threshold; `set-oidc-rollout-flag.ts --disable` / the
 *     admin PATCH endpoint remain the only things that actually flip the
 *     flag (5c-e/5e-d), same "this file only answers a question, callers
 *     own what to DO with the answer" discipline `sylo-oidc-rollout-flag.ts`'s
 *     own header already states for the frontend flag read.
 */

/**
 * 5c-d: best-effort "which subdomain app did this legacy `/auth/login`
 * request come from" resolver, for the ONLY caller that needs it
 * (`routes/auth.ts`'s `POST /auth/login` handler — the old cookie-hack
 * path itself, which is shared across every `*.ayzen.tech` app and has no
 * other way to know it was hit from Sylo specifically). Reads the
 * `Origin` header first (present on the browser `fetch()` `login.tsx`'s
 * `backendLogin()` makes), falling back to `Referer`'s hostname — same
 * two-header fallback order, same `SYLO_HOSTS` env var name (independently
 * read here; see below) `app.ts`'s own Sylo-redirect block already uses.
 * Returns `null` (recorded nowhere) for any request that isn't
 * identifiably from a currently-migrated app — this module has no opinion
 * on any subdomain besides the ones Season 3 actually scoped.
 *
 * Deliberately re-reads `SYLO_HOSTS` here rather than importing a shared
 * constant from `app.ts`: `app.ts`'s copy is a `const` local to that
 * module's static-file-serving block, not exported, and this lib must stay
 * importable from a route file without pulling in `app.ts`'s own
 * top-level side effects (Express app construction, static middleware,
 * etc.) — the same "keep DB-touching/app-bootstrapping modules out of a
 * pure-ish lib" discipline `set-oidc-rollout-flag.ts`'s own header
 * describes for why `@workspace/db` is dynamic-imported instead of a
 * top-level import there.
 */
export function resolveLegacyLoginAppId(originOrRefererHeader: string | undefined): string | null {
  if (!originOrRefererHeader) return null;
  const syloHosts = (process.env.SYLO_HOSTS ?? "sylo.ayzen.tech")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);

  let hostname: string;
  try {
    hostname = new URL(originOrRefererHeader).hostname;
  } catch {
    return null;
  }

  if (syloHosts.includes(hostname)) return "sylo";
  // Dev/preview convenience: first hostname label equals a known app id —
  // mirrors subdomain-app.ts's identical frontend fallback exactly.
  const firstLabel = hostname.split(".")[0];
  return firstLabel === "sylo" ? "sylo" : null;
}

/** 5e-b adds `"callback"` — the browser-side `/oidc/callback` failure states (`SyloOidcCallbackErrorCode`, `lib/sylo-oidc-callback.ts`), reported best-effort via `routes/oidc-client-errors.ts`'s beacon since the backend has no other way to observe a frontend-only failure (state mismatch, identity mismatch, ...). `"legacy"`/`"oidc"` are unchanged from 5c-d. */
export type OidcLoginAttemptPath = "legacy" | "oidc" | "callback";
export type OidcLoginAttemptOutcome = "success" | "failure";

interface AttemptRecord {
  path: OidcLoginAttemptPath;
  outcome: OidcLoginAttemptOutcome;
  /** 5e-a/5e-b: which specific error this failure was, when the caller has one (an `OidcTokenErrorCode`, a `SyloOidcCallbackErrorCode`, or an ad hoc reason for `"legacy"`). `undefined` for a success, and for any failure whose caller didn't pass one (5c-d's original callers still work unmodified — this is purely additive). */
  errorCode?: string;
  at: number;
}

/** How far back `getOidcLoginAttemptStats()` looks by default — long enough to smooth over a single bad request, short enough to reflect "right now" per the file header. */
export const DEFAULT_STATS_WINDOW_MS = 15 * 60_000;

/** Hard cap per app_id so a runaway loop (or a very long-uptime process) can't grow this without bound — old records fall off the front once exceeded, same "ring buffer" precedent as log-bus.ts's own MAX. */
const MAX_RECORDS_PER_APP = 2_000;

/** 5e-b: how many distinct error codes `summarize()` reports per path before folding the rest into a single "other" bucket — keeps the admin response bounded even if a caller starts passing high-cardinality strings by mistake. */
const MAX_TOP_ERRORS = 5;

const attemptsByApp = new Map<string, AttemptRecord[]>();

function normalizeAppId(appId: string): string {
  return appId.trim().toLowerCase();
}

/**
 * 5c-d/5e-a/5e-b: records one login attempt. Never throws — a monitoring
 * side-channel must never be able to fail the request it's observing, the
 * same "fire and forget, `.catch(() => {})` at the call site" discipline
 * `recordLoginHistory()` calls already use throughout routes/auth.ts.
 *
 * `errorCode` (5e-a/5e-b, additive, optional): the specific failure reason,
 * when the caller has one. Omit for a success, or when no closed error
 * vocabulary applies to the call site — `getOidcLoginAttemptStats()`'s
 * `topErrors` breakdown simply has less to say for that path, nothing else
 * changes.
 */
export function recordOidcLoginAttempt(
  appId: string,
  path: OidcLoginAttemptPath,
  outcome: OidcLoginAttemptOutcome,
  errorCode?: string,
): void {
  try {
    const normalized = normalizeAppId(appId);
    const records = attemptsByApp.get(normalized) ?? [];
    records.push({ path, outcome, errorCode: outcome === "failure" ? errorCode : undefined, at: Date.now() });
    if (records.length > MAX_RECORDS_PER_APP) records.splice(0, records.length - MAX_RECORDS_PER_APP);
    attemptsByApp.set(normalized, records);
  } catch {
    // A monitoring write must never surface as a failure — see file header.
  }
}

/**
 * 5e-b: convenience wrapper for the ONE caller that only ever reports
 * failures with no success case of its own — the `/oidc/callback` browser
 * beacon (`routes/oidc-client-errors.ts`). There is no such thing as a
 * "successful callback attempt" recorded through this path: a successful
 * callback ends in `session-exchange`, which is already the "oidc" path's
 * own success record (`routes/oidc-token.ts`'s prior `recordOidcLoginAttempt`
 * call plus the browser completing session-exchange) — recording a second,
 * separate "callback success" here would double-count the same login.
 */
export function recordOidcCallbackError(appId: string, errorCode: string): void {
  recordOidcLoginAttempt(appId, "callback", "failure", errorCode);
}

export interface OidcLoginAttemptPathStats {
  success: number;
  failure: number;
  total: number;
  /** `null` when `total` is 0 — "no data" and "0% failure" are different things a caller should not confuse. */
  failureRate: number | null;
  /** 5e-a/5e-b: up to `MAX_TOP_ERRORS` distinct `errorCode`s among this path's failures in the window, most frequent first, plus an `"other"` bucket for anything past that cap. Empty when no failure in the window carried an `errorCode`. */
  topErrors: Array<{ code: string; count: number }>;
}

export interface OidcLoginAttemptStats {
  appId: string;
  windowMs: number;
  legacy: OidcLoginAttemptPathStats;
  oidc: OidcLoginAttemptPathStats;
  /** 5e-b: browser-reported `/oidc/callback` failures — see `OidcLoginAttemptPath`'s own doc comment for why this has no `success` counterpart. */
  callback: OidcLoginAttemptPathStats;
}

function summarize(records: AttemptRecord[], path: OidcLoginAttemptPath, since: number): OidcLoginAttemptPathStats {
  let success = 0;
  let failure = 0;
  const errorCounts = new Map<string, number>();
  for (const record of records) {
    if (record.path !== path) continue;
    if (record.at < since) continue;
    if (record.outcome === "success") {
      success++;
    } else {
      failure++;
      if (record.errorCode) errorCounts.set(record.errorCode, (errorCounts.get(record.errorCode) ?? 0) + 1);
    }
  }
  const total = success + failure;
  const sortedErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]);
  const topErrors = sortedErrors.slice(0, MAX_TOP_ERRORS).map(([code, count]) => ({ code, count }));
  const otherCount = sortedErrors.slice(MAX_TOP_ERRORS).reduce((sum, [, count]) => sum + count, 0);
  if (otherCount > 0) topErrors.push({ code: "other", count: otherCount });
  return { success, failure, total, failureRate: total > 0 ? failure / total : null, topErrors };
}

/**
 * 5c-d/5e-a/5e-b: stats for all three paths for `appId` over the same
 * trailing window, side by side — the dual-run comparison (5c-d, legacy vs
 * oidc) and the failure/error breakdown (5e-a/5e-b) are the same call now.
 */
export function getOidcLoginAttemptStats(appId: string, windowMs: number = DEFAULT_STATS_WINDOW_MS): OidcLoginAttemptStats {
  const normalized = normalizeAppId(appId);
  const records = attemptsByApp.get(normalized) ?? [];
  const since = Date.now() - windowMs;
  return {
    appId: normalized,
    windowMs,
    legacy: summarize(records, "legacy", since),
    oidc: summarize(records, "oidc", since),
    callback: summarize(records, "callback", since),
  };
}

// ── 5e-c: Alert Thresholds ──────────────────────────────────────────────────
// "Define actionable thresholds" (roadmap 5e-c). Deliberately just TWO
// numbers, not a rules engine: the rollback trigger 5c-e/5e-d actually needs
// answered is narrow ("does the new path look meaningfully worse than the
// old one did, with enough traffic to trust that number") — anything more
// elaborate (percentile latency, per-error-code thresholds, ...) is exactly
// the "real observability infrastructure" this file's own header already
// says is out of this roadmap's scope.

export interface OidcRolloutHealthThresholds {
  /** Below this many "oidc" attempts in the window, `evaluateOidcRolloutHealth()` always reports healthy — a 1-in-1 failure is noise, not a signal, and a premature rollback on a cold-start sample would defeat 5c-c's own "controlled testing" purpose. */
  minOidcSample: number;
  /** How much worse (in absolute failure-rate percentage points) the "oidc" path's failure rate is allowed to be than "legacy"'s own concurrent failure rate before this reports unhealthy. Compared against legacy's rate rather than a fixed number so a noisy legacy path (an unrelated outage) doesn't itself trip a false OIDC alarm. */
  maxFailureRateDeltaOverLegacy: number;
  /** A hard ceiling on the "oidc" path's own failure rate, independent of legacy's — catches "oidc is broken" even in the edge case where legacy is ALSO failing badly enough that the delta-over-legacy check alone wouldn't flag it. */
  maxAbsoluteOidcFailureRate: number;
}

/** 5e-c's own defaults — a starting point an operator can override per call, not a claim that these exact numbers are correct for every deployment's traffic. */
export const DEFAULT_OIDC_ROLLOUT_HEALTH_THRESHOLDS: OidcRolloutHealthThresholds = {
  minOidcSample: 20,
  maxFailureRateDeltaOverLegacy: 0.15,
  maxAbsoluteOidcFailureRate: 0.5,
};

export interface OidcRolloutHealthResult {
  healthy: boolean;
  /** Empty when `healthy` is true. One entry per threshold actually crossed — a response can cross more than one at once (e.g. both the absolute ceiling and the delta-over-legacy check), and a caller (5e-c's own admin surface, 5e-d's rollback drill) may want to see all of them, not just the first. */
  reasons: string[];
  thresholds: OidcRolloutHealthThresholds;
  /** Echoes the exact numbers the decision was made from, so a human reading the admin response never has to separately re-fetch `getOidcLoginAttemptStats()` to see what tripped it. */
  stats: Pick<OidcLoginAttemptStats, "legacy" | "oidc">;
}

/**
 * 5e-c: reports whether the current window's numbers look healthy enough
 * to leave OIDC enabled for `appId`, against `thresholds` (defaults above).
 * Pure function of `getOidcLoginAttemptStats()`'s own output — never reads
 * the rollout flag, never writes anything, never pages/alerts anyone; see
 * file header's SCOPE DISCIPLINE for why raising an actual alert or rolling
 * back is deliberately left to the caller.
 */
export function evaluateOidcRolloutHealth(
  appId: string,
  windowMs: number = DEFAULT_STATS_WINDOW_MS,
  thresholds: OidcRolloutHealthThresholds = DEFAULT_OIDC_ROLLOUT_HEALTH_THRESHOLDS,
): OidcRolloutHealthResult {
  const stats = getOidcLoginAttemptStats(appId, windowMs);
  const reasons: string[] = [];

  if (stats.oidc.total >= thresholds.minOidcSample) {
    const oidcRate = stats.oidc.failureRate ?? 0;
    const legacyRate = stats.legacy.failureRate ?? 0;

    if (oidcRate > thresholds.maxAbsoluteOidcFailureRate) {
      reasons.push(
        `oidc failure rate ${(oidcRate * 100).toFixed(1)}% exceeds the absolute ceiling of ${(thresholds.maxAbsoluteOidcFailureRate * 100).toFixed(1)}%`,
      );
    }
    if (oidcRate - legacyRate > thresholds.maxFailureRateDeltaOverLegacy) {
      reasons.push(
        `oidc failure rate ${(oidcRate * 100).toFixed(1)}% exceeds legacy's ${(legacyRate * 100).toFixed(1)}% by more than the allowed ${(thresholds.maxFailureRateDeltaOverLegacy * 100).toFixed(1)} point margin`,
      );
    }
  }
  // Below minOidcSample: not enough traffic to trust the rate — see the
  // threshold's own doc comment. Deliberately silent (no "not enough data"
  // reason entered) rather than reported as a caveat: `healthy: true` with
  // an empty `reasons` already communicates "nothing to act on right now."

  return { healthy: reasons.length === 0, reasons, thresholds, stats: { legacy: stats.legacy, oidc: stats.oidc } };
}

/** Test-only escape hatch — clears every app's counters. Never called from production code. */
export function __resetOidcLoginAttemptsForTests(): void {
  attemptsByApp.clear();
}

/**
 * OIDC Roadmap — Season 5, Phase 9a: "last time a token was successfully
 * issued for this client" — the admin client-list view's own roadmap text
 * ("শেষ কবে token issue হয়েছে") names this as a REUSE of this file's
 * existing per-app stats, not a new persisted tracking mechanism, and this
 * is that reuse: it reads the SAME `attemptsByApp` ring buffer every other
 * function in this file already reads, adding no new storage.
 *
 * Deliberately UNBOUNDED by any `windowMs` — unlike
 * `getOidcLoginAttemptStats()`, which exists to answer "how is this app
 * doing RIGHT NOW" and is useless without a trailing window, an admin
 * asking "when did this client last issue a token at all" wants the most
 * recent success in whatever history this process still has, however long
 * ago that was (bounded only by `MAX_RECORDS_PER_APP`'s own ring-buffer
 * cap, same as every other read here).
 *
 * `appId` here is `client.clientId` — `routes/oidc-token.ts`'s own header
 * confirms every token-issuance call already records under exactly that
 * key, for every client, first-party or dynamically-registered alike, not
 * only the Season-3-migrated ones `admin-oidc-rollout.ts` itself is scoped
 * to.
 *
 * CAVEAT the admin route surfacing this must carry through to whoever
 * reads its response: this file's own header already establishes
 * `attemptsByApp` is in-memory, per-process — a server restart silently
 * resets it to empty, so `null` here means EITHER "never issued a token"
 * OR "the process restarted since the last one," not only the former.
 * Real persisted history is Phase 9e's audit-log job, not this file's.
 */
export function getOidcLastTokenIssuedAt(appId: string): number | null {
  const normalized = normalizeAppId(appId);
  const records = attemptsByApp.get(normalized) ?? [];
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.path === "oidc" && record.outcome === "success") return record.at;
  }
  return null;
}
