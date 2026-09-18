// scripts/src/test-oidc-client-rollout.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5c-a/5c-b tests.
//
// Unlike every other `test-oidc-*.ts` file in this roadmap,
// `lib/oidc-client-rollout.ts` has no pure, DB-free decision function to
// unit-test in isolation — `getOidcRolloutFlag()`/`setOidcRolloutFlag()`
// ARE the read/write, there is no `evaluateXyz()` layer sitting in front of
// Postgres the way `oidc-cutover-gate.ts`'s `evaluateLegacyLoginGate()` or
// `rotate-jwt-signing-key.ts`'s `planRotation()` provide. This file is
// therefore the one spot-check this module's own contract admits of
// DB-free: `CACHE_TTL_MS`'s exact value, since `sylo-oidc-rollout-flag.ts`'s
// own header promises its frontend `ROLLOUT_FLAG_CACHE_TTL_MS` "matches the
// backend's own CACHE_TTL_MS" — a drift between the two would silently
// widen or shrink how long an operator's flag flip takes to reach the
// frontend relative to what the backend itself waits out, in a way neither
// file's own tests would otherwise catch.
//
// WHAT THIS FILE DOES NOT COVER (needs a live DB — same sandbox limitation
// every CHANGES doc in this roadmap already discloses)
//   - `getOidcRolloutFlag()` actually reading a row, or fail-safing to
//     `false` on a connection error.
//   - `setOidcRolloutFlag()`'s insert-or-update branch, or that it
//     invalidates this process's own cache entry before returning.
//   - The 15s TTL itself elapsing and the next read re-querying — would
//     need either a live DB or faking the system clock around a private
//     module-level `Map` this file has no access to.
// This import itself (`lib/oidc-client-rollout.ts`) pulls in
// `@workspace/db`/`drizzle-orm` at module load — the identical "no
// installed workspace `node_modules` in this sandbox" limitation
// `test-openid-configuration-endpoint.ts` and every 5c/5d/5e CHANGES doc in
// this roadmap already discloses for any file that imports a real DB
// client, not something new to this file.
//
// Run: npx tsx scripts/src/test-oidc-client-rollout.ts
import assert from "node:assert/strict";
import { CACHE_TTL_MS } from "../../artifacts/api-server/src/lib/oidc-client-rollout";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok — ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL — ${name}`);
    console.error(err);
  }
}

console.log("lib/oidc-client-rollout.ts — CACHE_TTL_MS spot-check");

test("CACHE_TTL_MS is 15s — must match sylo-oidc-rollout-flag.ts's ROLLOUT_FLAG_CACHE_TTL_MS exactly", () => {
  assert.equal(CACHE_TTL_MS, 15_000);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
