# AYZEN Vault Backup — Envelope-Mode Disaster Recovery Runbook

**Scope:** এই ডকুমেন্ট শুধু **envelope-mode** (`ENV1:...`) automatic/scheduled vault backup-এর জন্য —
যেটা `lib/vault-backup-envelope.ts` + `lib/vault-backup-schedule-cron.ts`-এ implement করা।
**Password-mode** (manual, `AYZENBAK1:...`) export-এর recovery ইচ্ছাকৃতভাবে সম্পূর্ণ user-dependent
(কোড comment: *"AYZEN never keeps a copy and cannot recover a snapshot without it"*) — এই runbook-এর বাইরে।

কোনো কোড পরিবর্তন নেই এখানে — এটা শুধু বর্তমান আচরণের operational reference।

---

## ১. Architecture সংক্ষেপে (যা আছে)

| Component | মান | অবস্থান |
|---|---|---|
| KEK (key-encryption key) | `VAULT_MASTER_KEY` (fallback: `VAULT_FIELD_ENCRYPTION_KEY`) env var | কখনো DB-তে stored না |
| DEK (data-encryption key) | random 32-byte, KEK দিয়ে wrap করা | `encryption_keys` table, `namespace = 'vault-backup'` |
| Blob format | `ENV1:<version>:<iv>:<authTag>:<ciphertext>` | `vault_snapshots.blob` (column: `encryption_mode = 'envelope'`) |
| Integrity | SHA-256 checksum (`vault_snapshots.checksum`) + AES-GCM authTag | `verifyStoredChecksum()` |
| Boot loader | `loadBackupEnvelopeKeyManager()` — সব DEK version RAM cache-এ লোড করে | `index.ts` (~line 2630) |
| Rotation function | `rotateBackupEnvelopeKey()` — নতুন DEK generate করে active করে | `vault-backup-envelope.ts` |
| Off-vault copies | email attachment / webhook / Google Drive / Dropbox | `vault-backup-delivery.ts`, `vault-backup-cloud.ts` |

**Key versioning already কাজ করে:** পুরনো `encryption_keys` row কখনো delete হয় না, তাই পুরনো version-এর ব্যাকআপ পরেও decrypt করা যায় — এই অংশটা আপনার original diagram-এর "key versioning" requirement already satisfy করে, কোনো নতুন কোড লাগবে না।

---

## ২. সবচেয়ে গুরুত্বপূর্ণ সতর্কতা — এখনই পড়ুন

### ⚠️ ২.১ `VAULT_MASTER_KEY` বদলানো = সব envelope backup permanently unreadable

`unwrapDek()` সবসময় **current** env var দিয়ে unwrap করে — কোনো "re-wrap DEK under new KEK" script এই কোডবেসে **নেই**। তাই:

- `VAULT_MASTER_KEY` env var change/rotate করলে, `encryption_keys` টেবিলের **প্রতিটা** wrapped DEK (সব version, সব namespace — `vault` এবং `vault-backup` দুটোই, কারণ দুটোই একই KEK derivation logic শেয়ার করে) unwrap করা impossible হয়ে যায়।
- এটা কোনো "recovery" দিয়ে ঠিক করা যায় না — DEK নিজেই lost হয়ে যায়, শুধু ciphertext থেকে যায়।

**Action:** `VAULT_MASTER_KEY` কে treat করুন একটা **immutable root secret** হিসেবে — password-এর মতো নয়, বরং একবার set করে permanently secure storage-এ (secrets manager / offline vault) রাখুন। কখনো rotate করার প্রয়োজন হলে, তার আগে একটা "unwrap সব DEK under old KEK → re-wrap under new KEK" script লিখতে হবে (এখনো লেখা হয়নি — এটা backlog item, এই runbook-এর অংশ না)।

### ⚠️ ২.২ `encryption_keys` টেবিল থেকে কোনো row ডিলিট করবেন না

