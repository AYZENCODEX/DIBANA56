/**
 * scripts/src/check-ownership-gate-coverage.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Route Integration Roadmap — Season C, Phase C33 (Pattern documentation +
 * CI lint guard), part 2 of 2. Part 1 is
 * `artifacts/api-server/src/lib/policy/OWNERSHIP_GATING_GUIDE.md` — read
 * that first if you're deciding how to gate a new route; this file only
 * enforces the convention, it doesn't explain it.
 *
 * ── Why C19A-C32 stayed manual audits ──────────────────────────────────────
 * Nothing anywhere in this codebase ever REQUIRED a new `:id` route to go
 * through `requireOwnership()`/`authorizeMany()` — every route in this
 * series got gated because a human, phase by phase, grepped for
 * `router\.(get|post|patch|delete)\("[^"]*:id` and manually checked each
 * hit. That works for a one-time sweep; it does nothing to stop the NEXT
 * ungated `:id` route from shipping. This script is that stop.
 *
 * ── What this checks, precisely ────────────────────────────────────────────
 * For every `router.<verb>("path", ...middleware, handler)` call in every
 * `routes/*.ts` file, where `path` contains a `:param` segment: is one of
 * the following true?
 *   1. One of the middleware arguments is itself a direct call to a known
 *      PEP wiring function (`requireOwnership`, `requirePermission`,
 *      `requirePolicy`, `requireRole`, `requireStepUp`, `requireApproval`,
 *      `authorizeMany` — the full `lib/policy/pep/*` surface), OR
 *   2. One of the middleware arguments is a call to a function DEFINED
 *      ANYWHERE IN `routes/*.ts` whose own body contains a call to one of
 *      those same names — the "thin wrapper" pattern
 *      (`requireVaultEntryOwnership`, `requireLocalAccountOwnership`, etc.)
 *      every migrated file in this series uses (see the GUIDE's "Wiring it
 *      up" section). This is repo-wide, not same-file-only, because
 *      several of these wrappers are themselves imported across files —
 *      e.g. `value-history.ts` imports and calls `local-accounts.ts`'s own
 *      `requireLocalAccountOwnership` directly, same as `exchange-api.ts`
 *      imports `kyc.ts`'s exported `requireKycEntryOwnership` (see
 *      `test-route-ownership-regression.ts`'s header for that same
 *      distinction). A same-file-only check would wrongly flag both as
 *      unwired. This does NOT trace actual `import` statements (name-based
 *      matching across the whole `routes/` directory is enough for this
 *      codebase's naming convention — every wrapper name so far is unique
 *      to one definition) — see "Known limitations" below for what that
 *      trades away.
 * If neither holds, the route is flagged as an "unwired param route".
 *
 * This is deliberately a SHAPE check, not a correctness check — it cannot
 * tell you the resource builder resolves the right column, or that the
 * `onDeny` body is the right one. That's still code review's job (and
 * `test-route-ownership-regression.ts`'s, for the two builders it can
 * reach — see that file's own header for why it can't reach everything
 * this script can see).
 *
 * ── Baseline: grandfather what already exists, block what's new ───────────
 * At the time this script shipped, `routes/` had unwired param routes that
 * predate this check by anywhere from one to dozens of phases — some
 * genuinely need a resource builder still (C33's own follow-up batch, see
 * `OWNERSHIP_GATING_GUIDE.md`), some are deliberately public/decision-
 * pending (`GET /projects/:id/dates` — C29, still awaiting owner sign-off),
 * some aren't ownership-shaped at all (admin-only `:id` routes gated by
 * `requireAdmin`/role instead). Failing CI today on all of those would
 * block unrelated work over a backlog this ONE phase was never scoped to
 * clear (that's C33's follow-up batch's job, and partly C28/C29's
 * decision-gated job). So: every unwired param route found at baseline-
 * generation time is written to `ownership-gate-baseline.json` next to this
 * file. A future run only fails for an unwired param route that is NOT in
 * that file — i.e. a genuinely NEW gap. Baseline entries for routes that
 * get properly wired later simply stop matching anything and go stale;
 * `--update-baseline` (below) drops stale entries automatically, so the
 * baseline only ever shrinks unless someone deliberately adds a new
 * ungated route (which is exactly the case this script exists to catch).
 *
 * ── Usage ────────────────────────────────────────────────────────────────
 *   tsx scripts/src/check-ownership-gate-coverage.ts
 *     Fails (exit 1) if any unwired param route is NOT in the baseline.
 *     Prints every such route, plus a summary of baseline/new/total counts.
 *
 *   tsx scripts/src/check-ownership-gate-coverage.ts --update-baseline
 *     Regenerates `ownership-gate-baseline.json` from the CURRENT unwired
 *     set (drops stale entries for routes that got wired or removed, adds
 *     any new ones found). Run this deliberately, in its own commit, when
 *     you've reviewed a newly-flagged route and decided it's an accepted
 *     gap (not by reflex to make a failing check pass — see the GUIDE).
 *
 * ── Known limitations (false negatives this script CANNOT see) ────────────
 * - A wrapper name reused for two unrelated definitions in different files
 *   (none exist today — see above) would let one satisfy the other's
 *   routes. The `--update-baseline` review step is the backstop: a newly-
 *   flagged route that's actually wired via a real, distinctly-named
 *   wrapper will show up, get inspected, and either turns out genuinely
 *   unwired (fix it) or reveals a naming collision worth renaming on its
 *   own merits.
 * - Wiring two calls deep (a wrapper that calls a second local function
 *   that itself calls `requireOwnership`) is invisible — `collectCalledNames`
 *   only looks at the wrapper's own body, one level. No file in this
 *   codebase nests that deep today (see that function's own comment).
 * - A route gated by ownership logic OUTSIDE the `requireOwnership()`/
 *   `authorizeMany()` family entirely (raw SQL `WHERE ... AND user_id =`,
 *   same as most of the C27 bulk-family routes before that phase) is
 *   correctly SAFE but will still show as "unwired" by this script's own
 *   definition — this script only checks for PDP/PEP wiring, not for
 *   ownership-safety by any means. That's intentional (see the GUIDE for
 *   why raw-SQL scoping and PDP wiring are different, both-valid layers)
 *   — such routes land in the baseline like any other pre-existing gap,
 *   not because they're insecure, but because this script has no way to
 *   verify hand-written SQL is correctly scoped. Confirming that is still
 *   a code-review judgment call.
 *
 * ── Season D, Phase D8 update — three detection gaps closed ───────────────
 * D1-D7 (Route Integration Roadmap, Season D) triaged this script's own
 * baseline by hand and found ~99 routes that were already safely gated but
 * showed up as "unwired" only because this script couldn't see the shape —
 * not because the route was actually a gap. Three shapes, each documented
 * in its own phase's CHANGES file:
 *
 *   1. Bare (uncalled) platform-role middleware — `router.patch(path,
 *      requireAdmin, handler)`, not `requireAdmin(...)`. The original
 *      `isWired()` only ever inspected `ts.isCallExpression(arg)`, so a
 *      middleware reference passed BARE (no parens — `requireAdmin`,
 *      `requireDev` in `middlewares/auth.ts` are ordinary Express
 *      middleware functions, not factories) was invisible. See D3's
 *      `projects.ts`/`tasks.ts` findings (bucket ক, 9 routes) —
 *      `PEP_WIRING_BARE_IDENTIFIERS` below.
 *   2. `requireRoles(...)` — a role-middleware FACTORY (`middlewares/
 *      auth.ts`), a different name from `requireRole` (singular,
 *      `lib/policy/pep/middleware.ts`) that was already in
 *      `PEP_WIRING_NAMES`. Same D3 finding, same fix class — just added to
 *      the existing call-expression name set.
 *   3. Inline handler-body wiring — a decision made INSIDE the route
 *      handler, not as a router-level middleware argument at all. Two
 *      distinct sub-shapes, both found by D1's `teams.ts` triage and
 *      confirmed repeated in `finance-invoices.ts` (D2), `tasks.ts` (D3),
 *      and `teams.ts`'s own D6 conversion (`createGroupMembershipRule()`,
 *      42 routes):
 *        (a) `const x = await authorize({ engine, action, resource });
 *             if (x.decision.effect !== "ALLOW") { res.status(4xx)...;
 *             return; }` — real PDP enforcement, just not expressed as a
 *             router-middleware call (every route in this shape needed
 *             something else — a 400 body check, a different resource's
 *             404, or an already-fetched row's column — to run FIRST; see
 *             `teams.ts`'s own header for why). `handlerHasInlineWiring()`
 *             below looks for the `.decision.effect` comparison itself —
 *             that property path is unique to a real PDP decision object
 *             (D7's AUDIT-only `authorize()` wrapper calls, e.g. `finance.
 *             ts`'s `auditFinanceOwnership()`, deliberately discard the
 *             return value and never check `.decision.effect` — so they do
 *             NOT match this and correctly stay in the baseline; audit-only
 *             wiring adds observability, not a gate, and this script's job
 *             is to find gates).
 *        (b) `if (req.user!.role !== "admin" && ... ) { res.status(4xx)...;
 *             return; }` — a hand-rolled platform-role check with NO
 *             `requireAdmin`-style middleware at all (D1's `teams.ts`
 *             bucket ক, 4 routes; also present standalone in `credits.ts`).
 *             Recognized only when it's actually gating (the `if`-branch
 *             calls `res.status(401` or `res.status(403`), to avoid
 *             matching an incidental `role !== "..."` comparison used for
 *             something other than access control.
 *      Neither sub-shape is traced back to a specific PolicyEngine/rule
 *      registration — that would require resolving `registerRule()` call
 *      sites back to their `authorize({engine: ...})` call sites across the
 *      file, real semantic analysis this script's AST-only, syntax-level
 *      design (see header above) deliberately doesn't do. The `.decision.
 *      effect` check is a proxy: every inline `authorize()` call in this
 *      codebase that gates (as opposed to just audits) checks that field,
 *      so matching the field is equivalent to matching "this call is a
 *      gate" without needing to resolve which engine backs it.
 *
 * `--update-baseline` after this fix drops every route in these three
 * shapes from `ownership-gate-baseline.json` (they were never actually
 * gaps) without changing what the script MEANS by "wired" — still only the
 * `requireOwnership()`/`authorizeMany()` PDP family (directly, via a
 * router-level bare/called middleware reference, or via an inline
 * `authorize()` call whose result actually gates the response) plus the
 * pre-existing legacy platform-role middleware this update also recognizes.
 * Raw-SQL ownership scoping and audit-only `authorize()` wiring (D7) are
 * still, deliberately, NOT recognized — see "Known limitations" above,
 * which this update does not change.
 *
 * No `node_modules`/DB/network dependency — this only parses `.ts` source
 * text with the TypeScript compiler API (same syntax-only approach
 * `check-all.ts` already uses), so it runs anywhere this repo's source is
 * checked out.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../");
const ROUTES_DIR = path.join(REPO_ROOT, "artifacts/api-server/src/routes");
const BASELINE_PATH = path.join(__dirname, "ownership-gate-baseline.json");

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

/** The full `lib/policy/pep/*` wiring surface (middleware.ts + authorize-many.ts),
 *  plus `requireRoles` (Season D, Phase D8 — a `middlewares/auth.ts` role-
 *  middleware FACTORY, a different name from the PDP's own `requireRole`
 *  singular, but the same "call-expression in the middleware-arg list"
 *  shape this set already matches; see file header, item 2).
 *  A route is "wired" if one of ITS OWN middleware args calls one of these
 *  directly, or calls a same-file local function whose body calls one of
 *  these. See this file's own header for the two-tier reasoning. */
