/**
 * scripts/src/lib/ownership-route-test-kit.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Route Integration Roadmap — Season C, Phase C32 (Regression suite: manual
 * verification → automated tests).
 *
 * Generic harness for the roadmap's own three-case model, run against the
 * REAL production middleware chain for a route (`requireOwnership()` /
 * `requireXOwnership()` wrapper, the REAL exported `ResourceRefBuilder`),
 * not a reimplementation of either:
 *
 *   1. owner            → resource builder resolves ownerId === caller  → ALLOW (next() called)
 *   2. non-owner         → resource builder resolves ownerId !== caller → the route's configured deny
 *   3. nonexistent id    → resource builder finds no row at all         → the SAME configured deny
 *
 * ── Why mock the DB call, not the whole request ───────────────────────────
 * Every `ResourceRefBuilder` in this codebase does exactly ONE DB read
 * (`db.select(...).from(...).where(...).limit(1)` — the drizzle-query-
 * builder shape — or `db.execute(sql\`...\`)` — the raw-SQL shape kyc.ts
 * uses) and nothing else. `authorize()`/`enforce()`
 * (`lib/policy/pep/*`) — everything else in the chain this suite exercises
 * — are already DB-free by construction (see `pep/index.ts`'s own header).
 * So the ONE seam that needs a double is the resource builder's single DB
 * call; everything downstream of it (the real `PolicyEngine`, the real
 * `createResourceOwnershipRule()`, the real `enforce()` status/body
 * rendering) runs unmodified, exactly as it does in production. This is
 * intentionally NOT a full HTTP/supertest test against a running `app` —
 * see this phase's own `CHANGES_ROUTE_INTEGRATION_PHASE_C32.md` for why
 * that would need a real, migrated Postgres plus JWT-signed sessions to
 * even get past `requireAuth`, which is a heavier, separately-valuable
 * test (full end-to-end) this phase does not attempt to also build.
 *
 * ── Two DB call shapes, two mocks ──────────────────────────────────────────
 * `withMockedSelect()` covers every builder using drizzle's query builder
 * (`vaultEntryResource`, and every other `db.select({...}).from(table)
 * .where(eq(table.id, id)).limit(1)` builder in this codebase — see e.g.
 * vault-entity-links.ts's own `vaultEntryResource`). `withMockedExecute()`
 * covers the one raw-SQL shape (`kycEntryResource`, `kyc.ts` — a legacy
 * table this codebase's own drizzle schema does not model, so its builder
 * uses `db.execute(sql\`SELECT user_id FROM kyc_entries WHERE id = $
 * {id}\`)` returning `{ rows: [...] }` instead of a drizzle result array).
 * Both restore the original `db.select`/`db.execute` in a `finally`, so a
 * mock never leaks into a later case even if an assertion throws mid-case.
 *
 * ── Requires DATABASE_URL, but never actually connects ────────────────────
 * `@workspace/db` throws at import time if `DATABASE_URL` is unset (see
 * `lib/db/src/index.ts`) — importing any route file transitively imports
 * it, so this suite (and its runner script) needs the env var PRESENT.
 * It never needs to be a REACHABLE database, though: `pg.Pool` never
 * connects at construction, only when a query actually runs — and by the
 * time any resource builder in this suite runs one, `withMockedSelect()`/
 * `withMockedExecute()` has already replaced `db.select`/`db.execute`, so
 * the real pool is never touched. See this phase's own CHANGES doc for the
 * exact `DATABASE_URL=...` placeholder value used to run this suite.
 */

import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";

// ─── Fixed test identities — reused across every case in every suite ───────
export const OWNER_USER_ID = 1001;
export const OTHER_USER_ID = 2002;
export const NONEXISTENT_ROUTE_ID = "999999";
export const EXISTING_ROUTE_ID = "42";

export interface CapturedResponse {
  /** Mirrors Express's own default — `res.statusCode` is 200 until
   *  `.status()` is called, so a route whose `onDeny` calls `res.json()`
   *  without ever calling `.status()` first (e.g. value-history.ts's
   *  `res.json([])` deny body) is captured accurately as a 200, not as
   *  `undefined`. */
  statusCode: number;
  body: unknown;
  jsonCalled: boolean;
}

export function fakeRes(): { res: Response; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 200, body: undefined, jsonCalled: false };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res as unknown as Response;
    },
    json(body: unknown) {
      captured.body = body;
      captured.jsonCalled = true;
      return res as unknown as Response;
    },
  };
  return { res: res as unknown as Response, captured };
}

export function fakeReq(params: Record<string, string>, user: { userId: number; role?: string } | null): Request {
  return {
    params,
    query: {},
    body: {},
    headers: {},
    user: user === null ? undefined : { role: "user", ...user },
  } as unknown as Request;
}

/** One route's ownership-gated middleware, already fully configured
 *  (action + onDeny bound) — the exact function type `requireOwnership()`/
 *  `requireXOwnership()` returns. */
export type OwnershipMiddleware = (req: Request, res: Response, next: NextFunction) => Promise<void> | void;

/** Runs `middleware` once against a fresh fake req/res, with `params` and
 *  `user` as given. Returns whether `next()` was called (ALLOW) alongside
 *  whatever the fake `res` captured (the deny body, if any). */
