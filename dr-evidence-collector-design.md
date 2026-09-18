# AYZEN Vault Backup — DR Evidence Collection: Full Design

**Status:** Phase 1 (§8) implemented — see `CHANGES_DR_EVIDENCE_PHASE1.md` for exactly
what shipped (`dr_test_reports` table, `lib/dr-test-runner.ts`, `POST /admin/dr-tests/run-now`
+ list/detail routes). Phase 2 (schema-isolated restore) and Phase 3 (scheduler,
dashboard, alerting, hash chain) are still design-only, per the rest of this
document. এই ডকুমেন্ট আগের
`vault-backup-disaster-recovery-runbook.md`-এর উপর বসে — সেটা ছিল manual runbook,
এটা সেই manual process-কে একটা automated, evidence-generating subsystem-এ রূপান্তরের প্ল্যান।

---

## ০. একটা scope boundary যেটা প্রথমেই ঠিক করা দরকার

**Automated DR test শুধু envelope-mode (scheduled) snapshot নিয়ে চলবে — password-mode (manual) snapshot নয়।**

কারণ: password-mode ব্যাকআপ decrypt করতে `scrypt(password, salt)`-এর জন্য user-এর password লাগে,
যেটা কোথাও stored নেই (ইচ্ছাকৃতভাবে, দেখুন আগের আলোচনা)। একটা 3AM scheduled cron-এর কাছে
সেই password থাকার কোনো উপায় নেই — থাকলে সেটা zero-knowledge design-টাই ভেঙে দেবে।

তাই দুইটা আলাদা track:
- **Automated DR test** → শুধু `encryptionMode = 'envelope'` snapshot, পুরো ১৩-feature pipeline প্রযোজ্য।
- **Manual DR test (password-mode)** → owner নিজে quarterly manually password দিয়ে
  restore-preview চালাবে; evidence record তৈরি হবে কিন্তু "scheduled" না, "manually triggered" flag সহ।

এই boundary-টা design-এর বাকি অংশ জুড়ে ধরে রাখা হয়েছে।

---

## ১. সবচেয়ে বড় architectural সিদ্ধান্ত: "Isolated Restore Target" আসলে কী হবে

তিনটা option বিবেচনা করা হয়েছে:

| Option | কী | Feasibility এই codebase-এ |
|---|---|---|
| **A. Schema-level isolation** (একই Postgres instance-এ `dr_test_<run_id>` নামে আলাদা schema) | `CREATE SCHEMA dr_test_x`, তারপর সেই schema-তে migration+restore চালানো, শেষে `DROP SCHEMA ... CASCADE` | ✅ **করা সম্ভব, ন্যূনতম নতুন infra লাগবে** |
| B. আলাদা ephemeral database (managed Postgres branching, যেমন Neon/Supabase branch API) | সত্যিকারের full isolation, compute/storage আলাদা | ⚠️ Provider-dependent API integration লাগবে, এই কোডবেসে নেই |
| C. Container/VM spin-up প্রতি টেস্টে | সবচেয়ে বেশি isolation | ❌ কোনো orchestration tooling নেই এখানে (Replit-based deployment) |

**সুপারিশ: Option A দিয়ে শুরু, ভবিষ্যতে scale প্রয়োজন হলে B।**

### কেন Option A বাস্তবসম্মত — কোডের একটা সুবিধা পাওয়া গেছে

`index.ts`-এর `MIGRATIONS` array-তে টেবিল নামগুলো **schema-qualified না** (যেমন
`"CREATE TABLE IF NOT EXISTS vault_entries (...)"`, `public.vault_entries` না) — তার মানে
একই migration array একটা নতুন DB connection/session-এ চালানো যায় যার
`search_path = dr_test_<run_id>, public` সেট করা, আর টেবিলগুলো automatically সেই
isolated schema-তে তৈরি হয়ে যাবে, **migration script duplicate করতে হবে না।**