const PEP_WIRING_NAMES = new Set([
  "requireOwnership",
  "requirePermission",
  "requirePolicy",
  "requireRole",
  "requireStepUp",
  "requireApproval",
  "authorizeMany",
  "requireRoles",
]);

/**
 * Route Integration Roadmap — Phase F1 (Public Route Audit Wiring).
 *
 * `requirePublicAudit()` (lib/policy/pep/middleware.ts) is deliberately NOT
 * added to `PEP_WIRING_NAMES` above — see that set's own header on the D7
 * finding: "audit-only wiring adds observability, not a gate, and this
 * script's job is to find gates". `requirePublicAudit()` is audit-only by
 * construction (no deny path exists — see its own header) for routes that
 * have no ownership/role fact to check in the first place (access is
 * already fully gated by URL token/code possession). Counting it as
 * "wired" here would blur exactly the distinction the D7 note already
 * drew for `auditFinanceOwnership()`-style calls.
 *
 * So it gets its own, third bucket — neither "wired" (a real gate exists)
 * nor "unwired" (nothing has looked at this route at all, needs review/
 * baseline entry): a route calling `requirePublicAudit()` is a REVIEWED,
 * permanently-accepted "no gate needed, but observable" case, self-
 * evident from the source line itself. It is excluded from BOTH the
 * `wired` count and the `unwired`/baseline set — no baseline entry
 * needed or wanted for it (unlike the pre-F1 admin/decision-pending gaps
 * baseline exists for), since the `requirePublicAudit(...)` call at the
 * route is itself the durable record of "this was reviewed and is
 * intentionally public" — a baseline entry would only add staleness risk
 * (see FINDINGS_PHASE_F1_PUBLIC_ROUTE_AUDIT.md for the reviewed list).
 */
