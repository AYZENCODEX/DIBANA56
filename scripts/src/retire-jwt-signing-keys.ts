// scripts/src/retire-jwt-signing-keys.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1D-e: Retention & Removal Policy.
//
// The other half of rotate-jwt-signing-key.ts (Phase 1D-d): that script
// decides when it's safe to START a key's overlap window (move it to
// 'retiring'); this one decides when it's safe to END it (move it to
// 'retired'). Whether it's safe depends only on time — see
// planRetirement()/isRetirementSafe() in lib/jwt-keys.ts, which are the
// pure decision this script's DB I/O just executes.
//
// SAFETY MODEL
//   A 'retiring' key is only moved to 'retired' once RETENTION_PERIOD_MS
//   (lib/jwt-keys.ts — MAX_TOKEN_LIFETIME_MS + CLOCK_SKEW_ALLOWANCE_MS) has
//   elapsed since its retiring_at. Rows that haven't reached that yet are
//   left untouched and reported with the timestamp they'll become eligible
//   at — this script never has a way to retire a key early; there is no
//   "force" flag. Rows still 'active' are never selected in the first
//   place (the query only reads status='retiring').
//
//   Each eligible row is retired with its own guarded UPDATE
//   (`WHERE kid = $1 AND status = 'retiring'`, asserting rowCount === 1)
//   inside its own transaction, so one row's concurrent-change failure
//   doesn't roll back another row's otherwise-safe retirement.
//
// "Retiring" a key does NOT delete its row — migration 078's trigger
// refuses DELETE outright. It only flips status/retired_at so
// resolveVerificationKeys() (Phase 1D-b) stops returning it — see the
// 1D-c mapping note in lib/jwt-keys.ts for why 'retired' is this codebase's
// name for the roadmap's illustrative REMOVED state.
//
// Usage:
//   npx tsx scripts/src/retire-jwt-signing-keys.ts [--dry-run]
//
//   --dry-run: reads current 'retiring' rows, prints the plan (which are
//   eligible now, which aren't and when they will be), writes nothing.
//
// Intentionally NOT scheduled/automatic — same "manual for now" discipline
// as rotate-jwt-signing-key.ts (Phase 1D-d's "Do not: ... implement
// automatic scheduling yet"). Run it by hand, or wire it into a cron/CI job
// later; that wiring is out of this sub-phase's scope.

import { pool } from "@workspace/db";
import { planRetirement, type RetiringKeyRow } from "../../artifacts/api-server/src/lib/jwt-keys";

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const { rows } = await pool.query<{ kid: string; retiring_at: Date }>(
    `SELECT kid, retiring_at FROM jwt_signing_keys WHERE status = 'retiring'`,
  );

  const retiringRows: RetiringKeyRow[] = rows.map((r) => ({ kid: r.kid, retiringAt: new Date(r.retiring_at) }));

  if (retiringRows.length === 0) {
    console.log("[retire-jwt-signing-keys] no 'retiring' rows found — nothing to do.");
    return;
  }

  const decisions = planRetirement(retiringRows);
  const eligible = decisions.filter((d) => d.safe);
  const notYet = decisions.filter((d) => !d.safe);

  for (const d of notYet) {
    if (!d.safe) {
      console.log(
        `[retire-jwt-signing-keys] kid='${d.kid}' not yet eligible — becomes retirable at ${d.eligibleAt.toISOString()}`,
      );
    }
  }

  if (eligible.length === 0) {
    console.log("[retire-jwt-signing-keys] no rows have reached their retention window yet — nothing to do.");
    return;
  }

  console.log(
    `[retire-jwt-signing-keys] ${eligible.length} row(s) eligible for retirement: ${eligible.map((d) => d.kid).join(", ")}`,
  );

  if (dryRun) {
    console.log("[retire-jwt-signing-keys] --dry-run: stopping here. No rows written.");
    return;
  }

  let retiredCount = 0;
  for (const d of eligible) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE jwt_signing_keys SET status = 'retired', retired_at = NOW() WHERE kid = $1 AND status = 'retiring'`,
        [d.kid],
      );
      if (result.rowCount !== 1) {
        // Someone else already moved this row (e.g. another run of this
        // script, or a manual change) between our SELECT and this UPDATE —
        // don't guess, just skip it rather than retiring the wrong thing.
        await client.query("ROLLBACK");
        console.warn(
          `[retire-jwt-signing-keys] kid='${d.kid}' was no longer 'retiring' when we tried to retire it (rowCount=${result.rowCount}) — skipped, no change made.`,
        );
        continue;
      }
      await client.query("COMMIT");
      retiredCount += 1;
      console.log(`[retire-jwt-signing-keys] kid='${d.kid}' is now 'retired' — no longer verification-eligible.`);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`[retire-jwt-signing-keys] failed to retire kid='${d.kid}', rolled back:`, err);
    } finally {
      client.release();
    }
  }

  console.log(`[retire-jwt-signing-keys] done — ${retiredCount}/${eligible.length} eligible row(s) retired.`);
}

main()
  .catch((err) => {
    console.error("[retire-jwt-signing-keys] unexpected error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
