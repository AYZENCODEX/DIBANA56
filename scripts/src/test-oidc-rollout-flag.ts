// scripts/src/test-oidc-rollout-flag.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5c-a/5c-c/5c-e tests.
//
// Covers `set-oidc-rollout-flag.ts`'s `parseArgs()` — the one piece of the
// flag-flip CLI with a real decision table (which flags are required,
// which are mutually exclusive, what the Sylo-only safety guard checks),
// DB-free by design, same "inject the effectful boundary, unit-test the
// pure decision" discipline `test-rotate-jwt-signing-key.ts` (1D-d)
// established for the exact same kind of CLI script.
//
// NOT covered here (needs a live DB — same sandbox limitation every CHANGES
// doc in this roadmap discloses):
//   - `getOidcRolloutFlag()`/`setOidcRolloutFlag()` (lib/oidc-client-rollout.ts)
//     actually reading/writing Postgres — see test-oidc-client-rollout.ts's
//     own header for why that file can't run DB-free either.
//   - The CLI's actual Sylo-only refusal message printing to stderr and
//     setting a non-zero exit code — that's `main()`'s job, not
//     `parseArgs()`'s; this file only tests the parser.
//
// Run: npx tsx scripts/src/test-oidc-rollout-flag.ts
import assert from "node:assert/strict";
import { parseArgs } from "./set-oidc-rollout-flag";

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

console.log("parseArgs()");

test("--app + --enable parses to action='enable', allowNonSylo/dryRun default false", () => {
  const args = parseArgs(["--app=sylo", "--enable"]);
  assert.deepEqual(args, { app: "sylo", action: "enable", allowNonSylo: false, dryRun: false });
});

test("--app + --disable parses to action='disable'", () => {
  const args = parseArgs(["--app=sylo", "--disable"]);
  assert.equal(args.action, "disable");
});

test("--app is lowercased and trimmed", () => {
  const args = parseArgs(["--app= SYLO ", "--enable"]);
  assert.equal(args.app, "sylo");
});

test("--allow-non-sylo and --dry-run both flip their flags", () => {
  const args = parseArgs(["--app=ryft", "--enable", "--allow-non-sylo", "--dry-run"]);
  assert.equal(args.allowNonSylo, true);
  assert.equal(args.dryRun, true);
});

test("missing --app throws", () => {
  assert.throws(() => parseArgs(["--enable"]), /--app/);
});

test("missing both --enable and --disable throws", () => {
  assert.throws(() => parseArgs(["--app=sylo"]), /Exactly one/);
});

test("passing both --enable and --disable throws (ambiguous, not 'last one wins')", () => {
  assert.throws(() => parseArgs(["--app=sylo", "--enable", "--disable"]), /Exactly one/);
});

test("an unrecognized flag throws rather than being silently ignored", () => {
  assert.throws(() => parseArgs(["--app=sylo", "--enable", "--force"]), /Unrecognized argument/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
