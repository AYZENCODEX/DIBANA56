// scripts/src/test-oidc-post-cutover-verification.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5e-e: Post-Cutover Verification.
//
// The closing sub-phase of Phase 5 (5a through 5e-e). Where
// `test-sylo-oidc-cutover-checklist.ts` (5d-a) is "confirm every item
// passes BEFORE flipping the flag for a real cutover," this script is its
// AFTER counterpart — run once cutover (5d-b/5d-c) has actually happened
// against a real environment, to confirm the whole chain still holds
// together with real traffic flowing through it, not just at the moment
// the flag was flipped.
//
// WHAT THIS SCRIPT COMPOSES (DB-free, run for real in this sandbox)
//   - `test-oidc-cutover-gate.ts` (5d-c) — legacy-login gate decision table.
//   - `test-sylo-oidc-cutover-regression.ts` (5d-d) — the composed
//     before/after/rollback regression suite.
//   - `test-oidc-rollback-drill.ts` (5e-d) — confirms rollback is
//     mechanically ready, not just that it worked once during the drill.
//   - `test-oidc-client-rollout.ts` (5c-d/5e's original comparison-
//     monitoring tests) — still-passing baseline for the counters
//     everything above builds on.
// A single non-zero exit from ANY of these fails this script — same
// "don't trust a human to remember and re-run every file in the right
// order" reasoning `test-sylo-oidc-cutover-checklist.ts`'s own header
// gives for composing 5a/5b/5c's suites.
//
// WHAT THIS SCRIPT DOES NOT DO
//   - Read a real rollout flag, hit a real admin endpoint, or open a real
//     browser — every composed suite above is already DB-free/browser-free
//     by design; this script only sequences them and adds the printed
//     LIVE VERIFICATION checklist below for what still needs a live
//     environment, human-confirmed, the same "what was actually run vs.
//     what's still pending a live dependency" split every CHANGES doc in
//     this roadmap already discloses.
//   - Decide Season 3 is DONE by itself — see the printed summary's own
//     final line for the roadmap's actual §8 DONE/TESTED/VERIFIED/NEXT
//     gate (roadmap §1.4): this script gets Phase 5 to TESTED; VERIFIED
//     still needs a human confirming the LIVE items below against the
//     real target environment.
//
// Run: npx tsx scripts/src/test-oidc-post-cutover-verification.ts
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COMPOSED_SUITES = [
  "test-oidc-cutover-gate.ts",
  "test-sylo-oidc-cutover-regression.ts",
  "test-oidc-rollback-drill.ts",
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
  console.log("5e-e — Post-Cutover Verification: composing 5d-c/5d-d/5e-d/5c-d suites\n");

  const results = COMPOSED_SUITES.map((suite) => ({ suite, ok: runSuite(suite) }));
  const failedSuites = results.filter((r) => !r.ok).map((r) => r.suite);

  console.log(`
────────────────────────────────────────────────────────────────────────
COMPOSED SUITE RESULT: ${results.length - failedSuites.length}/${results.length} passed
${failedSuites.length > 0 ? `FAILED: ${failedSuites.join(", ")}` : "All composed suites passed."}
────────────────────────────────────────────────────────────────────────

LIVE VERIFICATION — confirm each of these against the real target
environment, AFTER a real cutover has actually happened, before calling
Season 3 VERIFIED in the roadmap's strict §1.4/§8 sense. This script
cannot verify any of these itself.
────────────────────────────────────────────────────────────────────────
  [ ] A real Sylo user, on a real browser, can sign in end to end via
      OIDC right now (discovery -> authorize -> callback -> PKCE ->
      token -> session-exchange -> landed on the app's home route).
  [ ] A direct POST /auth/login against the live API server, from a
      request whose Origin/Referer identifies Sylo, returns 403
      OIDC_REQUIRED — the old path is actually closed, not just
      documented as closed.
  [ ] A direct POST /auth/login for a DIFFERENT app (e.g. Ryft) still
      succeeds normally against the live API server — 5d's Sylo-only
      scope holds in production, not just in this script's simulation.
  [ ] GET /api/admin/oidc-rollout/sylo (requireDev) shows oidcEnabled:
      true, a non-zero oidc.total in stats, and health.healthy: true
      under real traffic.
  [ ] Trigger one deliberate OIDC failure (e.g. an expired code) against
      the live server and confirm it shows up in the admin GET's
      oidc.topErrors within one request — 5e-a/5e-b's error-code
      breakdown is observing real traffic, not just this script's
      synthetic records.
  [ ] Trigger one deliberate /oidc/callback failure in a real browser
      (e.g. reload the callback URL after it's already been consumed)
      and confirm it shows up under stats.callback — 5e-b's browser
      beacon (routes/oidc-client-errors.ts) is actually reachable and
      wired from a real page, not just unit-tested.
  [ ] Logout still works normally for a user who signed in via OIDC
      (Phase 6 territory, but a regression here would be a Phase 5
      problem — Phase 5 did not touch routes/auth.ts's logout handler).
  [ ] Confirm the rollback command from test-oidc-rollback-drill.ts's own
      LIVE DRILL checklist has been run at least once against this same
      real environment, not just in the DB-free simulation above.
────────────────────────────────────────────────────────────────────────
`);

  if (failedSuites.length > 0) {
    console.error("Composed suite failures — fix before running the LIVE VERIFICATION checklist.");
    process.exitCode = 1;
    return;
  }

  console.log("Composed DB-free verification: PASS. Season 3 remains TESTED, not yet VERIFIED — see the LIVE VERIFICATION checklist above.");
}

main();