তবে একটা real gap আছে: `applyRestoreDiff()` আর বাকি সব route drizzle-এর singleton `db`
instance ব্যবহার করে, যেটার কোনো per-call schema override নেই। DR test runner-এর জন্য
লাগবে:
- একটা dedicated `pg.Client` (pool না, কারণ `SET search_path` session-sticky হতে হবে) যেটা টেস্ট শুরুতে `SET search_path TO dr_test_x, public` চালায়
- সেই client-এর উপর একটা আলাদা drizzle instance wrap করা, যেটা শুধু DR test runner-এর ভেতরে ব্যবহার হবে — production `db` singleton-কে কখনো touch করা হবে না

এটা একটা নতুন, ছোট abstraction (`lib/dr-test-db.ts`-এর মতো কিছু) — বড় refactor না, কিন্তু
existing `applyRestoreDiff(userId, snapshot)`-কে হুবহু reuse করার বদলে সেটাকে একটা
optional `dbOverride` parameter নিতে হবে যাতে DR runner নিজের isolated session পাস করতে পারে।
(এইটুকু ছোট signature change ছাড়া বাকি সব existing restore logic অবিকৃত থাকে।)

---

## ২. পুরো Pipeline — বাস্তব function/table reference সহ

```
Scheduled DR Test (node-cron, vault-backup-schedule-cron.ts-এর প্যাটার্নে)
        │
        ▼
Select Snapshot
  → SELECT ... FROM vault_snapshots WHERE encryption_mode = 'envelope'
    ORDER BY created_at DESC LIMIT 1  (বা admin-configured policy: latest / random / oldest-untested)
        │
        ▼
Record test_id + snapshot metadata (evidence Stage 1 — এখনো কিছু decrypt হয়নি)
        │
        ▼
Checksum Verify
  → verifyStoredChecksum(row)  [already exists, vault-snapshot.ts]
        │  FAIL হলে → evidence.integrity_result = 'fail', stop, alert
        ▼
Decrypt
  → envelopeDecryptBackup(row.blob)  [already exists, vault-backup-envelope.ts]
        │  FAIL হলে (key version unavailable / auth tag mismatch) → evidence.decryption_result = 'fail', stop, alert
        ▼
Create Isolated Schema
  → CREATE SCHEMA dr_test_<run_id>
  → নতুন session-এ SET search_path, MIGRATIONS array পুনরায় চালানো
        │
        ▼
Restore into Isolated Schema
  → applyRestoreDiff(userId, decryptedSnapshot, { dbOverride: isolatedDb })
    [existing additive-only merge logic reuse — নতুন কিছু লেখা লাগবে না, শুধু override param]
        │
        ▼
Verification Suite (নতুন কোড, কিন্তু সহজ — record-count তুলনা)
  → snapshot payload-এর counts (JSON-এ already আছে, buildVaultSnapshotPayload আউটপুট)
    বনাম isolated schema-তে SELECT COUNT(*) প্রতিটা টেবিলে
        │
        ▼
RTO measurement
  → প্রতিটা ধাপের timestamp রেকর্ড করে total duration বের করা (Date.now() diff, নতুন কিছু না)
        │
        ▼
Cleanup
  → DROP SCHEMA dr_test_<run_id> CASCADE  (সবসময় চলবে, এমনকি আগের ধাপ fail করলেও — finally ব্লকে)
        │
        ▼
Generate Evidence Record + Hash Chain
        │
        ▼
Store (নতুন টেবিল dr_test_reports)
        │
        ▼
PASS হলে → dr_test_reports.result='pass'; FAIL হলে → notificationsTable + sendEmail (existing pattern, emergency-access.ts/vault-backup-schedule-cron.ts যেভাবে করে)
```

---

## ৩. Data Model (নতুন টেবিল, migration draft — লেখা হবে code phase-এ)

