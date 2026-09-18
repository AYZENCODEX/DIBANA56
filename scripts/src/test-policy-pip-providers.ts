/**
 * scripts/src/test-policy-pip-providers.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers) tests.
 *
 * DB-free — uses fake providers throughout, same posture every other
 * scripts/src/test-policy-*.ts establishes for its own provider interface
 * (test-policy-risk-level.ts's FakeRiskLevelProvider, etc.).
 * `DrizzleAccountStateProvider`/`DrizzleSessionContextProvider`/
 * `DrizzleDeviceTrustProvider`/`DrizzleSubjectProvider` themselves are not
 * exercised here (no network/DB in this sandbox — same known limitation
 * every other Drizzle provider's test file already documents).
 *
 * Covers:
 *   - withAccountState: populates Subject.accountState, never mutates input
 *   - computeSessionAgeSeconds / withSessionAge: age math, no-sessionId
 *     no-op, unknown/revoked-session no-op, floors at 0
 *   - mapDeviceSignalToTrust / withDeviceTrust: trusted/unknown mapping,
 *     never "untrusted", missing/blank userAgent no-op
 *   - PolicyInformationPoint.resolveSubject: composes subject+risk
 *     providers when supplied, falls back to subjectFromAuthUser() when
 *     no SubjectProvider is configured, null passthrough
 *   - PolicyInformationPoint.resolveContext: composes session+device
 *     providers when supplied, no-ops when providers/opts are absent
 *   - Zero-provider PolicyInformationPoint behaves identically to calling
 *     the DB-free adapters directly (safe default)
 *
 * Run: npx tsx scripts/src/test-policy-pip-providers.ts
 */