কোনো version-এর row হারালে, সেই version-এ encrypt হওয়া প্রতিটা পুরনো backup permanently unreadable (`envelopeDecryptBackup` throws `"Envelope key vN is unavailable"`)। এই টেবিল-টা DB backup-এ **অবশ্যই** include থাকতে হবে।

### ⚠️ ২.৩ Off-vault delivered কপি (email/Drive/Dropbox) একা যথেষ্ট না

`vault-backup-delivery.ts` যেটা email/webhook/cloud-এ পাঠায়, সেটা এখনো `ENV1:...` ciphertext — **শুধু server-side decrypt করা যায়**, কারণ DEK কখনো browser/client-এ যায় না। তার মানে:

> শুধু `.ayzenbak` ফাইলটা email/Drive-এ থাকলে সেটা দিয়ে কিছুই restore করা যাবে না, যদি না সাথে **(ক)** `VAULT_MASTER_KEY`-এর মান এবং **(খ)** `encryption_keys` টেবিলের সেই version-এর `wrapped_dek` row — এই দুটোও আলাদাভাবে সংরক্ষিত থাকে।

**Action:** Full infrastructure loss scenario-তে "3-2-1 backup" শুধু blob-এর জন্য যথেষ্ট না — **KEK + `encryption_keys` টেবিল** কেও একই disaster-recovery plan-এর অংশ করতে হবে।

### ⚠️ ২.৪ `rotateBackupEnvelopeKey()` কোনো route/cron থেকে call হয় না

Codebase-এ search করে দেখা গেছে এই function বর্তমানে **কোথাও invoke হয় না** — কোনো admin route নেই, কোনো scheduled job নেই। মানে বর্তমানে backup-envelope key rotation বাস্তবে কখনো ঘটে না; সবসময় version 1-ই active থাকে, যদি না manually (DB console / one-off script দিয়ে) call করা হয়।

**Action:** যদি periodic rotation policy চান, সেটার জন্য একটা admin route/cron আলাদা করে বানাতে হবে (কোড-change, তাই এই runbook-এর scope-এর বাইরে — শুধু gap হিসেবে নোট করা হলো)।

---

## ৩. Disaster Scenarios ও Procedure

### Scenario A — শুধু DB compromised/leaked হয়েছে (server env intact)

**ঝুঁকি:** কম। DB-তে শুধু wrapped DEK + ciphertext blob আছে — KEK (`VAULT_MASTER_KEY`) env var-এ, DB-তে না। আক্রমণকারীর কাছে শুধু DB থাকলে কোনো backup decrypt করতে পারবে না।

**করণীয়:**
1. যত দ্রুত সম্ভব `VAULT_MASTER_KEY` rotate করার প্রয়োজন নেই যদি সেটা DB-র বাইরের secret store-এ নিরাপদ থাকে — কিন্তু ধরে নিন attacker future access-এর জন্য চেষ্টা করবে, তাই DB credentials rotate করুন এবং access log audit করুন।
2. `vault_snapshots`, `encryption_keys`, `vault_backup_deliveries` টেবিলে কোনো অস্বাভাবিক access হয়েছে কিনা check করুন।
3. Server env (যেখানে `VAULT_MASTER_KEY` আছে) compromise হয়নি নিশ্চিত হলে — কোনো emergency rotation লাগবে না।

### Scenario B — Server/env compromised (attacker `VAULT_MASTER_KEY` পড়তে পেরেছে)

**ঝুঁকি:** সর্বোচ্চ। এই মুহূর্তে attacker যেকোনো envelope backup, এবং সব vault field data (namespace `vault`) decrypt করতে পারবে।

**করণীয় (তাৎক্ষণিক):**
1. Server isolate/shut down করুন।
2. এই ঘটনাকে **সব stored vault data + সব envelope backup-এর confidentiality breach** হিসেবে treat করুন — শুধু "backup" না, পুরো vault।
3. নতুন `VAULT_MASTER_KEY` generate করুন — কিন্তু §২.১ অনুযায়ী মনে রাখুন এটা সব পুরনো DEK unreadable করে দেবে, তাই **rotate করার আগে** পুরনো KEK দিয়ে সব DEK unwrap করে নতুন KEK দিয়ে re-wrap করার script প্রথমে চালাতে হবে (এই script এখনো লেখা হয়নি — জরুরি অবস্থায় লিখতে হবে `wrapDek`/`unwrapDek`-এর একই logic দিয়ে, শুধু old KEK read + new KEK write)।
4. সব user-কে notify করুন এবং vault password/PIN/2FA reset করতে বলুন (যদিও এগুলো DEK derive করে না, তবু credential hygiene হিসেবে জরুরি)।