const PEP_PUBLIC_AUDIT_NAMES = new Set(["requirePublicAudit"]);

/** Season D, Phase D8 — legacy platform-role middleware from
 *  `middlewares/auth.ts` that is passed BARE (no call — the function
 *  itself, not a factory invocation) as a router middleware argument, e.g.
 *  `router.patch(path, requireAdmin, handler)`. `isWired()`'s original
 *  design only ever inspected `ts.isCallExpression(arg)`, so these were
 *  invisible even though they gate exactly as effectively as any PEP name
 *  above — just via a role check, not an ownership check (see file header,
 *  item 1, and `OWNERSHIP_GATING_GUIDE.md` for why role-gated and
 *  ownership-gated are both-valid, different layers). */
const PEP_WIRING_BARE_IDENTIFIERS = new Set([
  "requireAdmin",
  "requireDev",
]);

interface RouteCall {
  file: string;
  method: string;
  routePath: string;
  line: number;
  wired: boolean;
  /** Phase F1 — see PEP_PUBLIC_AUDIT_NAMES's own comment above. Mutually
   *  exclusive with `wired` in practice (a route calls one or the other),
   *  but tracked as its own field rather than folded into `wired` so the
   *  two "why this route is fine" reasons stay distinguishable in output. */
  publicAudit: boolean;
}

