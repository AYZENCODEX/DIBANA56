// scripts/src/rewrap-encryption-keys.ts
// ─────────────────────────────────────────────────────────────────────────────
// KEK-rotation companion for lib/vault-crypto.ts (namespace "vault") and
// lib/vault-backup-envelope.ts (namespace "vault-backup").
//
// WHY THIS EXISTS: both modules' unwrapDek() always reads the CURRENT
// VAULT_MASTER_KEY / VAULT_FIELD_ENCRYPTION_KEY env var. Neither has any
// notion of an "old" key, so simply changing that env var makes every row in
// encryption_keys permanently unwrappable — not just future writes, ALL of
// them, including every already-stored vault-backup snapshot. This script is
// the missing step: it unwraps every DEK under the OLD KEK and re-wraps it
// under the NEW KEK, in place, so application code keeps working unmodified
// after the env var is swapped.
//
// This does NOT touch actual field ciphertext (vault_entries, vault_snapshots
// blobs, etc) — those stay encrypted under the same DEK they always were.
// Only the wrapped_dek column in encryption_keys changes. That's why this is
// fast and safe to run against every row in one pass, unlike
// reencrypt-vault.ts (which re-encrypts bulk row data and is deliberately
// batched/resumable).
//
// The two namespaces use DIFFERENT wrap formats (kept in sync with each
// module's own wrapDek/unwrapDek — see the two *Format() function pairs
// below) — this script mirrors both exactly rather than importing them,
// same reasoning as reencrypt-vault.ts for not depending on the api-server
// package.
//
// Usage:
//   OLD_VAULT_MASTER_KEY=... NEW_VAULT_MASTER_KEY=... \
//     DATABASE_URL=... npx tsx scripts/src/rewrap-encryption-keys.ts [--dry-run] [--namespace=vault|vault-backup]
//
// Deliberately separate env var names (OLD_/NEW_) from the app's own
// VAULT_MASTER_KEY — this script should never accidentally read the live
// runtime key the app is currently using for one side of the operation.
//
// PROCEDURE (see the disaster-recovery runbook, §2.1 / §5):
//   1. Run with --dry-run first. It unwraps every row under the OLD key and
//      reports success/failure per row — nothing is written.
//   2. If every row unwraps cleanly, run for real. All rows are re-wrapped
//      and written inside a single DB transaction — either everything
//      updates or nothing does.
//   3. Only AFTER this script has completed successfully, update the live
//      VAULT_MASTER_KEY env var everywhere the app runs, and restart it.
//      Never flip the env var first.
//
// --upgrade-derivation mode (KEK hardening, no secret rotation):
//   Both lib/vault-crypto.ts and lib/vault-backup-envelope.ts moved their
//   KEK derivation from `raw.slice(0, 32).padEnd(32, "0")` (only the first
//   32 *characters* of the secret, zero-padded if shorter) to HKDF-SHA256
//   over the FULL raw secret. Both modules self-heal on read (unwrap tries
//   the new derivation, falls back to the old one), so this migration step
//   is optional — but every row stays on the weaker legacy wrap until it
//   is. This mode re-wraps every row from the legacy derivation to the
//   hardened one using the SAME secret, so it only needs one env var:
//
//     VAULT_MASTER_KEY=... DATABASE_URL=... \
//       npx tsx scripts/src/rewrap-encryption-keys.ts --upgrade-derivation [--dry-run]
//
//   Rows already on the hardened wrap are left untouched (detected by a
//   trial unwrap, not a stored flag — same "try strong, then legacy"
//   approach the app itself uses).
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const UPGRADE_DERIVATION = args.includes("--upgrade-derivation");
const namespaceArg = args.find(a => a.startsWith("--namespace="));
const NAMESPACE_FILTER = namespaceArg ? namespaceArg.split("=")[1] : null;

function deriveKekLegacy(raw: string): Buffer {
  return Buffer.from(raw.slice(0, 32).padEnd(32, "0"));
}
// Must match lib/vault-crypto.ts's KEK_HKDF_SALT/INFO and
// lib/vault-backup-envelope.ts's ENV_KEK_HKDF_SALT/INFO exactly, per namespace.
const HKDF_PARAMS: Record<string, { salt: Buffer; info: Buffer }> = {
  "vault": { salt: Buffer.from("ayzen:vault-crypto:kek-v2", "utf8"), info: Buffer.from("kek", "utf8") },
  "vault-backup": { salt: Buffer.from("ayzen:vault-backup-envelope:kek-v2", "utf8"), info: Buffer.from("kek", "utf8") },
};
function deriveKekForNamespace(namespace: string, raw: string): Buffer {
  const p = HKDF_PARAMS[namespace];
  if (!p) throw new Error(`Unknown namespace "${namespace}" — no HKDF salt/info registered for it.`);
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), p.salt, p.info, 32));
}