### Scenario C — নির্দিষ্ট একটা backup (`vault_snapshots` row) corrupted/tampered

**করণীয়:**
1. Restore/download attempt করলে `verifyStoredChecksum()` fail করবে এবং error দেখাবে — এটা already automatic।
2. AES-GCM authTag mismatch হলে `envelopeDecryptBackup()` নিজেই throw করবে (`decipher.final()` fails) — partial/tampered decrypt কখনো silently succeed করবে না।
3. ওই নির্দিষ্ট row-টা বাদ দিয়ে **পরের সবচেয়ে recent ভালো snapshot** (`vault_snapshots` list থেকে) ব্যবহার করুন। `MAX_STORED_SNAPSHOTS` limit-এর মধ্যে একাধিক copy থাকার কথা।

### Scenario D — একটা নির্দিষ্ট DEK version হারিয়ে গেছে (accidental row delete)

**লক্ষণ:** `envelopeDecryptBackup` error দেয় — `"Envelope key vN is unavailable — cannot decrypt this backup"`।

**করণীয়:**
1. সেই version-এ encrypt হওয়া backup **permanently unrecoverable** — কোনো cryptographic workaround নেই (এটাই envelope encryption-এর নিয়ম)।
2. অন্য কোনো version-এ (আগে বা পরে) একই তথ্যের একটা recent backup আছে কিনা check করুন — থাকলে সেটা দিয়ে restore করুন।
3. Root cause হিসেবে নিশ্চিত করুন `encryption_keys` টেবিলে DELETE permission শুধু migration script-এর জন্য, application code-এর জন্য না (§২.২)।

### Scenario E — সম্পূর্ণ fresh deployment-এ restore করা (নতুন সার্ভার, disaster recovery test)

**Prerequisite:** পুরনো DB dump (অন্তত `vault_snapshots` + `encryption_keys` টেবিল সহ) **এবং** পুরনো `VAULT_MASTER_KEY`-এর মান — দুটোই লাগবে।

**Steps:**
1. নতুন server-এ পুরনো `VAULT_MASTER_KEY` (এবং `VAULT_FIELD_ENCRYPTION_KEY`) env var হিসেবে set করুন — exact একই মান, একটা character-ও ভিন্ন হলে সব DEK unwrap fail করবে।
2. DB dump restore করুন (`encryption_keys`, `vault_snapshots` টেবিল সহ)।
3. Server start করুন — boot-এ `loadKeyManager()` ও `loadBackupEnvelopeKeyManager()` স্বয়ংক্রিয়ভাবে চলবে (`index.ts`), সব DEK version RAM cache-এ লোড হবে।
4. UI/API দিয়ে "Stored Backups" list check করুন — snapshot গুলো visible হওয়া উচিত।
5. একটা snapshot বেছে **Restore Preview** (`POST /vault/snapshot/restore-preview`) চালান — এটা read-only diff দেখায় (কোনো data change হয় না), `buildRestoreDiff()`।
6. Diff ঠিক আছে নিশ্চিত হলে **Restore** (`POST /vault/snapshot/restore`) চালান — `applyRestoreDiff()` transaction-এ শুধু missing row insert করে, existing কিছু overwrite করে না (additive-only merge)।
7. Restore-এর পর `vault_activity_log`-এ entry নিশ্চিত করুন (`logActivity`)।

---

## ৪. Periodic Recovery Test — checklist (staging-এ চালান, production না)

