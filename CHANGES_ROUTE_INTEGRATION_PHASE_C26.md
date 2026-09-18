# Route Integration Roadmap — Season C, Phase C26: `projects/bulk-enroll`-এর `entityIds` path — cross-tenant ownership bypass ফিক্স

## এই ফেজের scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_C26_C35.md`-এর নিজস্ব audit context থেকে
পাওয়া একমাত্র আসল security bug (বাকি সব ফেজ হয় consistency/hygiene নয়তো
owner-decision-gated) — তাই C26 আলাদা, সবচেয়ে আগে করা ফেজ হিসেবে ধরা হলো।

## বাগ

`bulk.ts`-এর `POST /projects/bulk-enroll` দুইভাবে entity resolve করত:

- `entitySerials` দিলে → `SELECT id FROM vault_entries WHERE user_id =
  ${userId} AND entity_serial IN (...)` — ঠিকভাবে caller-এর নিজের
  entity-তেই scoped।
- `entityIds` (raw numeric id) দিলে → **কোনো ownership check ছাড়াই**
  সরাসরি `INSERT INTO project_enrollments (project_id, vault_entry_id,
  user_id, ...) VALUES (${projectId}, ${entityId}, ${userId}, ...)`-এ
  বসে যেত।

মানে যে কেউ অন্য কারো `vault_entries.id` (numeric, guessable/enumerable)
`entityIds` অ্যারেতে পাঠালে, সেই entity-টা তার নিজের নামে (`user_id =
${userId}`) একটা project-এ enroll হয়ে যেত — cross-tenant fake enrollment
row তৈরি হতো, যেটা airdrop calendar/dashboard-এ অন্য কারো entity নিজের
বলে দেখাতে পারত, আর enrollment-নির্ভর downstream লজিকে (reward
eligibility, task completion) leak/confusion তৈরি করতে পারত।

## ফিক্স

`entityIds` path-কে `entitySerials`-এর মতোই `vault_entries.user_id =
${userId}` দিয়ে pre-filter করা হলো — শুধু resolved, owned id-গুলোই
`safeEntityIds`-এ যোগ হয়, non-owned id silently drop হয় (caller-কে কোনো
leak না দিয়ে, এই সিরিজের বাকি silent-no-op route গুলোর মতোই)।

```ts
const requestedIds = safeIds(entityIds ?? []);
if (requestedIds.length) {
  const idList = requestedIds.join(",");
  const ownedRows = await db.execute(sql.raw(
    `SELECT id FROM vault_entries WHERE user_id = ${userId} AND id IN (${idList})`
  ));
  for (const row of ownedRows.rows as any[]) safeEntityIds.add(Number(row.id));
}
```

`entitySerials` path অপরিবর্তিত। দুটো path-এর resolved id একই
`safeEntityIds` (Set) → dedupe স্বয়ংক্রিয়, mixed array (কিছু owned +
কিছু non-owned + কিছু serial) দিলে শুধু owned/resolved অংশটাই enroll হয়।

## Rollout
Single-file, single-function ফিক্স (`bulk.ts`-এর `POST
/projects/bulk-enroll` handler-এর ভেতরেই)। SQL-এর behavior বদলায়নি,
শুধু `entityIds` path-এ একটা pre-filter query যোগ হয়েছে যা `entitySerials`
path আগে থেকেই করছিল। কোনো নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- ম্যানুয়ালি reasoning করে verify করা হয়েছে তিনটা case:
  - owned id → `ownedRows` query-তে ম্যাচ করে → `safeEntityIds`-এ যোগ হয় →
    enroll হয়।
  - non-owned id → `WHERE user_id = ${userId}` ম্যাচ করে না → silently
    drop হয়, কোনো error/leak ছাড়াই।
  - mixed array (owned + non-owned, বা `entityIds` + `entitySerials`
    একসাথে) → শুধু owned/resolved অংশটাই `safeEntityIds`-এ থাকে, বাকিটা
    silently বাদ পড়ে।
- `bulk.ts`-এ bracket/brace/paren balance script চালানো হয়েছে — `{}`
  131/131, `()` 207/207 — শূন্যে মেলে (C27-এর সাথে একই ফাইলে merged
  commit হিসেবে যাচাই করা, নিচে দেখুন)।
- `routes/index.ts`-এ `bulkRouter` mount হয় কিনা grep করে নিশ্চিত করা
  হয়েছে (live traffic পায়)।

## এখনো যা বাকি
C26-এর মতোই flagged বাকি consistency gap (`bulk.ts`-এর বাকি তিনটা
route, `vault-shares.ts`-এর তিনটা bulk route, `vault.ts`-এর
`bulk-tag`/`bulk-action`) — সেটাই C27, এই ফেজের ঠিক পরেই একই ফাইল টাচ
করে করা হয়েছে (দেখুন `CHANGES_ROUTE_INTEGRATION_PHASE_C27.md`)।