// A labeled KEK candidate to try when unwrapping an "old" row. Order matters:
// tried first-to-last, first one whose AES-GCM auth tag checks out wins.
type KekCandidate = { label: "strong" | "legacy"; kek: Buffer };

let deriveOldKekCandidates: (namespace: string) => KekCandidate[];
let deriveNewKek: (namespace: string) => Buffer;

if (UPGRADE_DERIVATION) {
  const raw = process.env["VAULT_MASTER_KEY"];
  if (!raw || raw.length < 32) {
    console.error("VAULT_MASTER_KEY is missing or shorter than 32 characters — this must be the CURRENT live key (or VAULT_FIELD_ENCRYPTION_KEY, whichever the app is actually using as its KEK).");
    process.exit(1);
  }
  // Same secret both sides — only the derivation changes. Try legacy first
  // (the expected starting state), but also try strong so a row that's
  // already been upgraded (e.g. a re-run, or a fresh DEK bootstrapped by
  // the app after this hardening shipped) is detected as "already done"
  // rather than reported as a failure.
  deriveOldKekCandidates = (namespace: string) => [
    { label: "legacy", kek: deriveKekLegacy(raw) },
    { label: "strong", kek: deriveKekForNamespace(namespace, raw) },
  ];
  deriveNewKek = (namespace: string) => deriveKekForNamespace(namespace, raw);
} else {
  const oldRaw = process.env["OLD_VAULT_MASTER_KEY"];
  const newRaw = process.env["NEW_VAULT_MASTER_KEY"];
  if (!oldRaw || oldRaw.length < 32) {
    console.error("OLD_VAULT_MASTER_KEY is missing or shorter than 32 characters — this must be the CURRENT live VAULT_MASTER_KEY (or VAULT_FIELD_ENCRYPTION_KEY, whichever the app is actually using as its KEK right now).");
    process.exit(1);
  }
  if (!newRaw || newRaw.length < 32) {
    console.error("NEW_VAULT_MASTER_KEY is missing or shorter than 32 characters — generate one with `openssl rand -hex 32`.");
    process.exit(1);
  }
  if (oldRaw === newRaw) {
    console.error("OLD_VAULT_MASTER_KEY and NEW_VAULT_MASTER_KEY are identical — nothing to rotate. (To only upgrade the KEK derivation without changing the secret, use --upgrade-derivation instead.)");
    process.exit(1);
  }
  // The OLD secret's rows might be wrapped under either derivation depending
  // on whether --upgrade-derivation already ran against it — try both, same
  // self-healing order the app itself uses (strong first, then legacy).
  deriveOldKekCandidates = (namespace: string) => [
    { label: "strong", kek: deriveKekForNamespace(namespace, oldRaw) },
    { label: "legacy", kek: deriveKekLegacy(oldRaw) },
  ];
  deriveNewKek = (namespace: string) => deriveKekForNamespace(namespace, newRaw);
}

// ─── namespace "vault" format (lib/vault-crypto.ts) ─────────────────────────
// wrapDek(dek) = aesEncrypt(KEK, dek.toString("hex"))
// i.e. the DEK's hex STRING is what gets AES-GCM'd, not the raw bytes.
function vaultAesEncrypt(key: Buffer, plainUtf8: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plainUtf8, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + ":" + enc.toString("hex") + ":" + tag.toString("hex");
}
function vaultAesDecrypt(key: Buffer, packed: string): string {
  const [ivHex, encHex, tagHex] = packed.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed ciphertext (expected iv:ct:tag)");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]).toString("utf8");
}
function unwrapVaultDek(wrapped: string, kek: Buffer): Buffer {
  return Buffer.from(vaultAesDecrypt(kek, wrapped), "hex");
}
function wrapVaultDek(dek: Buffer, kek: Buffer): string {
  return vaultAesEncrypt(kek, dek.toString("hex"));
}

// ─── namespace "vault-backup" format (lib/vault-backup-envelope.ts) ────────
// wrapDek(dek) = AES-GCM directly over the raw DEK bytes (no hex re-encode).
function unwrapBackupDek(wrapped: string, kek: Buffer): Buffer {
  const [ivHex, encHex, tagHex] = wrapped.split(":");
  if (!ivHex || !encHex || !tagHex) throw new Error("Malformed ciphertext (expected iv:enc:tag)");
  const decipher = crypto.createDecipheriv("aes-256-gcm", kek, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(encHex, "hex")), decipher.final()]);
}
function wrapBackupDek(dek: Buffer, kek: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", kek, iv);
  const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), enc.toString("hex"), tag.toString("hex")].join(":");
}

