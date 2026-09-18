// scripts/src/test-sylo-oidc-cutover-checklist.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5d-a: Pre-Cutover Checklist.
//
// "Confirm every item passes BEFORE flipping the flag for a real cutover"
// — this script is that gate, composing every DB-free suite 5a/5b/5c
// already built rather than trusting an operator to remember and re-run
// each one by hand in the right order (same reasoning
// `test-oidc-post-cutover-verification.ts`, 5e-e, gives for itself as the
// AFTER counterpart of this script).
//
// WHAT THIS SCRIPT COMPOSES (DB-free, run for real in this sandbox)
//   - `test-sylo-oidc-client-library.ts` (5a-a) — PKCE/state/authorize-URL
//     generation.
//   - `test-sylo-oidc-config-and-discovery.ts` (5a-f) — issuer/client-id/
//     redirect-uri resolution + provider-metadata fetch/cache.
//   - `test-sylo-oidc-e2e-login.ts` (5b-g) — the full simulated
//     login->callback round trip.
//   - `test-oidc-rollout-flag.ts` (5c-a/5c-c/5c-e) — the flag-flip CLI's
//     own argument-parsing safety guard.
//   - `test-oidc-client-rollout.ts` (5c-a/5c-b) — the CACHE_TTL_MS spot
//     check (see that file's own header for why it can't do more than
//     that DB-free).
// Plus one spot-check of its own: the documented cutover command,
// `set-oidc-rollout-flag.ts --app=sylo --enable`, parses to exactly the
// plan an operator expects — same "spot-check the real CLI invocation, not
// just re-derive from first principles" reasoning
// `test-oidc-rollback-drill.ts` (5e-d) applies to the opposite (`--disable`)
// direction.
//
// WHAT THIS SCRIPT DOES NOT DO (needs a live DB / real browser — same
// sandbox limitation every CHANGES doc in this roadmap already discloses)
//   - Actually flip the flag, read a real rollout-flag row, or hit a real
//     admin endpoint.
//   - A real browser completing discovery -> authorize -> callback -> PKCE
//     -> token -> session for a live Sylo test account — see the printed
//     LIVE CHECKLIST below for what still needs a live environment before
//     a real cutover.
//
// Run: npx tsx scripts/src/test-sylo-oidc-cutover-checklist.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./set-oidc-rollout-flag";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPOSED_SUITES = [
  "test-sylo-oidc-client-library.ts",
  "test-sylo-oidc-config-and-discovery.ts",
  "test-sylo-oidc-e2e-login.ts",
  "test-oidc-rollout-flag.ts",
  "test-oidc-client-rollout.ts",
] as const;

function runSuite(fileName: string): boolean {
  console.log(`\n── ${fileName} ${"─".repeat(Math.max(1, 60 - fileName.length))}`);
  const result = spawnSync("npx", ["tsx", path.join(__dirname, fileName)], {
    stdio: "inherit",
    cwd: path.resolve(__dirname, ".."),
  });
  return result.status === 0;
}

function main(): void {
  console.log("5d-a — Pre-Cutover Checklist: composing 5a/5b/5c suites\n");

  const results = COMPOSED_SUITES.map((suite) => ({ suite, ok: runSuite(suite) }));
  const failedSuites = results.filter((r) => !r.ok).map((r) => r.suite);

  console.log(`\n── spot-check: the documented cutover command ${"─".repeat(20)}`);
  let commandOk = true;
  try {
    const args = parseArgs(["--app=sylo", "--enable"]);
    assert.equal(args.app, "sylo");
    assert.equal(args.action, "enable");
    assert.equal(args.allowNonSylo, false, "cutover for the one Season-3-scoped app must never require --allow-non-sylo");
    console.log("  ok — 'set-oidc-rollout-flag.ts --app=sylo --enable' parses to app=sylo, action=enable, no override needed");
  } catch (err) {
    commandOk = false;
    console.error("  FAIL — cutover command spot-check");
    console.error(err);
  }

  console.log(`
────────────────────────────────────────────────────────────────────────
COMPOSED SUITE RESULT: ${results.length - failedSuites.length}/${results.length} passed${commandOk ? "" : " (plus the cutover-command spot-check FAILED)"}
${failedSuites.length > 0 ? `FAILED: ${failedSuites.join(", ")}` : "All composed suites passed."}
────────────────────────────────────────────────────────────────────────

LIVE CHECKLIST — confirm each of these against a real (ideally staging, not
production) environment before actually running the cutover command
against production. This script cannot verify any of these itself.
────────────────────────────────────────────────────────────────────────
  [ ] A real Sylo user, on a real browser, can complete discovery ->
      authorize -> callback -> PKCE -> token -> session-exchange while the
      flag is STILL OFF (i.e. OIDC works end to end as an opt-in path
      before it becomes the only path).
  [ ] GET /oidc/rollout-flags/sylo returns { oidcEnabled: false } against
      the real target DB right now (confirms today's baseline before you
      change it).
  [ ] Have the rollback command ready and tested once
      (scripts/src/test-oidc-rollback-drill.ts, 5e-d) so a real rollback
      isn't the first time it's ever been run.
  [ ] Confirm GET /api/admin/oidc-rollout/sylo (requireDev) is reachable
      and shows the expected pre-cutover shape (oidcEnabled: false,
      stats.oidc.total low/zero) against the real target environment.
────────────────────────────────────────────────────────────────────────
`);

  if (failedSuites.length > 0 || !commandOk) {
    console.error("Composed suite / spot-check failures — fix before running the LIVE CHECKLIST.");
    process.exitCode = 1;
    return;
  }

  console.log("Composed DB-free checklist: PASS. Proceed to the LIVE CHECKLIST above before running the real cutover command.");
}

main();