- [ ] Staging DB-তে production `vault_snapshots` + `encryption_keys` টেবিলের একটা read-only copy আছে
- [ ] Staging server-এ production `VAULT_MASTER_KEY` (আলাদা secret-store থেকে, প্রতিবার manually inject — hardcode না) সাথে বুট করা যায়
- [ ] সব DEK version load হচ্ছে (boot log-এ error নেই) — `getActiveBackupEnvelopeVersion()` একটা সঠিক সংখ্যা return করছে
- [ ] একটা পুরনো (অন্তত এক rotation আগের) version-এর snapshot decrypt/restore করে দেখা — শুধু latest version না
- [ ] Checksum verification pass করছে (`verifyStoredChecksum`)
- [ ] Restore-preview diff count প্রত্যাশিত রেঞ্জে আছে (হঠাৎ 0 বা অস্বাভাবিক বড় সংখ্যা হলে investigate করুন)
- [ ] Off-vault delivered কপি (email/Drive) দিয়ে **আলাদাভাবে** — শুধু blob নিয়ে, KEK/DB access ছাড়া — decrypt করার চেষ্টা করে দেখা এটা **fail** করছে confirm করা (এটাই expected — §২.৩ অনুযায়ী)
- [ ] Test-এর ফলাফল ও তারিখ এই ডকুমেন্টে বা একটা runbook-log-এ note করা

**Cadence প্রস্তাব:** প্রতি quarter-এ একবার, এবং যেকোনো `VAULT_MASTER_KEY`-সংক্রান্ত infra change-এর আগে/পরে।

---

## ৫. Gaps — status

সব ৩টা gap বন্ধ করা হয়েছে (কোড/মাইগ্রেশন যোগ হয়েছে, `ayzen-full-project-fixed.zip`-এ আছে):

1. ~~KEK rotation script নেই~~ → **✅ ঠিক হয়েছে।** `scripts/src/rewrap-encryption-keys.ts` — `OLD_VAULT_MASTER_KEY` → `NEW_VAULT_MASTER_KEY` re-wrap, dry-run সহ। §২.১-এর procedure হালনাগাদ:
   ```
   OLD_VAULT_MASTER_KEY=... NEW_VAULT_MASTER_KEY=... DATABASE_URL=... \
     pnpm --filter @workspace/scripts rewrap:encryption-keys --dry-run
   # সব row "OK" দেখালে, --dry-run বাদ দিয়ে আবার চালান, তারপরই env var swap করুন
   ```
2. ~~`rotateBackupEnvelopeKey()` কোথাও call হয় না~~ → **✅ ঠিক হয়েছে।** `POST /admin/vault-backup/rotate-key` (`routes/vault-backup-key.ts`, `requireAdmin` গার্ড) — এবং `GET /admin/vault-backup/key-status` দিয়ে বর্তমান version list দেখা যায়।
3. ~~`encryption_keys`-এ delete protection নেই~~ → **✅ ঠিক হয়েছে।** Migration `067_ayzen_encryption_keys_delete_guard.sql` — `BEFORE DELETE` trigger, কোনো row delete করার চেষ্টা করলেই exception।

**নতুন যোগ পাওয়া (unrelated bug, incidentally ধরা পড়েছে, ঠিকও করা হয়েছে):** `scripts/package.json`-এর `./src/<name>.ts` path আশা করত, কিন্তু বেশিরভাগ script ভুলবশত `scripts/src/src/` (double-nested)-এ ছিল — `pnpm reencrypt:vault` ইত্যাদি আগে "file not found" দিত। ফাইলগুলো সঠিক জায়গায় সরানো হয়েছে; `reencrypt:seed-phrases` script entry-ও (আগে missing ছিল) যোগ করা হয়েছে।

**পরবর্তী ধাপ (এই sandbox-এ করা যায়নি — network/DB access নেই):**
- `pnpm install` করে পুরো workspace-এ `tsc --noEmit` চালিয়ে নতুন ফাইলগুলো আসল project dependency-এর বিপরীতে typecheck করা (এই sandbox-এ শুধু brace/paren balance আর JSON validity static-check করা হয়েছে — সেটা pass করেছে, কিন্তু এটা প্রকৃত TypeScript typecheck-এর বিকল্প না)।
- Staging DB-তে migration 067 apply করে, `rewrap-encryption-keys.ts --dry-run` আসল `encryption_keys` row-এর বিপরীতে চালিয়ে §৪-এর checklist অনুযায়ী verify করা।