/** Every call name a given function's body itself calls, shallow (one level
 *  — enough for this series' "route → thin local wrapper → requireX()"
 *  depth; no file in this codebase nests a second layer, see the GUIDE). */
function collectCalledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      names.add(n.expression.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return names;
}

/** Maps every top-level wrapper function/const name defined in a source
 *  file to the set of names its own body calls — e.g. vault.ts's
 *  `requireVaultEntryOwnership` → `{"requireOwnership"}`. Covers both
 *  `function foo(...) {...}` and `const foo = (...) => {...}` /
 *  `const foo = function(...) {...}` — every wrapper shape actually used
 *  across `routes/*.ts` in this series (see e.g. vault.ts vs
 *  vault-entity-links.ts for the two shapes). Called once per file and
 *  merged into a single repo-wide map (see this file's own header, "one
 *  level, repo-wide" note, for why this isn't kept per-file). */
function collectWrapperCalledNames(sourceFile: ts.SourceFile): Map<string, Set<string>> {
  const wrappers = new Map<string, Set<string>>();
  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      wrappers.set(stmt.name.text, collectCalledNames(stmt.body));
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) &&
          decl.initializer.body
        ) {
          wrappers.set(decl.name.text, collectCalledNames(decl.initializer.body));
        }
      }
    }
  }
  return wrappers;
}

