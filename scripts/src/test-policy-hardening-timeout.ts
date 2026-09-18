/**
 * scripts/src/test-policy-hardening-timeout.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 25 (Production
 * Hardening) tests.
 *
 * Same shape as every other scripts/src/test-policy-*.ts: DB-free, no real
 * Express server needed, runnable anywhere with
 *   npx tsx scripts/src/test-policy-hardening-timeout.ts
 *
 * Phase 22E's own "provider timeout" cases (test-policy-security-
 * reliability.ts) only ever modeled a provider that REJECTS with a
 * timeout-shaped error — a provider that has already finished failing.
 * They never modeled a provider whose promise simply never settles at
 * all, because until this phase nothing in `lib/policy/*` could do
 * anything about that case anyway (the whole point of this file's own
 * header in `hardening/timeout.ts`). This suite is the first to actually
 * hang a fake provider/rule and confirm the pipeline stops waiting on it.
 *
 * Covers:
 *   - withTimeout() itself: disabled by undefined/0/negative timeoutMs
 *     (operation awaited unbounded, resolves/rejects exactly as it would
 *     bare); a slow-but-within-budget operation still resolves normally;
 *     a genuinely hanging operation times out with AuthorizationTimeoutError
 *     naming the right stage/budget; a synchronously-throwing operation is
 *     still caught and surfaces as a rejection, not an unhandled throw.
 *   - PolicyEngine's new `ruleTimeoutMs` option: a hanging rule times out
 *     and resolves to DENY/POLICY_EVALUATION_ERROR (the pre-existing
 *     fail-closed path, not a new one); a rule that finishes within budget
 *     is unaffected; omitting `ruleTimeoutMs` preserves the pre-Phase-25
 *     unbounded wait (a slow-but-finite rule still resolves).
 *   - authorize()'s new `enrichment.pipTimeoutMs` option: a hanging
 *     SubjectProvider (inside resolveSubject()) and a hanging
 *     SessionProvider (inside resolveContext()) both time out and resolve
 *     to DENY/PIP_ENRICHMENT_ERROR (Phase 22E's existing fail-closed path)
 *     instead of leaving the returned promise pending forever; omitting
 *     `pipTimeoutMs` preserves the unbounded wait for a slow-but-finite
 *     provider.
 *
 * Run: npx tsx scripts/src/test-policy-hardening-timeout.ts
 */

import assert from "node:assert/strict";
import type { Request } from "express";
import {
  authorize,
  PolicyEngine,
  PolicyInformationPoint,
  withTimeout,
  AuthorizationTimeoutError,
  type SubjectProvider,
  type SessionProvider,
  type Subject,
} from "../../artifacts/api-server/src/lib/policy";
import type { AuthenticatedUserLike } from "../../artifacts/api-server/src/lib/policy/pip/subject-adapter";
import type { SessionRecord } from "../../artifacts/api-server/src/lib/policy/pip/session-context-adapter";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

// Deliberately NOT unref()'d (unlike hardening/timeout.ts's own internal
// timer, and unlike hang() below) — something in this process needs to
// hold the event loop open across an awaited-but-unref'd production timer
// (withTimeout()'s own `timer.unref?.()`) for it to ever actually fire; a
// script with zero ref'd handles at all would let Node exit before any
// unref'd timer's deadline arrives, silently "passing" by never running
// the rest of main() at all rather than by any assertion succeeding.
function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(resolve, ms)).then(() => value) as Promise<T>;
}

/** A promise that never settles — models a genuinely hung dependency
 *  (a wedged DB connection, a network call with no deadline of its own),
 *  not merely a slow-but-finite one. Holds no timer/handle of its own, so
 *  it never keeps the process alive by itself. */
function hang<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

class HangingSubjectProvider implements SubjectProvider {
  calls = 0;
  async getSubject(_user: AuthenticatedUserLike | null | undefined): Promise<Subject | null> {
    this.calls++;
    return hang<Subject | null>();
  }
}

class HangingSessionProvider implements SessionProvider {
  calls = 0;
  async getSessionRecord(_jti: string): Promise<SessionRecord | null> {
    this.calls++;
    return hang<SessionRecord | null>();
  }
}

