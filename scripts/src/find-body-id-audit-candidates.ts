/**
 * scripts/src/find-body-id-audit-candidates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Route Integration Roadmap — Season C, Phase C34 (Delta re-audit).
 *
 * ── The gap this fills ──────────────────────────────────────────────────────
 * `check-ownership-gate-coverage.ts` (C33) only looks at a route's URL
 * `:param`s — that's what "gated" has meant for this whole series, C19A
 * through C33. But C26's own bug (`POST /projects/bulk-enroll`'s
 * `entityIds` array) and this phase's own two findings (`teams.ts`'s
 * `enroll-project`/`tasks/:taskId/enroll` — see this phase's CHANGES doc)
 * were never URL params at all — they were plain fields in `req.body`,
 * invisible to any `:id`-shaped filter no matter how carefully it's
 * written. C26 got found by hand, once, because someone happened to grep
 * for the literal string `"bulk"` in a route path. That filter is real but
 * narrow — it finds routes NAMED for bulk operations, not every route that
 * happens to take a client-supplied id (or array of ids) from the body and
 * use it to read or write a resource without checking who it belongs to.
 *
 * This script is that broader net — deliberately a CANDIDATE finder, not a
 * pass/fail gate like C33's. Determining whether a given body-id use is
 * safe (schema-filtered elsewhere, an audit-only field, actually
 * ownership-checked already, or a genuine gap) is a judgment call a static
 * grep cannot make — see this phase's own CHANGES doc for two examples
 * that needed that judgment call by hand (`tasks.ts`'s `logProjectReward`
 * turned out already safe; `teams.ts`'s two routes turned out not to be).
 * Treat this script's output as a reading list for the next re-audit, not
 * a CI gate.
 *
 * ── What it flags ───────────────────────────────────────────────────────
 * Two independent sweeps over `routes/*.ts`:
 *   1. "Named bulk" — `router.<verb>("...bulk...", ...)`, the literal
 *      filter this series has used since C26.
 *   2. "Body id-ish field" — any file referencing `req.body` together with
 *      an identifier that's genuinely id-shaped by convention (`id`/`ids`
 *      alone, camelCase `fooId`/`fooIds`, snake_case `foo_id`/`foo_ids` —
 *      see `looksLikeIdField()` below for the exact boundary) — broad on
 *      purpose, still expect false positives even with a precise name
 *      match (a file can define `entityIds` as a purely internal/derived
 *      list with no client input at all — `polymarket.ts`'s
 *      `extractTokenIds`, `resend-webhook.ts`'s `appliedRuleIds` are two
 *      from this run). A human still has to read each hit and check
 *      whether the name traces back to `req.body`, not just co-occurs with
 *      it in the same file.
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   tsx scripts/src/find-body-id-audit-candidates.ts
 *     Prints both sweeps' hits, file + line, to stdout. Exit code is
 *     always 0 — this is a report, not a check; nothing here should block
 *     a build.
 *
 * No `node_modules`/DB/network dependency — plain text scanning, same
 * "runs anywhere the source is checked out" property as `check-ownership-
 * gate-coverage.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROUTES_DIR = path.resolve(__dirname, "../../artifacts/api-server/src/routes");

const BULK_ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*["'][^"']*bulk[^"']*["']/i;

/** True for an identifier that's ACTUALLY id-shaped by TypeScript naming
 *  convention — `id`/`ids` alone, camelCase `fooId`/`fooIds` (capital `I`
 *  preceded by a lowercase/digit, the real camelCase boundary), or
 *  snake_case `foo_id`/`foo_ids`. Deliberately NOT a case-insensitive
 *  suffix match — an earlier version of this script matched any word
 *  ending in the two letters "i" + "d" case-insensitively, which pulled in
 *  `void`, `valid`, `invalid`, `paid`, `avoid`, `solid` (all lowercase
 *  throughout, no real id boundary) as false "candidates". Caught during
 *  this phase's own dry run — see this phase's CHANGES doc. */
function looksLikeIdField(name: string): boolean {
  if (name === "id" || name === "ids") return true;
  if (/_ids?$/.test(name)) return true;
  if (/[a-z0-9]Ids?$/.test(name)) return true;
  return false;
}

function main(): void {
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`routes/ directory not found at ${ROUTES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts")).sort();

  console.log("Route Integration Roadmap — Phase C34: body-id audit candidates\n");

  console.log("── Sweep 1: routes literally named for bulk operations ──────────────");
  let bulkHits = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (BULK_ROUTE_RE.test(line)) {
        console.log(`  ${file}:${i + 1}  ${line.trim()}`);
        bulkHits++;
      }
    });
  }
  console.log(`  (${bulkHits} route(s))\n`);

  console.log("── Sweep 2: files referencing req.body AND an id/ids-shaped identifier ──");
  console.log("  (broad on purpose — read each file, most hits are NOT client-supplied\n   identifiers; see this file's own header for two confirmed examples)\n");
  let fileHits = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
    if (!text.includes("req.body")) continue;
    const idMatches = [...text.matchAll(/\b(\w+)\b/g)]
      .map((m) => m[1])
      .filter((name) => name.length > 2 && looksLikeIdField(name));
    const uniqueNames = [...new Set(idMatches)];
    if (uniqueNames.length > 0) {
      console.log(`  ${file}  — candidate identifiers: ${uniqueNames.join(", ")}`);
      fileHits++;
    }
  }
  console.log(`\n  (${fileHits} file(s) — review each by hand)`);
}

main();
