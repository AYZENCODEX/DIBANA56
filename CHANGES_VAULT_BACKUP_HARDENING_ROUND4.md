# CHANGES — Vault Backup Hardening, Round 4

One fix this round: a cross-user confidentiality hole in scheduled
(envelope-mode) backup restore. Round 1 covered envelope encryption /
rotation / DR evidence, Round 2 covered snapshot delete protection and
DR-test scheduling, Round 3 hardened the KEK derivation and the
password-mode export KDF cost. This round is about *who* can decrypt an
envelope-mode backup, not the strength of the encryption itself.

## The bug

Envelope-mode (scheduled/automatic) backups have no user-typed password —
there's nobody present to type one on a timer — so they're encrypted under
one server-managed key shared across **every** user (`lib/vault-backup-envelope.ts`).
That's fine as long as decryption only ever happens through a path that's
already checked the caller owns the row it's decrypting.

It wasn't. `routes/vault-snapshot.ts`'s `decryptSnapshotFromRequest()` (used
by both `POST /vault/snapshot/restore-preview` and `POST /vault/snapshot/restore`)
accepted a client-supplied `{ blob }` directly, sniffed its prefix, and if it
looked like `"ENV1:..."` decrypted it with **no password and no ownership
check at all**. Since the envelope key is global, not per-user, anyone who
obtained *any* user's envelope blob — by any means (a misdirected email/
webhook/cloud delivery, a support ticket, a DB export, someone pasting it
somewhere) — could decrypt it themselves by POSTing it under their own
account. `GET /vault/snapshots/:id/download` legitimately hands a user their
own raw envelope blob back (documented as "so an automatic backup can still
be moved off-vault by hand"), so there's always been a normal path for a
blob to leave the server; the bug is that nothing stopped a *different*
user from decrypting it afterward.

Password-mode (manual) exports were never affected — an attacker would
still need the export password, which this bug doesn't touch.

## The fix — two independent layers

**1. Access control (`routes/vault-snapshot.ts`).** A client-supplied `blob`
is now treated as password mode **only**, regardless of what its prefix
claims. Envelope-mode snapshots can only be restored via `snapshotId`, which
is resolved through a query already filtered to `eq(vaultSnapshotsTable.userId, userId)`
— i.e. only ever the caller's own row — *before* anything is decrypted. This
alone closes the hole.

**2. Cryptographic binding (`lib/vault-backup-envelope.ts`), defense in
depth.** Every new envelope blob is written in a bumped format, `ENV2:...`,
which authenticates an AES-256-GCM associated-data (AAD) tag of
`vault-backup:v<version>:user:<ownerUserId>`. `envelopeEncryptBackup()` now
takes the owning `userId` and binds it in; `envelopeDecryptBackup()` now
takes the *expected* owner and binds the same AAD on decrypt — GCM's auth
tag fails exactly like a wrong key would if the userId doesn't match. So
even if layer 1 were ever bypassed by a future bug — or a row's `user_id`
were altered by some other means entirely (e.g. a SQL injection bug
elsewhere) — decrypting under the wrong owner now fails outright instead of
silently returning someone else's vault. Old `ENV1:...` blobs (written
before this round) carry no AAD and decrypt regardless of the userId passed
in; those are protected by layer 1 only, which is exactly why layer 1 is the
fix and layer 2 is the backstop, not the other way around.

**Backward compatibility — no forced migration:** existing `ENV1:...` rows
keep decrypting exactly as before, with zero downtime or manual step. Every
new scheduled backup is written as `ENV2:...` automatically from here on.
`envelopeDecryptBackup()` picks the AAD-or-not behavior from the prefix, so
callers are unaffected either way.

**Changed**
- `artifacts/api-server/src/lib/vault-backup-envelope.ts` —
  `envelopeEncryptBackup(plaintext, ownerUserId)` and
  `envelopeDecryptBackup(blob, ownerUserId)` now take/require the owning
  userId; new blobs are written as `ENV2:...` with AAD bound to it. `ENV1`
  kept as a legacy, no-AAD, decrypt-only format.
- `artifacts/api-server/src/lib/vault-backup-schedule-cron.ts` — passes the
  schedule's `userId` into `envelopeEncryptBackup()`.
- `artifacts/api-server/src/lib/dr-test-runner.ts` — passes the tested
  snapshot row's `userId` into `envelopeDecryptBackup()`.
- `artifacts/api-server/src/routes/vault-snapshot.ts` —
  `decryptSnapshotFromRequest()` no longer accepts a client-supplied `blob`
  for envelope mode at all; envelope decrypt only ever runs against a
  `snapshotId`-resolved, `userId`-scoped row, and passes that row's real
  `userId` (never anything client-asserted) as the AAD owner.
- `vault-backup-disaster-recovery-runbook.md` §৭ — Bengali write-up of the
  above, matching the existing runbook's language and format.

## Verification not possible in this sandbox (no DB/network access)

- Run a scheduled backup against a real DB and confirm the stored row's
  blob is written with the `ENV2:` prefix, and that the owning user's own
  `restore-preview`/`restore` via `snapshotId` still works end to end.
- Confirm that calling `envelopeDecryptBackup()` with an `ownerUserId` that
  doesn't match the blob's original owner throws (AAD/auth-tag mismatch),
  and that a pre-existing `ENV1:...` snapshot still decrypts correctly for
  its real owner after this change.
- Confirm `POST /vault/snapshot/restore-preview`/`restore` reject a
  client-supplied `blob` that starts with `ENV1:`/`ENV2:` with a normal
  "could not decrypt" error (treated as a malformed password-mode file)
  rather than ever attempting an envelope decrypt on it.
- Only brace/paren balance and an isolated `tsc --noEmit` parse pass
  (no workspace type resolution) were checked here, plus a standalone
  Node script exercising the AAD encrypt/decrypt logic in isolation
  (confirmed: correct-owner decrypt succeeds, wrong-owner decrypt throws).