### `dr_test_reports`
| Column | Type | নোট |
|---|---|---|
| id | serial PK | |
| test_id | text unique | human-readable, যেমন `DR-2026-0091` |
| triggered_by | text | `'scheduled'` \| `'manual'` |
| snapshot_id | int (FK → vault_snapshots.id) | কোন backup টেস্ট হয়েছে |
| encryption_mode | text | সবসময় `'envelope'` automated test-এর জন্য |
| key_version | int | কোন DEK version দিয়ে decrypt হয়েছে |
| backup_checksum | text | evidence — কোন exact checksum |
| started_at / completed_at | timestamp | |
| isolated_schema_name | text | audit-এর জন্য, cleanup নিশ্চিত করতে |
| checksum_result | text | pass/fail |
| decryption_result | text | pass/fail |
| restore_result | text | pass/fail |
| records_expected / records_restored | jsonb | টেবিল-ভিত্তিক count map |
| rto_ms | int | |
| overall_result | text | pass/fail |
| failure_stage | text nullable | কোন ধাপে fail করলো |
| failure_reason | text nullable | |
| report_hash | text | SHA-256, নিচের রুল অনুযায়ী compute |
| prev_report_hash | text nullable | hash chain |
| runner_version | text | কোড version/git sha |
| created_at | timestamp | |