export async function invoke(
  middleware: OwnershipMiddleware,
  params: Record<string, string>,
  user: { userId: number; role?: string } | null,
): Promise<{ nextCalled: boolean; captured: CapturedResponse }> {
  const { res, captured } = fakeRes();
  const req = fakeReq(params, user);
  let nextCalled = false;
  await middleware(req, res, ((err?: unknown) => {
    if (err) throw err;
    nextCalled = true;
  }) as NextFunction);
  return { nextCalled, captured };
}

/** Monkey-patches `db.select(...).from(...).where(...).limit(...)` for the
 *  duration of `fn`, resolving to `rows` — the drizzle-query-builder shape
 *  every `ResourceRefBuilder` in this codebase uses except `kycEntryResource`
 *  (see file header). Restores the original in `finally`. */
export async function withMockedSelect<T>(db: { select: unknown }, rows: unknown[], fn: () => Promise<T>): Promise<T> {
  const original = db.select;
  (db as { select: unknown }).select = () => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  });
  try {
    return await fn();
  } finally {
    (db as { select: unknown }).select = original;
  }
}

/** Same idea for `db.execute(sql\`...\`)`, resolving to `{ rows }` — the
 *  raw-SQL shape `kycEntryResource` uses (see file header). */
export async function withMockedExecute<T>(db: { execute: unknown }, rows: unknown[], fn: () => Promise<T>): Promise<T> {
  const original = db.execute;
  (db as { execute: unknown }).execute = async () => ({ rows });
  try {
    return await fn();
  } finally {
    (db as { execute: unknown }).execute = original;
  }
}

/** Which DB-call shape a given resource builder uses, and how to turn a
 *  resolved owner id (or `null`, for "no row found") into the row shape
 *  that builder's own destructuring expects. */
export interface OwnerRowMock {
  withMock: <T>(db: any, rows: unknown[], fn: () => Promise<T>) => Promise<T>;
  /** e.g. `(ownerId) => [{ userId: ownerId }]` for a drizzle `.select({
   *  userId: table.userId })` builder, or `(ownerId) => [{ user_id:
   *  ownerId }]` for kycEntryResource's raw-SQL column name. */
  rowFor: (ownerId: number) => unknown[];
}

export const DRIZZLE_USER_ID_ROW: OwnerRowMock = {
  withMock: withMockedSelect,
  rowFor: (ownerId) => [{ userId: ownerId }],
};

export const RAW_SQL_USER_ID_ROW: OwnerRowMock = {
  withMock: withMockedExecute,
  rowFor: (ownerId) => [{ user_id: ownerId }],
};

/** One route's full spec — everything `runOwnershipRouteSuite()` needs to
 *  exercise the roadmap's three cases against the real middleware. */
export interface OwnershipRouteSpec {
  /** e.g. "vault.ts — GET /vault/:id/gas". Shown in test output. */
  label: string;
  /** Builds a FRESH middleware instance per case — mirrors how
   *  `router.get(path, requireAuth, requireXOwnership(action, onDeny),
   *  handler)` builds one at route-registration time (some wrappers close
   *  over a per-call `onDeny`, so a shared instance across cases would
   *  still be correct, but a fresh one per case matches production more
   *  closely and costs nothing). */
  middleware: () => OwnershipMiddleware;
  db: any;
  ownerRow: OwnerRowMock;
  expectedDenyStatus: number;
  expectedDenyBody: unknown;
}

interface RunnerState {
  passed: number;
  failed: number;
}
const state: RunnerState = { passed: 0, failed: 0 };

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    state.passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    state.failed++;
    console.error(`  FAIL — ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Runs all three roadmap cases for one route spec. */
export async function runOwnershipRouteSuite(spec: OwnershipRouteSpec): Promise<void> {
  await check(`${spec.label} — owner is allowed (next() called, no response sent)`, async () => {
    await spec.ownerRow.withMock(spec.db, spec.ownerRow.rowFor(OWNER_USER_ID), async () => {
      const { nextCalled, captured } = await invoke(
        spec.middleware(),
        { id: EXISTING_ROUTE_ID },
        { userId: OWNER_USER_ID },
      );
      assert.equal(nextCalled, true, "expected next() to be called for the resource owner");
      assert.equal(captured.jsonCalled, false, "expected no deny response to be sent for the resource owner");
    });
  });

  await check(`${spec.label} — non-owner is denied (${spec.expectedDenyStatus}, configured body)`, async () => {
    await spec.ownerRow.withMock(spec.db, spec.ownerRow.rowFor(OWNER_USER_ID), async () => {
      const { nextCalled, captured } = await invoke(
        spec.middleware(),
        { id: EXISTING_ROUTE_ID },
        { userId: OTHER_USER_ID },
      );
      assert.equal(nextCalled, false, "expected next() NOT to be called for a non-owner");
      assert.equal(captured.statusCode, spec.expectedDenyStatus);
      assert.deepEqual(captured.body, spec.expectedDenyBody);
    });
  });

  await check(`${spec.label} — nonexistent id is denied (same body as non-owner)`, async () => {
    await spec.ownerRow.withMock(spec.db, [], async () => {
      const { nextCalled, captured } = await invoke(
        spec.middleware(),
        { id: NONEXISTENT_ROUTE_ID },
        { userId: OWNER_USER_ID },
      );
      assert.equal(nextCalled, false, "expected next() NOT to be called for a nonexistent id");
      assert.equal(captured.statusCode, spec.expectedDenyStatus);
      assert.deepEqual(captured.body, spec.expectedDenyBody);
    });
  });
}

export function summarize(): void {
  console.log(`\n${state.passed} passed, ${state.failed} failed`);
  if (state.failed > 0) process.exit(1);
}