/** Season D, Phase D8 — walks up from a node to the nearest enclosing
 *  `IfStatement` (parent pointers are available because `findRouteCalls`
 *  creates its `SourceFile` with `setParentNodes = true`). Used to confirm
 *  an inline `role !== "..."` comparison actually GATES the response
 *  (its `if`-branch sends a 401/403) rather than being incidental. */
function findEnclosingIf(node: ts.Node): ts.IfStatement | undefined {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isIfStatement(cur)) return cur;
    cur = cur.parent;
  }
  return undefined;
}

const NOT_EQUALS_KINDS = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const STRICT_EQUALITY_KINDS = new Set([
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
]);

/** Sub-shape (a) from the file header, item 3 — an inline `authorize()`
 *  call whose result actually gates the response. Matches
 *  `<expr>.decision.effect !== "ALLOW"` / `=== "ALLOW"` (either operator,
 *  either side — this codebase always writes it `!==`/left-hand, but the
 *  shape check doesn't need to assume that). Deliberately does NOT require
 *  the enclosing `if`'s branch to call `res.status(...)` the way the
 *  role-check sub-shape below does: `.decision.effect` is already a
 *  PDP-decision-specific property path with no other plausible meaning in
 *  this codebase, so it's an unambiguous-enough signal on its own — see
 *  file header for why D7's audit-only `authorize()` calls never produce
 *  this shape (they never read `.decision.effect` back at all). */
function isDecisionEffectCheck(n: ts.BinaryExpression, sourceFile: ts.SourceFile): boolean {
  if (!STRICT_EQUALITY_KINDS.has(n.operatorToken.kind)) return false;
  const leftText = n.left.getText(sourceFile);
  const rightText = n.right.getText(sourceFile);
  const isDecisionEffectPath = (t: string) => /\.decision\.effect$/.test(t.trim());
  const isAllowLiteral = (e: ts.Expression) => ts.isStringLiteralLike(e);
  return (isDecisionEffectPath(leftText) && isAllowLiteral(n.right)) || (isDecisionEffectPath(rightText) && isAllowLiteral(n.left));
}

/** Sub-shape (b) from the file header, item 3 — a hand-rolled platform-role
 *  check with no `requireAdmin`-style middleware at all: `role !== "..."`
 *  or `<expr>.role !== "..."` (e.g. `req.user!.role`, `authUser.role`),
 *  where the enclosing `if`'s branch actually sends a 401/403 — that last
 *  part is what distinguishes an access-control gate from an incidental
 *  role comparison used for something else (e.g. a display/formatting
 *  branch), which this script should NOT count as wiring. */