**গুরুত্বপূর্ণ constraint:** এই টেবিলে **কখনো** plaintext secret/decrypted field value যাবে না —
শুধু counts, timestamps, pass/fail, checksum/hash। এটা `vault-snapshot-restore.ts`-এর
`buildRestoreDiff()`-এর existing discipline-এর মতোই ("small NON-SENSITIVE preview list —
display names only — never passwords/2FA/backup codes/seed phrases")।

### `dr_test_schedules`
frequency, preferred_time, backup_selection_policy, notification_recipients, timeout_ms,
enabled — গঠনটা প্রায় হুবহু existing `vault_backup_schedules` টেবিলের প্যাটার্ন অনুসরণ করবে।

### Hash chain রুল
```
report_hash = SHA256(
  test_id + started_at + snapshot_id + backup_checksum +
  overall_result + records_restored_json + prev_report_hash
)
```
প্রতিটা নতুন report-এর `prev_report_hash` = সর্বশেষ report-এর `report_hash`। Chain verify করার
জন্য একটা আলাদা read-only script (`verify-dr-chain.ts`-এর মতো) — `reencrypt-vault.ts`-এর
প্যাটার্নে standalone, network-optional।

---

## ৪. Verification Suite — কোনটা সত্যিই দরকার, কোনটা নয়

আপনার list-এর ১১টা check থেকে বাস্তবে কী কী independent signal দেয়:

| Check | ইতিমধ্যে বাস্তবায়িত ফাংশন | নতুন কাজ |
|---|---|---|
| Backup exists | `SELECT ... FROM vault_snapshots` | না |
| Checksum valid | `verifyStoredChecksum()` | না |
| Encryption/key version valid | `envelopeDecryptBackup()`-এর ভেতরেই (throws if missing) | না |
| Decryption successful | ঐ একই call-এর success | না |
| Schema valid | Isolated schema-তে migration run সফল হয়েছে কিনা | নতুন (ছোট) |
| Records/attachments consistent | count comparison | নতুন (ছোট) |
| Restore successful | `applyRestoreDiff()` exception ছাড়া শেষ হয়েছে কিনা | dbOverride param যোগ |
| Cleanup successful | `DROP SCHEMA` সফল | নতুন (ছোট) |

মানে ৮টার মধ্যে ৫টা checksum/decrypt/exists ইতিমধ্যে existing function-এর reuse —
নতুন engineering effort মূলত schema isolation + count-comparison + cleanup-এ।

---

## ৫. RTO Target — বাস্তবসম্মত সংখ্যা

Diagram-এ `< 60 sec` example দেওয়া ছিল। বাস্তব vault-এর সাইজ অনুযায়ী এটা vary করবে
(mail/finance/wallet সহ পুরো snapshot বড় হতে পারে)। Design-এর সুপারিশ: প্রথম কয়েকটা
real run-এর measured RTO-কে baseline ধরে target সেট করুন (hardcoded 60s ধরে নেওয়ার
বদলে) — dashboard নিজেই সেই baseline থেকে trend দেখাবে।

---

## ৬. Alerting — reuse করার জায়গা

- Fail হলে → `notificationsTable` (owner/admin) + `sendEmail` — ঠিক
  `emergency-access.ts`-এর approve/deny flow যেভাবে করে
- Repeated fail (২টা consecutive) → escalation, `logger.error` + আলাদা admin-only notification
- কোনো নতুন notification infra লাগবে না, existing `lib/email.ts` + `notificationsTable` যথেষ্ট

---

## ৭. Dashboard — কোথায় বসবে

Existing admin pattern অনুসরণ করে: `pages/admin/emergency-access.tsx`-এর মতো একটা নতুন
`pages/admin/dr-health.tsx`, backend-এ `GET /admin/dr-tests` (list) +
`GET /admin/dr-tests/:id` (single report detail) + `POST /admin/dr-tests/run-now`
(manual trigger, `requireAdmin` গার্ড, `sensitiveWriteLimiter`)।

---

## ৮. Phased রোলআউট প্ল্যান

| Phase | কী বানাবে | Isolated schema লাগে? |
|---|---|---|
| **Phase 1 ✅ Implemented** | Evidence table + checksum/decrypt verification শুধু (Stage: Backup Integrity, §০-এ যা ইতিমধ্যে ready-made ফাংশন দিয়ে হয়) — কোনো restore না | না |
| **Phase 2** | Schema-isolated restore + record-count verification + RTO measurement | হ্যাঁ (Option A) |
| **Phase 3** | Scheduler (node-cron) + dashboard + alerting + hash chain | না (Phase 1-2-এর উপর বসে) |
| **Phase 4 (optional, later)** | সত্যিকারের আলাদা DB/branch isolation (Option B) — শুধু যদি Phase 2-এর schema-isolation কোনো contention/scale সমস্যা তৈরি করে | হ্যাঁ (নতুন provider integration) |

**সুপারিশ:** Phase 1 আগে করুন — এটা সবচেয়ে কম ঝুঁকি (কোনো restore logic নেই), কিন্তু তাও
"আমরা backup verify করি" দাবিটা প্রমাণ করার জন্য যথেষ্ট evidence তৈরি করে। Phase 2 হলো
আসল ভারী কাজ (schema isolation + dbOverride plumbing)। Phase 3 মূলত wiring/UI।

---

## ৯. Open প্রশ্ন যেগুলো code লেখার আগে ঠিক করা ভালো

1. Isolated schema-তে migration run করার সময় production `MIGRATIONS` array-ই reuse করব,
   না নাকি একটা trimmed subset (শুধু vault-সম্পর্কিত টেবিল, mail/finance বাদ) — পুরোটা
   চালালে প্রতিটা DR test একটু ধীর হবে কিন্তু সবচেয়ে বেশি বাস্তবসম্মত।
2. `dr_test_reports`-এর retention policy — কতদিন রাখা হবে, নাকি সব রাখা হবে (evidence
   হিসেবে সবসময় রাখাই ভালো, কিন্তু storage growth বিবেচনা করা দরকার)।
3. Multi-user vault হলে (প্রতিটা user-এর নিজের snapshot) — DR test কি per-user চলবে,
   নাকি একটা representative sample/rotating user বেছে নেবে? পুরো userbase-এর প্রতিটা
   user-এর জন্য প্রতিদিন full restore চালানো খরচসাপেক্ষ হতে পারে।

---

এই প্ল্যানটা রিভিউ করে বলুন কোথা থেকে code phase শুরু করব — Phase 1 (সবচেয়ে কম ঝুঁকি,
আজই শুরু করা যায়) নাকি সরাসরি Phase 2 (schema isolation, আসল ভারী অংশ)।
