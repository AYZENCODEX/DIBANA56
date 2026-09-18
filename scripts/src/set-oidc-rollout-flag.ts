// scripts/src/set-oidc-rollout-flag.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 3, Phase 5c-c (enable) / 5c-e + 5e-d (rollback) /
// 5d-b (cutover, same mechanism, different moment).
//
// The CLI twin of `routes/admin-oidc-rollout.ts`'s PATCH endpoint — that
// route's own header says it plainly: this script's PATCH endpoint is the
// same mechanism reached through the admin API instead of a CLI; pick
// whichever is convenient, both call the identical
// `lib/oidc-client-rollout.ts` helper (`setOidcRolloutFlag()`).
//
// SAFETY MODEL — why Sylo only, why an explicit override exists
// Season 3 migrates exactly one app_id: Sylo. Flipping the flag for any
// OTHER app_id before that app has its own OIDC client wiring (Phase 5a/5b
// equivalent) would silently start redirecting its logged-out visitors into
// an OIDC flow that doesn't exist for them yet — `App.tsx`'s
// `ProtectedRoute` reads this same flag (5c-c) to decide whether to start
// `startSyloOidcLogin()`, which is entirely Sylo-shaped (its
// `redirect_uri`, its registered `client_id`). This script refuses to touch
// any app_id outside `ALLOWED_WITHOUT_OVERRIDE` unless `--allow-non-sylo`
// is passed explicitly — the CLI's equivalent of
// `routes/admin-oidc-rollout.ts`'s PATCH body `{ allowNonSylo: true }`,
// deliberately duplicated here rather than imported from a shared module
// (see that route's own header for why: small enough logic that
// duplicating the one `if` is lower risk than a shared module a `tsx`-run
// CLI script and an Express route would both have to agree to import
// correctly).
//
// Usage:
//   npx tsx scripts/src/set-oidc-rollout-flag.ts --app=sylo --enable
//   npx tsx scripts/src/set-oidc-rollout-flag.ts --app=sylo --disable
//   npx tsx scripts/src/set-oidc-rollout-flag.ts --app=ryft --enable --allow-non-sylo
//   npx tsx scripts/src/set-oidc-rollout-flag.ts --app=sylo --disable --dry-run
//
//   --app=<id>        required. Lowercased/trimmed before use.
//   --enable/--disable  required, mutually exclusive. Sets oidc_enabled.
//   --allow-non-sylo   required to target any app_id other than "sylo".
//   --dry-run          prints the resolved plan (current value -> target
//                      value) and writes nothing.

import { getOidcRolloutFlag, setOidcRolloutFlag } from "../../artifacts/api-server/src/lib/oidc-client-rollout";
import { pool } from "@workspace/db";

/** Same "Sylo only" boundary as every other 5c/5d file — see
 * `lib/oidc-cutover-gate.ts`'s own `CUTOVER_SCOPED_APP_IDS` and
 * `routes/admin-oidc-rollout.ts`'s own `ALLOWED_WITHOUT_OVERRIDE`, each a
 * deliberate duplicate of this identical `Set`. */
const ALLOWED_WITHOUT_OVERRIDE = new Set(["sylo"]);

export interface ParsedSetOidcRolloutFlagArgs {
  app: string;
  action: "enable" | "disable";
  allowNonSylo: boolean;
  dryRun: boolean;
}

/**
 * Pure argument parser — no I/O, no process.exit — so it's unit-testable
 * without a database connection or a real CLI invocation, same "inject the
 * effectful boundary" discipline every other script in this roadmap
 * follows (see `rotate-jwt-signing-key.ts`'s own `planRotation()`).
 * Throws on anything malformed or ambiguous; `main()` below is the only
 * caller that turns a thrown error into a printed message + non-zero exit.
 */
export function parseArgs(argv: string[]): ParsedSetOidcRolloutFlagArgs {
  let app: string | undefined;
  let enable = false;
  let disable = false;
  let allowNonSylo = false;
  let dryRun = false;

  for (const raw of argv) {
    if (raw.startsWith("--app=")) {
      app = raw.slice("--app=".length).trim().toLowerCase();
    } else if (raw === "--enable") {
      enable = true;
    } else if (raw === "--disable") {
      disable = true;
    } else if (raw === "--allow-non-sylo") {
      allowNonSylo = true;
    } else if (raw === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unrecognized argument: ${raw}`);
    }
  }

  if (!app) throw new Error("--app=<id> is required");
  if (enable === disable) {
    // Covers both "neither" and "both" — exactly one of --enable/--disable
    // must be given; there is no meaningful default action for a flag this
    // consequential.
    throw new Error("Exactly one of --enable or --disable is required");
  }

  return { app, action: enable ? "enable" : "disable", allowNonSylo, dryRun };
}

async function main(): Promise<void> {
  let args: ParsedSetOidcRolloutFlagArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[set-oidc-rollout-flag] ${(err as Error).message}`);
    console.error(
      "[set-oidc-rollout-flag] usage: --app=<id> (--enable|--disable) [--allow-non-sylo] [--dry-run]",
    );
    process.exitCode = 1;
    return;
  }

  if (!ALLOWED_WITHOUT_OVERRIDE.has(args.app) && !args.allowNonSylo) {
    console.error(
      `[set-oidc-rollout-flag] refusing to touch app_id="${args.app}": Season 3 only migrates Sylo. ` +
        `Pass --allow-non-sylo once "${args.app}" has its own OIDC client wiring (Phase 5a/5b equivalent).`,
    );
    process.exitCode = 1;
    return;
  }

  const targetEnabled = args.action === "enable";
  const before = await getOidcRolloutFlag(args.app);

  console.log(
    `[set-oidc-rollout-flag] app_id="${args.app}": currently oidc_enabled=${before}, target oidc_enabled=${targetEnabled}`,
  );

  if (args.dryRun) {
    console.log("[set-oidc-rollout-flag] --dry-run: stopping here. No row written.");
    return;
  }

  if (before === targetEnabled) {
    console.log("[set-oidc-rollout-flag] no change — flag already at target value.");
    return;
  }

  await setOidcRolloutFlag(args.app, targetEnabled);
  console.log(`[set-oidc-rollout-flag] done — app_id="${args.app}" oidc_enabled is now ${targetEnabled}.`);
}

main()
  .catch((err) => {
    console.error("[set-oidc-rollout-flag] unexpected error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