function isInlineRoleCheck(n: ts.BinaryExpression, sourceFile: ts.SourceFile): boolean {
  if (!NOT_EQUALS_KINDS.has(n.operatorToken.kind)) return false;
  const leftText = n.left.getText(sourceFile).trim();
  const rightText = n.right.getText(sourceFile).trim();
  const isRoleExpr = (t: string) => t === "role" || /\.role$/.test(t);
  const matches = (isRoleExpr(leftText) && ts.isStringLiteralLike(n.right)) || (isRoleExpr(rightText) && ts.isStringLiteralLike(n.left));
  if (!matches) return false;
  const enclosingIf = findEnclosingIf(n);
  if (!enclosingIf) return false;
  const thenText = enclosingIf.thenStatement.getText(sourceFile);
  return /res\.status\(\s*40[13]/.test(thenText);
}

/** Season D, Phase D8 — does the route HANDLER's own body (as opposed to a
 *  router-level middleware argument, which `isWired()`'s main loop already
 *  covers) contain either inline-wiring sub-shape from the file header,
 *  item 3? Walks the whole handler body once, checking every
 *  `BinaryExpression` against both sub-shapes — cheap, single pass, no
 *  semantic resolution (see file header for why that's deliberate). */
function handlerHasInlineWiring(body: ts.Node, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isBinaryExpression(n) && (isDecisionEffectCheck(n, sourceFile) || isInlineRoleCheck(n, sourceFile))) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** Does any middleware argument (everything after the path string, i.e.
 *  `args.slice(1)`) directly call a PEP wiring name, call a wrapper
 *  (defined anywhere in `routes/`, possibly imported) that itself does, or
 *  (Season D, Phase D8) get passed BARE as a known legacy role-middleware
 *  reference? Failing all of those, does the route's own HANDLER body
 *  (the last middleware argument, if it's a function) contain inline PDP
 *  wiring per `handlerHasInlineWiring()` above? */
function isWired(middlewareArgs: ts.Expression[], wrappers: Map<string, Set<string>>, sourceFile: ts.SourceFile): boolean {
  for (const arg of middlewareArgs) {
    if (ts.isIdentifier(arg) && PEP_WIRING_BARE_IDENTIFIERS.has(arg.text)) return true;
    if (!ts.isCallExpression(arg) || !ts.isIdentifier(arg.expression)) continue;
    const calleeName = arg.expression.text;
    if (PEP_WIRING_NAMES.has(calleeName)) return true;
    const wrapperCalls = wrappers.get(calleeName);
    if (wrapperCalls && [...wrapperCalls].some((n) => PEP_WIRING_NAMES.has(n))) return true;
  }
  const handler = middlewareArgs[middlewareArgs.length - 1];
  if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) && handler.body) {
    if (handlerHasInlineWiring(handler.body, sourceFile)) return true;
  }
  return false;
}

/** Phase F1 — does any middleware argument directly call
 *  `requirePublicAudit()`? Deliberately simpler than `isWired()`: no
 *  wrapper-tracing, no bare-identifier case, no inline-handler case —
 *  every Phase F1 route calls it directly as a router-level middleware
 *  argument (see FINDINGS_PHASE_F1_PUBLIC_ROUTE_AUDIT.md), so matching
 *  that one real shape is enough. Extend this the same way `isWired()`
 *  was extended (D8) if a future phase introduces a wrapper around it. */
function isPublicAudit(middlewareArgs: ts.Expression[]): boolean {
  return middlewareArgs.some(
    (arg) => ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && PEP_PUBLIC_AUDIT_NAMES.has(arg.expression.text),
  );
}