---

## ৬. KEK derivation hardening (Round 3) — কী পাল্টেছে

`lib/vault-crypto.ts` আর `lib/vault-backup-envelope.ts`-এর KEK derivation আগে ছিল
`raw.slice(0, 32).padEnd(32, "0")` — অর্থাৎ `VAULT_MASTER_KEY`/
`VAULT_FIELD_ENCRYPTION_KEY`-এর শুধু প্রথম ৩২ *character* ব্যবহার হত, বাকিটা
silently ignore। যেহেতু এই ফাইলগুলোই `openssl rand -hex 32` (৬৪-character
hex) recommend করে, বাস্তবে ~256-bit-এর বদলে ~128-bit entropy ব্যবহার হচ্ছিল।
৩২ character-এর কম কোনো secret দিলে বাকিটা `"0"` দিয়ে pad হত, সেটাও দুর্বল।

**Fix:** পুরো raw secret-টা এখন HKDF-SHA256 (RFC 5869) দিয়ে একটা 256-bit KEK-এ
derive হয় (module-ভিত্তিক আলাদা salt/info দিয়ে, যাতে `vault` আর `vault-backup`
namespace আলাদা KEK পায়)। এটা backward-compatible — `unwrapDek()` আগে নতুন
(strong) KEK দিয়ে try করে, fail করলে (AES-GCM auth tag mismatch) পুরনো
derivation-এ fallback করে। তাই **কোনো forced migration ছাড়াই** already-deployed
`encryption_keys` row সব চলতে থাকবে, আর নতুন প্রতিটা DEK (bootstrap বা
`rotateKey()`/`rotateBackupEnvelopeKey()`) স্বয়ংক্রিয়ভাবে hardened KEK দিয়ে wrap
হবে।

**ঐচ্ছিক ধাপ — existing row-গুলো এখনই strong KEK-এ upgrade করতে চাইলে:**
```
VAULT_MASTER_KEY=... DATABASE_URL=... \
  npx tsx scripts/src/rewrap-encryption-keys.ts --upgrade-derivation --dry-run
# সব row "OK" বা "SKIP (already on the hardened derivation)" দেখালে,
# --dry-run বাদ দিয়ে আবার চালান।
```
এই মোডে `OLD_VAULT_MASTER_KEY`/`NEW_VAULT_MASTER_KEY` লাগে না — একই secret,
শুধু derivation পাল্টায়, তাই কোনো env var swap বা restart-সিকোয়েন্স নেই।
Idempotent: যে row ইতিমধ্যে hardened, সেটা "SKIP" হিসেবে detect হয়ে বাদ যায়।

**Password-mode snapshot export (`AYZENBAK...` blob) — আলাদা পরিবর্তন:**
scrypt cost factor বাড়ানো হয়েছে (`N=16384` → `N=131072`, ~৮x memory-hard
work per password-guess)। ব্লব prefix দিয়ে version করা — `AYZENBAK1` পুরনো
cost-এ decrypt-only থাকবে (আগের exported `.ayzenbak` ফাইল সব কাজ করবে),
নতুন প্রতিটা export `AYZENBAK2`-এ (নতুন cost) লেখা হয়। পুরনো ফাইলে হার্ডেনড
cost পেতে হলে re-export করা ছাড়া উপায় নেই (ওগুলো server-এর বাইরে, touch করার
কিছু নেই) — এই ব্লবের-ভেতরে upgrade path প্রযোজ্য না।

**এই round-এ verification যা করা যায়নি (sandbox-এ DB/network নেই):**
- আসল `encryption_keys` টেবিলের বিপরীতে `--upgrade-derivation --dry-run`
  চালিয়ে প্রতিটা row "OK"/"SKIP" দেখায় কিনা যাচাই করা।
