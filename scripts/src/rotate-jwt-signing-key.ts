// scripts/src/rotate-jwt-signing-key.ts
// ─────────────────────────────────────────────────────────────────────────────
// OIDC Roadmap — Season 1, Phase 1D-d: Rotation Trigger.
//
// A safe, MANUAL rotation mechanism for the RS256 signing keypair — no admin
// UI, no scheduling, run by hand when you decide to rotate. Generates a new
// keypair, writes it to jwt_signing_keys (migration 078, Phase 1C) as the
// new 'active' row, and moves whatever was active before into 'retiring' —
// the grace state Phase 1D-a/1D-b/1D-c's verification path already honors
// (canVerify("retiring") === true, see lib/jwt-keys.ts).
//
// WHAT THIS SCRIPT DOES NOT DO
//   It does NOT flip which key actually signs new tokens. signAuthToken()/
//   signOAuthState() (lib/jwt.ts) call getActiveKeypair() (lib/jwt-keys.ts),
//   which resolves ONLY from AYZEN_JWT_PRIVATE_KEY/PUBLIC_KEY/KID env vars —
//   it has never read jwt_signing_keys and this sub-phase doesn't wire that
//   up (that would be a signing-path change, out of scope here; see "Do
//   not" list in the roadmap for 1D-d). So rotation is two steps:
//     1. Run this script. It writes the DB rows and prints a new
//        AYZEN_JWT_PRIVATE_KEY / AYZEN_JWT_PUBLIC_KEY / AYZEN_JWT_KID trio
//        (same format as generate-jwt-keypair.ts).
//     2. Update those three env vars wherever the app runs and restart it.
//        Only after restart do NEW tokens actually get signed with the new
//        kid — verifyAuthToken()/verifyOAuthState() already accept it
//        immediately after step 1 commits (resolveVerificationKeys()'s cache
//        self-heals from the DB on the next call/process start), and keep
//        accepting the OLD kid throughout — it's sitting in the DB as
//        'retiring', not gone.
//   It does NOT decide how long a 'retiring' key should stay verifiable
//   before becoming 'retired' — that's Phase 1D-e (Retention & Removal
//   Policy). This script only ever writes 'active' and 'retiring', never
//   'retired'.
//
// SAFETY MODEL
//   Before writing anything, the script reads whatever row(s) are currently
//   'active' in jwt_signing_keys and refuses to proceed unless the state is
//   unambiguous — see planRotation() below, which is the pure decision
//   function this file's DB I/O just executes:
//     - More than one 'active' row → refuse. jwt_signing_keys_single_active
//       (migration 078) should make this impossible; if it's happened
//       anyway, something is already wrong and blind rotation would make it
//       worse, not better (same drift warnIfMultipleActive() in
//       lib/jwt-keys.ts logs on, Phase 1D-c).
//     - Exactly one 'active' row, but its kid does NOT match the env's
//       current AYZEN_JWT_KID → refuse. This means the DB's notion of
//       "active" and the env's (i.e. what's actually signing tokens right
//       now) have already diverged; rotating on top of that would retire a
//       key that isn't the one really in use, silently orphaning it from
//       verification. Reconcile by hand first.
//     - Exactly one 'active' row matching the env kid → normal case, retire
//       it.
//     - Zero 'active' rows → bootstrap case. jwt_signing_keys is empty today
//       (Phase 1C shipped schema-only, no write path existed before this
//       script) — the very first rotation has nothing in the DB to retire,
//       so the outgoing row is written directly as 'retiring' (never
//       transiently 'active'), representing "the key that was signing
//       everything up to this rotation."
//   Both DB writes (retire outgoing + insert incoming) happen inside a
//   single transaction — either the whole rotation lands, or none of it
//   does. A `kid` collision on the new key (astronomically unlikely — 16
//   hex chars of randomness, same generation as generate-jwt-keypair.ts)
//   fails the INSERT's UNIQUE(kid) constraint and rolls back rather than
//   silently overwriting anything.
//
// Usage:
//   npx tsx scripts/src/rotate-jwt-signing-key.ts [--dry-run]
//
//   --dry-run: reads and validates current DB state, prints what rotation
//   WOULD do, writes nothing, generates no new key (so it never prints key
//   material that doesn't end up anywhere).
//
// SECURITY: like generate-jwt-keypair.ts, the new private key is printed to
// stdout in plaintext on a real (non-dry-run) run. Pipe it straight into
// your secret manager and don't leave it in shell history or a CI log.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { pool } from "@workspace/db";
import { getActiveKeypair, canSign } from "../../artifacts/api-server/src/lib/jwt-keys";

interface ActiveRow {
  kid: string;
}

type RotationPlan =
  | { ok: true; mode: "bootstrap"; outgoingKid: string }
  | { ok: true; mode: "retire-existing"; outgoingKid: string }
  | { ok: false; reason: string };

/**
 * Pure decision function — no I/O, no key generation, just "given the
 * DB rows currently marked 'active' and the env's current signing kid,
 * is it safe to rotate, and if so what's the outgoing kid?" Factored out
 * so it's unit-testable without a database connection — see
 * scripts/src/test-rotate-jwt-signing-key.ts.
 *
 * `dbActiveRows` is trusted to already be filtered to status='active' by
 * the caller's SQL — this function re-derives what "active" should mean
 * from canSign() (Phase 1D-c) purely as a documentation/consistency check,
 * not as a second filter (there's only one signing-eligible status, so
 * there's nothing to filter out here that the caller's query wouldn't
 * already have excluded).
 */