import assert from "node:assert/strict";
import {
  withAccountState,
  type AccountStateProvider,
  computeSessionAgeSeconds,
  withSessionAge,
  type SessionRecord,
  type SessionContextProvider,
  mapDeviceSignalToTrust,
  withDeviceTrust,
  type DeviceSignal,
  type DeviceTrustProvider,
  PolicyInformationPoint,
  type SubjectProvider,
  type RiskProvider,
  type Subject,
  type RiskSignal,
} from "../../artifacts/api-server/src/lib/policy";
import { createPolicyContext } from "../../artifacts/api-server/src/lib/policy/policy-context";

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok — ${name}`))
    .catch((err) => {
      console.error(`  FAIL — ${name}`);
      throw err;
    });
}

// ─── Fakes ──────────────────────────────────────────────────────────────────

class FakeAccountStateProvider implements AccountStateProvider {
  constructor(private readonly state: string) {}
  async getAccountState(): Promise<string> {
    return this.state;
  }
}

class FakeSessionContextProvider implements SessionContextProvider {
  private readonly records = new Map<string, SessionRecord>();
  set(jti: string, record: SessionRecord): void {
    this.records.set(jti, record);
  }
  async getSessionRecord(jti: string): Promise<SessionRecord | null> {
    return this.records.get(jti) ?? null;
  }
}

class FakeDeviceTrustProvider implements DeviceTrustProvider {
  private readonly signals = new Map<string, DeviceSignal>();
  set(userId: number, userAgent: string, signal: DeviceSignal): void {
    this.signals.set(`${userId}:${userAgent}`, signal);
  }
  async getDeviceSignal(userId: number, userAgent: string): Promise<DeviceSignal> {
    return this.signals.get(`${userId}:${userAgent}`) ?? { seenBefore: false };
  }
}

class FakeSubjectProvider implements SubjectProvider {
  constructor(private readonly subject: Subject | null) {}
  async getSubject(user: { userId: number } | null | undefined): Promise<Subject | null> {
    // Same null/undefined -> null contract subjectFromAuthUser() itself
    // establishes — a fake that ignored `user` entirely would let
    // PolicyInformationPoint.resolveSubject's own null-passthrough
    // behavior go untested (see the two tests below).
    if (!user) return null;
    return this.subject;
  }
}

class FakeRiskProvider implements RiskProvider {
  constructor(private readonly signal: RiskSignal) {}
  async getRiskSignal(): Promise<RiskSignal> {
    return this.signal;
  }
}

function baseSubject(overrides: Partial<Subject> = {}): Subject {
  return { userId: 1, role: "user", authType: "session", ...overrides };
}

async function main() {
  console.log("Policy PIP providers — Phase 18 tests");

  // ── withAccountState ──────────────────────────────────────────────────
  await test("withAccountState: populates accountState from provider", async () => {
    const subject = baseSubject();
    const result = await withAccountState(subject, new FakeAccountStateProvider("active"));
    assert.equal(result.accountState, "active");
  });

  await test("withAccountState: never mutates the input Subject", async () => {
    const subject = baseSubject();
    await withAccountState(subject, new FakeAccountStateProvider("suspended"));
    assert.equal(subject.accountState, undefined);
  });

  await test("withAccountState: always overwrites a pre-set accountState", async () => {
    const subject = baseSubject({ accountState: "stale" });
    const result = await withAccountState(subject, new FakeAccountStateProvider("active"));
    assert.equal(result.accountState, "active");
  });

  // ── computeSessionAgeSeconds / withSessionAge ─────────────────────────
  await test("computeSessionAgeSeconds: whole seconds between createdAt and now", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const now = new Date("2026-01-01T00:05:30.000Z");
    assert.equal(computeSessionAgeSeconds({ createdAt }, now), 330);
  });

  await test("computeSessionAgeSeconds: floors at 0, never negative", () => {
    const createdAt = new Date("2026-01-01T00:05:00.000Z");
    const now = new Date("2026-01-01T00:00:00.000Z"); // "before" createdAt
    assert.equal(computeSessionAgeSeconds({ createdAt }, now), 0);
  });

  await test("withSessionAge: no-ops when context has no sessionId", async () => {
    const context = createPolicyContext();
    const provider = new FakeSessionContextProvider();
    const result = await withSessionAge(context, provider);
    assert.deepEqual(result, context);
    assert.equal(result.sessionAgeSeconds, undefined);
  });

  await test("withSessionAge: no-ops when provider has no record for the sessionId", async () => {
    const context = createPolicyContext({ sessionId: "unknown-jti" });
    const provider = new FakeSessionContextProvider();
    const result = await withSessionAge(context, provider);
    assert.equal(result.sessionAgeSeconds, undefined);
  });

  await test("withSessionAge: populates sessionAgeSeconds computed against context.timestamp", async () => {
    const context = createPolicyContext({ sessionId: "jti-1" });
    // Backdate the stamped timestamp deterministically for this test.
    (context as { timestamp: Date }).timestamp = new Date("2026-02-01T00:10:00.000Z");
    const provider = new FakeSessionContextProvider();
    provider.set("jti-1", { createdAt: new Date("2026-02-01T00:00:00.000Z") });
    const result = await withSessionAge(context, provider);
    assert.equal(result.sessionAgeSeconds, 600);
  });

  await test("withSessionAge: never mutates the input context", async () => {
    const context = createPolicyContext({ sessionId: "jti-2" });
    const provider = new FakeSessionContextProvider();
    provider.set("jti-2", { createdAt: new Date() });
    await withSessionAge(context, provider);
    assert.equal(context.sessionAgeSeconds, undefined);
  });

  // ── mapDeviceSignalToTrust / withDeviceTrust ──────────────────────────
  await test("mapDeviceSignalToTrust: seenBefore true -> trusted, false -> unknown", () => {
    assert.equal(mapDeviceSignalToTrust({ seenBefore: true }), "trusted");
    assert.equal(mapDeviceSignalToTrust({ seenBefore: false }), "unknown");
  });

  await test("withDeviceTrust: no-ops when userAgent is missing or blank", async () => {
    const context = createPolicyContext();
    const provider = new FakeDeviceTrustProvider();
    const missing = await withDeviceTrust(context, 1, undefined, provider);
    assert.equal(missing.deviceTrust, undefined);
    const blank = await withDeviceTrust(context, 1, "   ", provider);
    assert.equal(blank.deviceTrust, undefined);
  });

  await test("withDeviceTrust: populates deviceTrust from provider signal", async () => {
    const context = createPolicyContext();
    const provider = new FakeDeviceTrustProvider();
    provider.set(1, "TestAgent/1.0", { seenBefore: true });
    const result = await withDeviceTrust(context, 1, "TestAgent/1.0", provider);
    assert.equal(result.deviceTrust, "trusted");
  });

  await test("withDeviceTrust: unrecognized device maps to unknown, never untrusted", async () => {
    const context = createPolicyContext();
    const provider = new FakeDeviceTrustProvider();
    const result = await withDeviceTrust(context, 1, "NeverSeenBefore/1.0", provider);
    assert.equal(result.deviceTrust, "unknown");
  });

  // ── PolicyInformationPoint ────────────────────────────────────────────
  await test("PolicyInformationPoint: zero providers falls back to subjectFromAuthUser, context untouched", async () => {
    const pip = new PolicyInformationPoint();
    const context = createPolicyContext();
    const subject = await pip.resolveSubject({ userId: 42, role: "user", authType: "session" }, context);
    assert.deepEqual(subject, {
      userId: 42,
      role: "user",
      authType: "session",
      keyType: undefined,
      scopes: undefined,
      organizationId: undefined,
      assuranceMethods: undefined,
    });

    const resolvedContext = await pip.resolveContext(context, { userId: 42 });
    assert.deepEqual(resolvedContext, context);
  });

  await test("PolicyInformationPoint: null/undefined user always resolves to null subject", async () => {
    const pip = new PolicyInformationPoint({ subject: new FakeSubjectProvider(baseSubject()) });
    const context = createPolicyContext();
    assert.equal(await pip.resolveSubject(null, context), null);
    assert.equal(await pip.resolveSubject(undefined, context), null);
  });

  await test("PolicyInformationPoint: composes SubjectProvider + RiskProvider in resolveSubject", async () => {
    const subjectProvider = new FakeSubjectProvider(baseSubject({ accountState: "active" }));
    const riskProvider: RiskProvider = new FakeRiskProvider({
      anomalousIp: true,
      recentFailedLogins: 0,
    });
    const pip = new PolicyInformationPoint({ subject: subjectProvider, risk: riskProvider });
    const context = createPolicyContext({ ip: "203.0.113.9" });
    const subject = await pip.resolveSubject({ userId: 1, role: "user", authType: "session" }, context);
    assert.equal(subject?.accountState, "active");
    assert.equal(subject?.riskLevel, "medium"); // one signal alone -> medium (risk-level-adapter.ts)
  });

  await test("PolicyInformationPoint: resolveSubject skips risk enrichment when no RiskProvider configured", async () => {
    const pip = new PolicyInformationPoint({ subject: new FakeSubjectProvider(baseSubject()) });
    const context = createPolicyContext({ ip: "203.0.113.9" });
    const subject = await pip.resolveSubject({ userId: 1, role: "user", authType: "session" }, context);
    assert.equal(subject?.riskLevel, undefined);
  });

  await test("PolicyInformationPoint: composes SessionProvider + DeviceProvider in resolveContext", async () => {
    const sessionProvider = new FakeSessionContextProvider();
    sessionProvider.set("jti-9", { createdAt: new Date("2026-03-01T00:00:00.000Z") });
    const deviceProvider = new FakeDeviceTrustProvider();
    deviceProvider.set(7, "TestAgent/2.0", { seenBefore: true });

    const pip = new PolicyInformationPoint({ session: sessionProvider, device: deviceProvider });
    const context = createPolicyContext({ sessionId: "jti-9" });
    (context as { timestamp: Date }).timestamp = new Date("2026-03-01T00:02:00.000Z");

    const resolved = await pip.resolveContext(context, { userId: 7, userAgent: "TestAgent/2.0" });
    assert.equal(resolved.sessionAgeSeconds, 120);
    assert.equal(resolved.deviceTrust, "trusted");
  });

  await test("PolicyInformationPoint: resolveContext skips device enrichment when opts.userId is absent", async () => {
    const deviceProvider = new FakeDeviceTrustProvider();
    deviceProvider.set(7, "TestAgent/2.0", { seenBefore: true });
    const pip = new PolicyInformationPoint({ device: deviceProvider });
    const context = createPolicyContext();
    const resolved = await pip.resolveContext(context, { userAgent: "TestAgent/2.0" });
    assert.equal(resolved.deviceTrust, undefined);
  });

  console.log("\nAll Phase 18 PIP provider tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