function fakeRequest(overrides: { user?: unknown; headers?: Record<string, string> } = {}): Request {
  return {
    user: overrides.user,
    headers: overrides.headers ?? {},
    body: {},
    query: {},
    ip: "203.0.113.9",
  } as unknown as Request;
}

async function main() {
  // Keeps the event loop alive (a ref'd handle) for the whole run. Several
  // cases below deliberately exercise withTimeout()'s own unref'd internal
  // timer (see hardening/timeout.ts's header on why it's unref'd in
  // production) — with zero other ref'd handles in this bare script, Node
  // would otherwise exit as soon as nothing else is scheduled, silently
  // abandoning those awaits instead of ever letting their timer fire.
  const keepAlive = setInterval(() => {}, 1000);
  console.log("Policy Engine — Phase 25 (Production Hardening: timeout limits) tests");

  // ── withTimeout() itself ────────────────────────────────────────────────

  await test("withTimeout(): timeoutMs undefined disables the timeout — a slow-but-finite operation still resolves, unbounded", async () => {
    const result = await withTimeout(() => delay(20, "done"), undefined, "test stage");
    assert.equal(result, "done");
  });

  await test("withTimeout(): timeoutMs of 0 and negative both disable the timeout, same as undefined", async () => {
    assert.equal(await withTimeout(() => delay(10, "a"), 0, "s"), "a");
    assert.equal(await withTimeout(() => delay(10, "b"), -5, "s"), "b");
  });

  await test("withTimeout(): operation finishing within budget resolves normally", async () => {
    const result = await withTimeout(() => delay(10, "fast enough"), 200, "test stage");
    assert.equal(result, "fast enough");
  });

  await test("withTimeout(): a genuinely hanging operation rejects with AuthorizationTimeoutError naming the stage and budget", async () => {
    await assert.rejects(
      withTimeout(() => hang<string>(), 20, 'rule "example"'),
      (err: unknown) => {
        assert.ok(err instanceof AuthorizationTimeoutError);
        assert.equal(err.stage, 'rule "example"');
        assert.equal(err.timeoutMs, 20);
        assert.match(err.message, /rule "example" exceeded its 20ms time budget/);
        return true;
      },
    );
  });

  await test("withTimeout(): a synchronously-throwing operation is still caught and surfaces as a rejection, not an unhandled throw", async () => {
    await assert.rejects(
      withTimeout(
        () => {
          throw new Error("boom");
        },
        50,
        "test stage",
      ),
      /boom/,
    );
  });

  await test("withTimeout(): an operation that rejects on its own (no timeout involved) still rejects with its own error, unchanged", async () => {
    await assert.rejects(withTimeout(() => Promise.reject(new Error("own failure")), 50, "test stage"), /own failure/);
  });

  // ── PolicyEngine's new ruleTimeoutMs option ─────────────────────────────

  await test("ruleTimeoutMs: a hanging rule times out and resolves to DENY/POLICY_EVALUATION_ERROR — the pre-existing fail-closed path, not a new one", async () => {
    const engine = new PolicyEngine({ ruleTimeoutMs: 20 });
    let neverReachedCalls = 0;
    engine.registerRule("hangs", () => hang());
    engine.registerRule("never-reached", () => {
      neverReachedCalls++;
      return null;
    });

    const decision = await engine.evaluate({
      subject: { userId: 1, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "t1", timestamp: new Date() },
    });

    assert.equal(decision.effect, "DENY");
    assert.equal(decision.reason, "POLICY_EVALUATION_ERROR");
    assert.match(decision.message ?? "", /Policy "hangs" threw during evaluation/);
    assert.equal(neverReachedCalls, 0); // short-circuited, same as any other rule throw
  });

  await test("ruleTimeoutMs: a rule that finishes within budget is unaffected — resolves ALLOW as normal", async () => {
    const engine = new PolicyEngine({ ruleTimeoutMs: 200 });
    engine.registerRule("fast-allow", async (request) => {
      await delay(10, undefined);
      return { effect: "ALLOW" as const, reason: "EXPLICIT_ALLOW" as const, requestId: request.context.requestId, evaluatedAt: new Date() };
    });

    const decision = await engine.evaluate({
      subject: { userId: 1, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "t2", timestamp: new Date() },
    });

    assert.equal(decision.effect, "ALLOW");
  });

  await test("ruleTimeoutMs omitted: preserves the pre-Phase-25 unbounded wait — a slow-but-finite rule still resolves", async () => {
    const engine = new PolicyEngine();
    engine.registerRule("slow-allow", async (request) => {
      await delay(30, undefined);
      return { effect: "ALLOW" as const, reason: "EXPLICIT_ALLOW" as const, requestId: request.context.requestId, evaluatedAt: new Date() };
    });

    const decision = await engine.evaluate({
      subject: { userId: 1, role: "member", authType: "session" },
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      context: { requestId: "t3", timestamp: new Date() },
    });

    assert.equal(decision.effect, "ALLOW");
  });

  // ── authorize()'s new enrichment.pipTimeoutMs option ────────────────────

  await test("pipTimeoutMs: a hanging SubjectProvider inside resolveSubject() times out and resolves authorize() to DENY/PIP_ENRICHMENT_ERROR, not a pending promise forever", async () => {
    const subjectProvider = new HangingSubjectProvider();
    const pip = new PolicyInformationPoint({ subject: subjectProvider });
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));

    const req = fakeRequest({ user: { userId: 1, role: "member" } });
    const outcome = await authorize({
      req,
      engine,
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      enrichment: { pip, pipTimeoutMs: 20 },
    });

    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "PIP_ENRICHMENT_ERROR");
    assert.match(outcome.decision.message ?? "", /PIP resolveSubject\(\) exceeded its 20ms time budget/);
    assert.equal(outcome.subject, null);
  });

  await test("pipTimeoutMs: a hanging SessionProvider inside resolveContext() times out and resolves authorize() to DENY/PIP_ENRICHMENT_ERROR", async () => {
    const sessionProvider = new HangingSessionProvider();
    const pip = new PolicyInformationPoint({ session: sessionProvider });
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));

    const req = fakeRequest({ user: { userId: 1, role: "member" } });
    const outcome = await authorize({
      req,
      engine,
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      // withSessionAge() (session-context-adapter.ts) no-ops without a
      // sessionId on the context (see its own `if (!context.sessionId)
      // return context;` guard) — a sessionId has to actually reach the
      // provider for this case to exercise the timeout at all, not just
      // resolve instantly because the provider was never called.
      enrichment: { pip, pipTimeoutMs: 20, sessionId: () => "session-abc" },
    });

    assert.equal(outcome.decision.effect, "DENY");
    assert.equal(outcome.decision.reason, "PIP_ENRICHMENT_ERROR");
    assert.match(outcome.decision.message ?? "", /PIP resolveContext\(\) exceeded its 20ms time budget/);
    assert.equal(sessionProvider.calls, 1); // confirms the provider really was reached, not skipped
  });

  await test("pipTimeoutMs omitted: preserves the unbounded wait — a slow-but-finite PIP provider still resolves to ALLOW", async () => {
    const subjectProvider: SubjectProvider = {
      async getSubject(user) {
        await delay(30, undefined);
        return user ? { userId: user.userId, role: "member", authType: "session" } : null;
      },
    };
    const pip = new PolicyInformationPoint({ subject: subjectProvider });
    const engine = new PolicyEngine();
    engine.registerRule("always-allow", (request) => ({
      effect: "ALLOW" as const,
      reason: "EXPLICIT_ALLOW" as const,
      requestId: request.context.requestId,
      evaluatedAt: new Date(),
    }));

    const req = fakeRequest({ user: { userId: 1, role: "member" } });
    const outcome = await authorize({
      req,
      engine,
      action: "sylo.vault.read",
      resource: { type: "vault_item", id: "1" },
      enrichment: { pip }, // no pipTimeoutMs
    });

    assert.equal(outcome.decision.effect, "ALLOW");
  });

  console.log("\nAll Phase 25 (Production Hardening: timeout limits) checks passed.");
  clearInterval(keepAlive);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