export function planRotation(dbActiveRows: ActiveRow[], envKid: string): RotationPlan {
  if (!canSign("active")) {
    // Unreachable — canSign("active") is always true — but asserted so a
    // future edit to canSign() that somehow stopped "active" from being
    // sign-eligible fails loudly here instead of this script silently
    // rotating against a rule it no longer agrees with.
    return { ok: false, reason: "internal error: canSign('active') is false — refusing to rotate" };
  }

  if (dbActiveRows.length > 1) {
    return {
      ok: false,
      reason:
        `${dbActiveRows.length} rows are marked 'active' in jwt_signing_keys (kids: ${dbActiveRows.map((r) => r.kid).join(", ")}) — ` +
        "expected at most one. jwt_signing_keys_single_active should prevent this; refusing to rotate on top of an already-inconsistent table.",
    };
  }

  if (dbActiveRows.length === 0) {
    return { ok: true, mode: "bootstrap", outgoingKid: envKid };
  }

  const [dbActive] = dbActiveRows;
  if (dbActive.kid !== envKid) {
    return {
      ok: false,
      reason:
        `jwt_signing_keys has kid='${dbActive.kid}' marked 'active', but the running process is currently signing with ` +
        `AYZEN_JWT_KID='${envKid}'. The DB and the env have diverged — rotating now would retire the wrong row. ` +
        "Reconcile which key is actually in use before running this script.",
    };
  }

  return { ok: true, mode: "retire-existing", outgoingKid: envKid };
}

function generateNewKeypair(): { kid: string; privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  // Same generation as generate-jwt-keypair.ts (Phase 1A) — 16 hex chars,
  // collision probability negligible; the DB's UNIQUE(kid) constraint is
  // still the actual backstop (see file header).
  const kid = randomBytes(8).toString("hex");
  return { kid, privateKey, publicKey };
}

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");

  const current = getActiveKeypair(); // env-resolved — the key ACTUALLY signing tokens right now
  const { rows } = await pool.query<{ kid: string }>(
    `SELECT kid FROM jwt_signing_keys WHERE status = 'active'`,
  );

  const plan = planRotation(rows, current.kid);
  if (!plan.ok) {
    console.error(`[rotate-jwt-signing-key] refusing to rotate: ${plan.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[rotate-jwt-signing-key] plan: ${plan.mode === "bootstrap" ? "no existing DB row for the current signing key — will record it as 'retiring' directly" : "existing DB row for the current signing key confirmed — will move it to 'retiring'"} (outgoing kid: ${plan.outgoingKid})`,
  );

  if (dryRun) {
    console.log("[rotate-jwt-signing-key] --dry-run: stopping here. No key generated, no rows written.");
    return;
  }

  const incoming = generateNewKeypair();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (plan.mode === "bootstrap") {
      await client.query(
        `INSERT INTO jwt_signing_keys (kid, public_key, algorithm, status, retiring_at) VALUES ($1, $2, 'RS256', 'retiring', NOW())`,
        [plan.outgoingKid, current.publicKey],
      );
    } else {
      const result = await client.query(
        `UPDATE jwt_signing_keys SET status = 'retiring', retiring_at = NOW() WHERE kid = $1 AND status = 'active'`,
        [plan.outgoingKid],
      );
      if (result.rowCount !== 1) {
        // Someone else changed this row between our SELECT and this UPDATE
        // (e.g. a concurrent rotation run). Don't guess — roll back.
        throw new Error(
          `expected to retire exactly 1 row for kid='${plan.outgoingKid}', affected ${result.rowCount} — ` +
            "the active row changed concurrently. Re-run once you've confirmed the current state.",
        );
      }
    }

    await client.query(
      `INSERT INTO jwt_signing_keys (kid, public_key, algorithm, status) VALUES ($1, $2, 'RS256', 'active')`,
      [incoming.kid, incoming.publicKey],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[rotate-jwt-signing-key] rotation failed, rolled back — no rows were changed:", err);
    process.exitCode = 1;
    return;
  } finally {
    client.release();
  }

  console.log(`[rotate-jwt-signing-key] done — kid='${plan.outgoingKid}' is now 'retiring' (still verifies), kid='${incoming.kid}' is now 'active' in the DB.`);
  console.log(
    "[rotate-jwt-signing-key] verification already accepts the new kid (and keeps accepting the old one). " +
      "Signing does NOT switch yet — update these three env vars wherever the app runs, then restart it:",
  );
  console.log("");
  const escapedPrivate = incoming.privateKey.trim().replace(/\n/g, "\\n");
  const escapedPublic = incoming.publicKey.trim().replace(/\n/g, "\\n");
  console.log(`AYZEN_JWT_KID=${incoming.kid}`);
  console.log(`AYZEN_JWT_PRIVATE_KEY="${escapedPrivate}"`);
  console.log(`AYZEN_JWT_PUBLIC_KEY="${escapedPublic}"`);
  console.log("");
  console.log(
    `[rotate-jwt-signing-key] kid='${plan.outgoingKid}' will keep verifying old tokens until Phase 1D-e's retention policy retires it — this script never sets status='retired'.`,
  );
}

main()
  .catch((err) => {
    console.error("[rotate-jwt-signing-key] unexpected error:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