function findRouteCalls(file: string, sourceText: string, wrappers: Map<string, Set<string>>): RouteCall[] {
  const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const results: RouteCall[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "router" &&
      HTTP_VERBS.has(node.expression.name.text)
    ) {
      const [pathArg, ...rest] = node.arguments;
      if (pathArg && ts.isStringLiteralLike(pathArg) && pathArg.text.includes(":")) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
        results.push({
          file,
          method: node.expression.name.text.toUpperCase(),
          routePath: pathArg.text,
          line: line + 1,
          wired: isWired(rest, wrappers, sourceFile),
          publicAudit: isPublicAudit(rest),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return results;
}

function routeKey(r: RouteCall): string {
  return `${r.file}:${r.method} ${r.routePath}`;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_PATH)) return new Set();
  const raw = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as { unwired: string[] };
  return new Set(raw.unwired);
}

function writeBaseline(keys: string[]): void {
  const sorted = [...keys].sort();
  fs.writeFileSync(
    BASELINE_PATH,
    JSON.stringify(
      {
        _comment:
          "Generated by scripts/src/check-ownership-gate-coverage.ts --update-baseline. " +
          "Each entry is a param-route this script found with no requireOwnership()/" +
          "authorizeMany()-family wiring, accepted as a pre-existing gap at generation " +
          "time (see that script's own header for why). Do not hand-edit — re-run with " +
          "--update-baseline after reviewing a newly-flagged route.",
        generatedAt: new Date().toISOString(),
        unwired: sorted,
      },
      null,
      2,
    ) + "\n",
  );
}

function main(): void {
  const updateBaseline = process.argv.includes("--update-baseline");

  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`routes/ directory not found at ${ROUTES_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"));
  const fileTexts = new Map<string, string>();
  for (const file of files) {
    fileTexts.set(file, fs.readFileSync(path.join(ROUTES_DIR, file), "utf8"));
  }

  // Pass 1: build the repo-wide wrapper-name → called-names map (every
  // file's top-level wrapper functions), BEFORE looking at any route call
  // — a wrapper defined in file B needs to already be known when file A's
  // routes (which import it) are checked, regardless of file iteration
  // order.
  const wrappers = new Map<string, Set<string>>();
  for (const [file, text] of fileTexts) {
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const [name, calls] of collectWrapperCalledNames(sourceFile)) {
      wrappers.set(name, calls);
    }
  }

  // Pass 2: find every param route call and resolve wiring against the
  // now-complete repo-wide wrapper map.
  const allCalls: RouteCall[] = [];
  for (const [file, text] of fileTexts) {
    allCalls.push(...findRouteCalls(file, text, wrappers));
  }

  const unwired = allCalls.filter((r) => !r.wired && !r.publicAudit);
  const unwiredKeys = unwired.map(routeKey);
  const publicAuditCount = allCalls.filter((r) => r.publicAudit).length;

  console.log(`Route Integration Roadmap — Phase C33: ownership-gate coverage check`);
  console.log(
    `Scanned ${files.length} route files, ${allCalls.length} param routes total, ` +
    `${unwired.length} unwired, ${publicAuditCount} public/token-audit-only (Phase F1, not counted as a gap).\n`,
  );

  if (updateBaseline) {
    writeBaseline(unwiredKeys);
    console.log(`Baseline updated: ${unwiredKeys.length} accepted unwired param routes written to ${path.relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  const baseline = loadBaseline();
  const newlyUnwired = unwired.filter((r) => !baseline.has(routeKey(r)));
  const stale = [...baseline].filter((k) => !unwiredKeys.includes(k));

  if (newlyUnwired.length > 0) {
    console.error(`FAIL — ${newlyUnwired.length} new unwired param route(s) not covered by requireOwnership()/authorizeMany()-family middleware, and not in the baseline:\n`);
    for (const r of newlyUnwired) {
      console.error(`  ${r.file}:${r.line}  ${r.method} ${r.routePath}`);
    }
    console.error(
      `\nIf this route genuinely doesn't need per-resource ownership gating (e.g. admin-\n` +
      `only, public, or intentionally decision-pending like C29), see\n` +
      `artifacts/api-server/src/lib/policy/OWNERSHIP_GATING_GUIDE.md, then re-run with\n` +
      `--update-baseline in its own reviewed commit. Otherwise, wire it with\n` +
      `requireOwnership()/requireXOwnership() per the GUIDE before merging.`,
    );
    process.exit(1);
  }

  console.log(`OK — no new unwired param routes (${baseline.size} pre-existing gap(s) in baseline, unchanged).`);
  if (stale.length > 0) {
    console.log(
      `\nNote: ${stale.length} baseline entr${stale.length === 1 ? "y" : "ies"} no longer match an unwired route ` +
      `(now wired, or removed) — run with --update-baseline to shrink the baseline:`,
    );
    for (const k of stale) console.log(`  ${k}`);
  }
}

main();