- একটা পুরনো (hardening-এর আগে তৈরি) `AYZENBAK1` snapshot এখনো সঠিক পাসওয়ার্ড
  দিয়ে decrypt হয় কিনা, আর একটা নতুন export সত্যিই `AYZENBAK2` prefix পায়
  কিনা — ম্যানুয়ালি বা একটা integration test দিয়ে confirm করা।

## ৭. Cross-user envelope-backup decrypt hole (Round 4) — কী পাল্টেছে

**সমস্যা:** envelope-mode (scheduled) backup-এর কোনো user-typed password নেই —
সব user-এর জন্য একটাই server-side DEK। `POST /vault/snapshot/restore-preview`
আর `/restore` আগে client থেকে সরাসরি `{ blob }` নিয়ে, prefix দেখে (`ENV1:...`)
বুঝত এটা envelope mode, আর কোনো ownership check ছাড়াই decrypt করে দিত। মানে
**যেকোনো authenticated user**, যদি কোনোভাবে **অন্য কোনো user**-এর envelope
blob পেয়ে যায় (misdirected email/webhook/cloud delivery, support ticket-এ paste
করা, DB dump, ইত্যাদি) — নিজের account দিয়ে সেটা এই endpoint-এ POST করে
পাসওয়ার্ড ছাড়াই decrypt করে ফেলতে পারত। GET `/vault/snapshots/:id/download`
ইচ্ছাকৃতভাবেই owner-কে raw blob download করতে দেয় (\"move off-vault by hand\"
feature), তাই blob বাইরে বের হওয়ার একটা বৈধ পথও আছে — সমস্যাটা সেই blob
অন্য user decrypt করতে পারা নিয়ে।

**Fix — দুই independent layer:**

1. **Access control (মূল fix):** `decryptSnapshotFromRequest()` এখন client-supplied
   `blob`-কে **শুধু password mode** হিসেবেই treat করে, prefix যাই বলুক না কেন।
   Envelope-mode snapshot এখন **শুধু `snapshotId` দিয়েই** restore করা যায় — যেটা
   আগে থেকেই `userId`-filtered query দিয়ে lookup হয় (নিজের row ছাড়া আর কারো
   row মেলে না), decrypt করার আগেই।
2. **Cryptographic binding (defense-in-depth):** নতুন সব envelope blob এখন
   `ENV2:...` format-এ লেখা হয় — AES-256-GCM-এর AAD (associated data) দিয়ে
   `vault-backup:v<version>:user:<ownerUserId>` bind করা থাকে। `envelopeDecryptBackup()`
   এখন `ownerUserId` argument নেয়, আর ভুল userId দিয়ে call করলে auth tag
   mismatch হয়ে throw করবে — ঠিক ভুল key দেওয়ার মতোই। মানে layer ১ ভবিষ্যতে
   কোনো bug দিয়ে bypass হলেও, ভুল owner-এর blob decrypt হবে না। পুরনো
   `ENV1:...` blob-এ AAD নেই (legacy, decrypt-only) — সেগুলোর সুরক্ষা শুধু
   layer ১ থেকেই আসে, তাই layer ১ optional না।

**Backward compatibility:** পুরনো `ENV1:...` blob (Round 4-এর আগে লেখা) আগের
মতোই decrypt হয় — কোনো forced re-encryption নেই। নতুন প্রতিটা scheduled
backup স্বয়ংক্রিয়ভাবে `ENV2:...`-এ লেখা হবে।

**এই round-এ verification যা করা যায়নি (sandbox-এ DB/network নেই):**
- আসল DB-তে একটা scheduled backup চালিয়ে stored row সত্যিই `ENV2:...` prefix
  পাচ্ছে কিনা, আর নিজের `snapshotId` দিয়ে normal restore-preview/restore আগের
  মতোই কাজ করছে কিনা যাচাই করা।
- একটা `ENV2` blob-এর owner-userId ম্যানুয়ালি বদলে (বা অন্য user-এর
  `snapshotId` জোর করে দিয়ে) decrypt attempt করলে সেটা সত্যিই fail করে কিনা
  (auth tag mismatch) confirm করা।