function unwrapForNamespace(namespace: string, wrapped: string, kek: Buffer): Buffer {
  if (namespace === "vault") return unwrapVaultDek(wrapped, kek);
  if (namespace === "vault-backup") return unwrapBackupDek(wrapped, kek);
  throw new Error(`Unknown namespace "${namespace}" — this script only knows "vault" and "vault-backup". Add a wrap/unwrap pair for it first, don't guess.`);
}
function wrapForNamespace(namespace: string, dek: Buffer, kek: Buffer): string {
  if (namespace === "vault") return wrapVaultDek(dek, kek);
  if (namespace === "vault-backup") return wrapBackupDek(dek, kek);
  throw new Error(`Unknown namespace "${namespace}"`);
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE — will update encryption_keys"}${UPGRADE_DERIVATION ? " — upgrade-derivation" : ""}`);
  if (NAMESPACE_FILTER) console.log(`Namespace filter: ${NAMESPACE_FILTER}`);

  const result: any = await db.execute(
    NAMESPACE_FILTER
      ? sql`SELECT id, namespace, version, wrapped_dek FROM encryption_keys WHERE namespace = ${NAMESPACE_FILTER} ORDER BY namespace, version`
      : sql`SELECT id, namespace, version, wrapped_dek FROM encryption_keys ORDER BY namespace, version`
  );
  const rows: any[] = result.rows ?? result;

  if (rows.length === 0) {
    console.log("No encryption_keys rows found — nothing to do.");
    return;
  }

  console.log(`Found ${rows.length} row(s). Verifying every row unwraps under the OLD key...`);

  const planned: Array<{ id: number; namespace: string; version: number; newWrapped: string }> = [];
  let failures = 0;
  let alreadyDone = 0;

  for (const row of rows) {
    const namespace = String(row.namespace);
    const version = Number(row.version);
    const wrapped = String(row.wrapped_dek);
    try {
      const candidates = deriveOldKekCandidates(namespace);
      let dek: Buffer | null = null;
      let matchedLabel: "strong" | "legacy" | null = null;
      for (const c of candidates) {
        try {
          dek = unwrapForNamespace(namespace, wrapped, c.kek);
          matchedLabel = c.label;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!dek || !matchedLabel) throw new Error("did not unwrap under any candidate OLD key");

      if (UPGRADE_DERIVATION && matchedLabel === "strong") {
        alreadyDone++;
        console.log(`  SKIP ${namespace} v${version} (already on the hardened derivation)`);
        continue;
      }

      const newWrapped = wrapForNamespace(namespace, dek, deriveNewKek(namespace));
      // Round-trip sanity check before trusting this row.
      const reUnwrapped = unwrapForNamespace(namespace, newWrapped, deriveNewKek(namespace));
      if (!reUnwrapped.equals(dek)) throw new Error("round-trip mismatch after re-wrap");
      planned.push({ id: Number(row.id), namespace, version, newWrapped });
      console.log(`  OK   ${namespace} v${version}`);
    } catch (err: any) {
      failures++;
      console.error(`  FAIL ${namespace} v${version} — ${err?.message ?? err}`);
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} row(s) failed to unwrap under the OLD key. Stopping — nothing was written. Double-check ${UPGRADE_DERIVATION ? "VAULT_MASTER_KEY" : "OLD_VAULT_MASTER_KEY"} is the exact key currently live in production (or VAULT_FIELD_ENCRYPTION_KEY, if that's what's serving as the KEK — see vault-crypto.ts's KEK_RAW fallback).`);
    process.exit(1);
  }

  console.log(`\n${planned.length} row(s) unwrapped and re-wrapped successfully.${alreadyDone > 0 ? ` ${alreadyDone} row(s) already on the hardened derivation, left untouched.` : ""}`);

  if (planned.length === 0) {
    console.log("Nothing to write.");
    return;
  }

  if (DRY_RUN) {
    console.log("Dry run complete — no rows were updated. Re-run without --dry-run to apply.");
    return;
  }

  console.log("Writing re-wrapped DEKs in a single transaction...");
  await db.transaction(async (tx: any) => {
    for (const p of planned) {
      await tx.execute(sql`UPDATE encryption_keys SET wrapped_dek = ${p.newWrapped} WHERE id = ${p.id}`);
    }
  });

  console.log(`\nDone. ${planned.length} row(s) re-wrapped.`);
  if (!UPGRADE_DERIVATION) {
    console.log("NEXT STEP: update the live VAULT_MASTER_KEY (and/or VAULT_FIELD_ENCRYPTION_KEY) env var to NEW_VAULT_MASTER_KEY's value everywhere the app runs, then restart it. Not before now.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
