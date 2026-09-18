/**
 * scripts/src/test-oidc-logout-session-integration.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OIDC Roadmap — Season 3, Phase 6c: `user_sessions` Integration tests.
 *
 * 6c-a (Existing Revoke Logic Audit) / 6c-b (Logout-to-Revoke Binding) /
 * 6c-c (Device Session Consistency) are, by `routes/oidc-logout.ts`'s own
 * design (see that file's header), not new revocation logic at all —
 * `logoutHandler()` calls the exact same two functions
 * (`revokeSessionByJti()` from `lib/sessions.ts`, `clearSessionCookie()`
 * from `lib/session-cookie.ts`) that `POST /auth/logout` (`routes/auth.ts`)
 * already calls, resolving the session to revoke the exact same way
 * (`getTokenFromReq()` + `verifyAuthToken()` -> `decoded.sid`, never the
 * `id_token_hint`'s `sub`). Because both paths write to the identical
 * `user_sessions` row (keyed by `jti`), the Security page's device list
 * (`GET /auth/sessions`, `lib/sessions.ts`'s `listSessions()`) and its own
 * revoke button (`POST /auth/sessions/:id/revoke`) stay consistent with an
 * OIDC-initiated logout automatically, by construction — there is no
 * second, independent "OIDC session" concept for them to drift out of
 * sync with.
 *
 * That claim is what this file actually checks. `revokeSessionByJti()` /
 * `listSessions()` / `isSessionRevoked()` are live Postgres queries
 * (`lib/sessions.ts` imports `pool` from `@workspace/db`) — exercising
 * "does a session revoked via GET /oidc/logout stop appearing on the
 * Security page" end-to-end would need a real `DATABASE_URL` and a seeded
 * user, the same limitation this roadmap's other DB-dependent behavior
 * (e.g. `oidc_clients_client_id_idx`'s uniqueness constraint, see
 * `scripts/src/test-oidc-clients.ts`'s own note) already accepts and
 * hand-verifies instead of exercising against a live pool. So 6c-d
 * (Cross-Path Verification) is split the same way here:
 *
 *   - the DB-free, mechanically-checkable half: routes/oidc-logout.ts
 *     imports and calls the SAME functions, from the SAME modules, with
 *     the SAME session-identification logic as routes/auth.ts's POST
 *     /auth/logout — verified below by reading both route files' own
 *     source rather than asserting on network/DB behavior neither file
 *     exposes as an importable unit. This is what actually rules out the
 *     failure mode 6c-c cares about: a second, parallel, silently
 *     drifting revoke implementation.
 *   - the DB-dependent half (a session revoked via one path is no longer
 *     usable/listed via the other) is recorded as a manual verification
 *     step below rather than faked with a mocked pool, so this test never
 *     gives a false "pass" for behavior it didn't actually exercise.
 *
 * Run: npx tsx scripts/src/test-oidc-logout-session-integration.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { respondToLogoutFailure } from "../../artifacts/api-server/src/routes/oidc-logout";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_SRC = path.resolve(__dirname, "../../artifacts/api-server/src");

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

function readSrc(relPath: string): string {
  return fs.readFileSync(path.join(API_SRC, relPath), "utf8");
}

async function main(): Promise<void> {
  const oidcLogoutSrc = readSrc("routes/oidc-logout.ts");
  const authSrc = readSrc("routes/auth.ts");

  console.log("6c-a/6c-b — Existing Revoke Logic Audit / Logout-to-Revoke Binding");

  test("routes/oidc-logout.ts imports revokeSessionByJti from the same lib/sessions module POST /auth/logout uses — no second revoke implementation", () => {
    assert.match(oidcLogoutSrc, /import\s*\{\s*revokeSessionByJti\s*\}\s*from\s*"\.\.\/lib\/sessions"/);
    assert.match(authSrc, /revokeSessionByJti/);
  });

  test("routes/oidc-logout.ts imports clearSessionCookie from the same lib/session-cookie module POST /auth/logout uses", () => {
    assert.match(oidcLogoutSrc, /import\s*\{\s*clearSessionCookie\s*\}\s*from\s*"\.\.\/lib\/session-cookie"/);
    assert.match(authSrc, /clearSessionCookie/);
  });

  test("logoutHandler() calls revokeSessionByJti(decoded.sid) — the identical call shape POST /auth/logout makes, not a jti derived any other way", () => {
    assert.match(oidcLogoutSrc, /revokeSessionByJti\(decoded\.sid\)/);
    assert.match(authSrc, /revokeSessionByJti\(decoded\.sid\)/);
  });

  console.log("\n6b-a/6c-a — Session Identification (never trusts id_token_hint's sub)");

  test("logoutHandler() resolves ITS OWN session the same way POST /auth/logout does: getTokenFromReq() + verifyAuthToken(), not the verified hint", () => {
    assert.match(oidcLogoutSrc, /getTokenFromReq\(req\)/);
    assert.match(oidcLogoutSrc, /verifyAuthToken\(token\)/);
    // The verified hint's own sub (`result.hintUserId`) must never be the
    // value passed to revokeSessionByJti — only `decoded.sid` may be.
    const revokeCallLine = oidcLogoutSrc.split("\n").find((l) => l.includes("await revokeSessionByJti("));
    assert.ok(revokeCallLine, "expected a revokeSessionByJti( call in routes/oidc-logout.ts");
    assert.doesNotMatch(revokeCallLine!, /hintUserId/);
  });

  console.log("\n6c-c — Device Session Consistency");

  test("both logout paths key session revocation off the JWT's sid claim, which is the exact column (jti) the Security page's listSessions()/revokeSession() read — same row, same identity, no parallel session model", () => {
    const sessionsSrc = readSrc("lib/sessions.ts");
    assert.match(sessionsSrc, /revokeSessionByJti[\s\S]*?WHERE jti = \$1/);
    assert.match(sessionsSrc, /listSessions[\s\S]*?WHERE user_id = \$1/);
  });

  console.log("\n6a-e/6b-d — response shape (DB-free behavioral check)");

  test("respondToLogoutFailure() writes a direct 400 with { error }, never a redirect — matches the file's own 'never redirect an unverified target' rule", () => {
    const calls: Array<{ method: string; arg: unknown }> = [];
    const fakeRes = {
      status(code: number) {
        calls.push({ method: "status", arg: code });
        return this;
      },
      json(body: unknown) {
        calls.push({ method: "json", arg: body });
        return this;
      },
    } as unknown as import("express").Response;

    respondToLogoutFailure(fakeRes, { ok: false, error: "invalid_client", redirectable: false });

    assert.deepEqual(calls, [
      { method: "status", arg: 400 },
      { method: "json", arg: { error: "invalid_client" } },
    ]);
  });

  console.log("\n6c-d — Cross-Path Verification (manual step, DB-dependent)");
  console.log(
    "  MANUAL — requires a live DATABASE_URL and a real logged-in session; not exercised here (see file header):\n" +
      "    1. Log in, note the session's row on the Security page (GET /auth/sessions).\n" +
      "    2. Call GET /oidc/logout with that session's cookie/bearer token.\n" +
      "    3. Confirm: the SAME session id disappears from GET /auth/sessions' active list,\n" +
      "       and a subsequent authenticated request with the old token is rejected\n" +
      "       (getUserFromToken() -> isSessionRevoked() -> true).\n" +
      "    4. Repeat in reverse: log in, revoke via POST /auth/sessions/:id/revoke\n" +
      "       (the Security page's own button), confirm GET /oidc/logout's session\n" +
      "       lookup for that same token no longer finds an active session either.\n" +
      "  Both directions are guaranteed by 6c-a/6c-b above (one shared revoke\n" +
      "  function, one shared table, one shared jti) rather than needing independent\n" +
      "  runtime behavior — this manual step is a confirmation, not new logic.",
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
