# CHANGES — Vault Backup Hardening, Round 3

One hardening this round, in two parts, both about the *encryption keys*
that protect vault backups rather than the backup workflow itself (Round 1
covered envelope encryption/rotation/DR evidence; Round 2 covered snapshot
delete protection and DR-test scheduling).

## 1. KEK derivation — entropy truncation bug, fixed

**The bug:** `lib/vault-crypto.ts` and `lib/vault-backup-envelope.ts` both
derived their key-encryption key (the KEK that wraps every DEK — the actual
keys that encrypt Vault fields and vault-backup snapshots) like this:

```ts
Buffer.from(raw.slice(0, 32).padEnd(32, "0"))
```

`raw` is `VAULT_MASTER_KEY` (or `VAULT_FIELD_ENCRYPTION_KEY` as a fallback).
This treats the secret's *characters* as raw key bytes: only the first 32
are used, everything after is silently discarded, and a shorter secret is
zero-padded rather than stretched. Both files' own setup instructions
recommend generating the secret with `openssl rand -hex 32` — which
produces 64 hex characters carrying 256 bits of entropy — but the old
derivation only ever consumed the first 32 of those characters, so the
*effective* KEK strength was closer to 128 bits, not the 256 the AES-256-GCM
wrapping implied. A secret typed as a passphrase rather than generated is
hit even harder if it happens to be close to 32 characters long.

**The fix:** both modules now derive the KEK via HKDF-SHA256 (RFC 5869)
over the *entire* raw secret, with a fixed, module-specific salt/info pair
so the `vault` and `vault-backup` namespaces get distinct KEKs from the
same underlying env var:

```ts
crypto.hkdfSync("sha256", Buffer.from(raw, "utf8"), SALT, INFO, 32)
```

Every byte of the secret now contributes to the derived key regardless of
its length or encoding.

**Backward compatibility — no forced migration:** `unwrapDek()` in both
modules tries the new (strong) KEK first and falls back to the old
(truncate-and-pad) derivation only if that throws. This is safe rather than
a weakening: AES-256-GCM authenticates on decrypt, so a wrong key throws
(auth tag mismatch) instead of returning garbage — the fallback can only
ever succeed on a DEK that really was wrapped under the legacy derivation.
Already-deployed `encryption_keys` rows keep decrypting with zero downtime
or manual step. Every *new* DEK (first boot, or after `rotateKey()` /
`rotateBackupEnvelopeKey()`) is wrapped under the hardened KEK automatically
from here on.

**Changed**
- `artifacts/api-server/src/lib/vault-crypto.ts` — `wrapDek()`/`unwrapDek()`
  as above. `LEGACY_KEY` (the pre-KMS *field* encryption key, not a KEK) is
  deliberately left untouched — it directly encrypts un-migrated legacy
  rows, so changing its derivation would make them unreadable outright.
- `artifacts/api-server/src/lib/vault-backup-envelope.ts` — same pattern;
  `getKek()` now returns the hardened derivation, `getLegacyKek()` added for
  the fallback path.
- `scripts/src/rewrap-encryption-keys.ts` — now derives KEKs via the same
  HKDF logic (matching each module's salt/info exactly), and tries
  strong-then-legacy when reading rows under the OLD secret in normal
  rotation mode, mirroring the app's own self-healing order.

**New**
- `scripts/src/rewrap-encryption-keys.ts --upgrade-derivation` — an
  optional, one-shot migration for operators who want every existing
  `encryption_keys` row moved onto the hardened KEK immediately rather than
  left on the (still-secure-enough, but weaker) legacy wrap indefinitely.
  Takes a single `VAULT_MASTER_KEY` (no `OLD_`/`NEW_` pair needed — same
  secret, only the derivation changes), and is idempotent: a row already on
  the hardened wrap is detected via trial-unwrap and reported as `SKIP`,
  not re-written or treated as a failure. `--dry-run` supported as before.
- `vault-backup-disaster-recovery-runbook.md` §৬ — Bengali write-up of the
  above, matching the existing runbook's language and format.

## 2. Password-mode snapshot export — stronger key derivation cost

**Changed** (`routes/vault-snapshot.ts`)
- The scrypt cost factor for password-derived export keys (manual
  `POST /vault/snapshot/export` backups, `AYZENBAK...` blobs) is raised
  from Node's default (`N=16384, r=8, p=1`) to `N=131072, r=8, p=1`
  (`SCRYPT_V2_COST`) — roughly 8x the memory-hard work per password guess
  for anyone who steals a `.ayzenbak` file or a stored `vault_snapshots`
  row and tries to brute-force it offline.
- Blob format is versioned by prefix rather than silently swapped, since
  scrypt's cost parameters aren't recoverable from the blob and must match
  exactly between encrypt/decrypt: `AYZENBAK1` (legacy, Node-default cost)
  stays decrypt-only forever so every already-exported file keeps
  restoring; every new export is written as `AYZENBAK2` (hardened cost).
  `decryptBlob()` picks the right cost from the prefix automatically —
  callers (routes, restore-preview/restore) are unaffected.
- No in-place upgrade path for already-exported `.ayzenbak` files exists or
  is needed — they live outside the server (downloads folder, email, cloud
  storage), so there's nothing here to touch. Re-exporting picks up the
  stronger cost automatically.

## Verification not possible in this sandbox (no DB/network access)

- Run `rewrap-encryption-keys.ts --upgrade-derivation --dry-run` against a
  real `encryption_keys` table and confirm every row reports `OK` (legacy
  rows) or the expected `SKIP` (already-hardened rows on a second run).
- Confirm a snapshot exported before this change (`AYZENBAK1`) still
  restores with its original password, and a fresh export is written as
  `AYZENBAK2` and also restores correctly.
- `pnpm --filter @workspace/api-server tsc --noEmit` against the real
  workspace dependencies — only brace/paren balance was checked here, plus
  standalone `node` scripts exercising the HKDF/scrypt logic in isolation
  (both confirmed to behave as described above).
