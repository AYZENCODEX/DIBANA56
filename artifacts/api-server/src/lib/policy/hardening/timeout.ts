/**
 * lib/policy/hardening/timeout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 25 (Production Hardening).
 *
 * The roadmap's own Phase 25 line item "timeout limits" is, until this
 * file, entirely unenforced anywhere in `lib/policy/*`: `PolicyEngine.
 * evaluateCore()` (../policy-engine.ts) `await`s each registered
 * `PolicyRule` with no bound on how long it may take, and `pep/
 * authorize.ts` `await`s a Phase 18 `PolicyInformationPoint`'s
 * `resolveSubject()`/`resolveContext()` the same way. Every rule/provider
 * this engine ships today happens to be fast (in-memory, or a single
 * indexed DB query) — but a slow or hung DB connection, or a future rule
 * that calls out to a slow external service, would otherwise block the
 * whole authorization pipeline indefinitely, which is itself a
 * denial-of-service surface (an attacker who can make one dependency slow
 * can hang every request waiting on an authorization decision that never
 * comes) and a direct contradiction of Rule 8 ("Authorization failures
 * must fail closed") — a decision that never resolves is not "closed",
 * it is stuck.
 *
 * `withTimeout()` is the one shared primitive both call sites (../policy-
 * engine.ts's rule loop, ../pep/authorize.ts's PIP resolution) use — same
 * "one place gets this right, not two subtly different re-implementations"
 * discipline every other cross-cutting concern in this engine already
 * follows (see e.g. ../authorization-decision.ts's `stamp()` for
 * decision-building, ../decision-reasons.ts for reason codes).
 *
 * ── Honest about what a `Promise.race()`-based timeout can and cannot do ──
 * JavaScript has no general-purpose way to cancel an arbitrary in-flight
 * `Promise` (only APIs that explicitly accept an `AbortSignal` can be
 * cancelled — see `routes/telemetry.ts`'s own `AbortSignal.timeout(3000)`
 * use against `fetch()`, which THIS file deliberately does not attempt to
 * generalize, since a `PolicyRule`/`PolicyInformationPoint` method's
 * signature accepts no such signal today and changing every existing rule
 * and provider's signature to plumb one through is real, and unrelated,
 * API-surface churn this phase does not need). `withTimeout()` therefore
 * does exactly what its name says and no more: past the deadline, it stops
 * WAITING on the original promise and lets the caller proceed as if it had
 * failed — the original operation may still be running in the background
 * (e.g. a slow DB query that eventually completes and is simply ignored).
 * This is still the correct fix for the DoS/fail-closed concern above: the
 * AUTHORIZATION PIPELINE is what must never hang, not the underlying
 * dependency call, and cutting the pipeline's own wait short accomplishes
 * exactly that.
 *
 * ── Opt-in, zero-behavior-change-by-default ──────────────────────────────
 * `timeoutMs` of `undefined`/`0`/negative disables the timeout entirely
 * (returns the original promise, unwrapped) — every existing caller of
 * `PolicyEngine`/`authorize()` that does not pass a new `ruleTimeoutMs`/
 * `pipTimeoutMs` option keeps byte-for-byte the same unbounded-wait
 * behavior it already had (Rule 5: prefer additive; Rule 16: this is not
 * a breaking change to any already-shipped call site or test).
 */

export class AuthorizationTimeoutError extends Error {
  constructor(
    /** What was being waited on, for the resulting decision's own
     *  `message` — e.g. `rule "rbac"` or `PIP resolveSubject()`. Never
     *  put request-specific/sensitive detail here (this can end up in
     *  logs/audit rows) — same rule ../decision-reasons.ts's own
     *  `AuthorizationDecision.message` doc comment already states. */
    public readonly stage: string,
    public readonly timeoutMs: number,
  ) {
    super(`Authorization ${stage} exceeded its ${timeoutMs}ms time budget`);
    this.name = "AuthorizationTimeoutError";
  }
}

/**
 * Races `operation` against a `timeoutMs`-millisecond timer. Resolves/
 * rejects with whatever `operation` does if it settles first; otherwise
 * rejects with `AuthorizationTimeoutError` once the budget is exceeded.
 * `timeoutMs` of `undefined`, `0`, or negative disables the timeout
 * entirely (see file header's "opt-in" section) — `operation` is awaited
 * unbounded, identical to every pre-Phase-25 call site.
 *
 * `operation` is a thunk (`() => Promise<T>`), not a bare `Promise<T>`,
 * so a synchronously-throwing `PolicyRule`/PIP call is invoked INSIDE this
 * function's own try/catch-free `Promise.race` — a call site does not
 * need a separate try/catch around the call itself just to route a sync
 * throw through the same handling as an async rejection; both surface as
 * a rejected `Promise` to the caller either way (the caller already has
 * to catch that, for the exact same reason it already catches an async
 * rejection today).
 */
export function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number | undefined, stage: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) {
    return Promise.resolve().then(operation);
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new AuthorizationTimeoutError(stage, timeoutMs));
    }, timeoutMs);
    // Never keep the Node process alive solely for this timer — an
    // authorization call awaiting a timeout must not prevent a clean
    // process shutdown, the same reasoning every other short-lived timer
    // in this codebase (e.g. login-security.ts's own lockout windows)
    // already follows implicitly by being far shorter-lived than the
    // process itself; this one is explicit because it wraps arbitrary
    // caller-supplied work that could theoretically outlive the process.
    timer.unref?.();

    Promise.resolve()
      .then(operation)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(cause);
      });
  });
}