- পুরনো `ENV1` snapshot এখনো (এই round-এর পরেও) নিজের owner-এর জন্য
  normal path দিয়ে ঠিকমতো decrypt হচ্ছে কিনা।

## ৮. Webhook delivery-এ SSRF সুরক্ষা (Round 5) — কী পাল্টেছে

**সমস্যা:** backup schedule-এর webhook destination-এ user নিজে একটা URL দেয়,
আর সেই URL-এ POST request **user-এর browser না, server নিজেই** পাঠায় —
প্রতিটা scheduled run-এ, encrypted backup blob সহ। আগে validation ছিল শুধু
`isHttpUrl()` — মানে `http:`/`https:` scheme কিনা দেখা হত, URL কোথায় point
করছে সেটা কখনো check হত না। ফলে কেউ (malicious বা compromised account)
webhookUrl-এ `http://169.254.169.254/...` (cloud metadata endpoint —
প্রায়ই IAM credential-এর সরাসরি রাস্তা), internal admin panel, বা এমন কোনো
address দিতে পারত যেখানে server-এর network পৌঁছাতে পারে কিন্তু account
holder নিজে পারে না — classic SSRF, আর সেটা schedule বন্ধ না করা পর্যন্ত বারবার ঘটতে থাকবে।

**Fix:** নতুন `lib/ssrf-guard.ts`-এ `assertPublicHttpsUrl()` — এখন থেকে
webhook URL অবশ্যই `https:` হতে হবে, আর hostname-টা আসল DNS lookup করে
resolve করে প্রতিটা address private/loopback/link-local/reserved/multicast
range-এর মধ্যে পড়ছে কিনা check করা হয় (IPv4 আর IPv6 দুটোই, IPv4-mapped
IPv6 সহ — যেমন `::ffff:169.254.169.254`, যেটা শুধু IPv4-check দিয়ে ধরা
পড়ত না)। এই check দুই জায়গায় বসানো হয়েছে: (১) schedule save করার সময়
(`routes/vault-backup-schedule.ts`) — সাথে সাথে feedback দেওয়ার জন্য, আর
(২) **যেটা আসলে গুরুত্বপূর্ণ** — প্রতিটা actual delivery-এর ঠিক আগে
(`lib/vault-backup-delivery.ts`), কারণ save করার পর DNS বদলে যেতে পারে।
Webhook fetch-এ `redirect: "manual"` ও যোগ করা হয়েছে, যাতে একটা validated
public URL 3xx দিয়ে internal address-এ redirect করে check বাইপাস করতে না পারে।

**যা পুরোপুরি বন্ধ হয়নি (documented, silent না):** খুব sophisticated DNS
rebinding (near-zero TTL, প্রতি query-তে আলাদা answer) দিয়ে theoretically
এই check-কে fool করা সম্ভব — সেটা পুরোপুরি বন্ধ করতে হলে নতুন dependency
লাগত (low-level connect/lookup override), যেটা এই round-এ যোগ করা হয়নি।
বাস্তব, low-effort attack (literal internal IP, static internal hostname,
redirect bypass) এই fix দিয়ে বন্ধ।

**⚠️ Behavior change:** আগে থেকে configured কোনো webhook `http://`-তে থাকলে
এখন থেকে delivery fail করবে (`vault_backup_deliveries`-এ normal failed row
হিসেবে দেখাবে, crash না) — `https://`-তে আপডেট করতে হবে। Email/Google
Drive/Dropbox delivery-তে কোনো প্রভাব নেই।

**এই round-এ verification যা করা যায়নি (sandbox-এ DB/network নেই):**
- আসল app-এ একটা `https://` webhook schedule সত্যিই end-to-end deliver
  হচ্ছে কিনা, আর আগে থেকে `http://`-এ configured কোনো schedule এই round-এর
  পর clear failed-delivery row দেখাচ্ছে কিনা (crash না করে) — confirm করা।
