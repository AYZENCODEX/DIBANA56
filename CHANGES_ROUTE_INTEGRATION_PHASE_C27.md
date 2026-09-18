# Route Integration Roadmap — Season C, Phase C27: বাকি bulk-family — policy-engine consistency sweep (bulk.ts + vault-shares.ts + vault.ts, ৮ route)

## এই ফেজের scope
C26-এর মতো বাগ না — `bulk.ts`-এর বাকি তিনটা (`vault/bulk`,
`local-accounts/bulk`, `wallets/bulk`), `vault-shares.ts`-এর তিনটা bulk
route (`POST`/`PATCH`/`DELETE /vault-shares/bulk`), আর `vault.ts`-এর
`PATCH /vault/bulk-tag` + `PATCH /vault/bulk-action` — এই আটটা route-ই
raw SQL/Drizzle `WHERE ... AND user_id/owner_id = X` দিয়ে আগে থেকেই
সঠিকভাবে DB-লেভেলে scoped ছিল, কিন্তু policy-engine-এর `authorizeMany()`
/ `pepDecisionObserver` audit trail-এর বাইরে থাকত — অন্য সব migrated
route-এর deny/allow decision যেভাবে centrally observable, এই আটটার
decision তা না। Reference pattern: `ayzen-mailbox.ts`-এর `PATCH
/mailbox/bulk` (Phase C13) — সেখানে `authorizeMany()` প্রথম real caller
পেয়েছিল।

কোনো SQL বদলায়নি (আগে থেকেই সঠিকভাবে filtered) — শুধু middleware
layer-এ decision logging/audit যোগ হলো, behavior অপরিবর্তিত।

## পরিবর্তন

### `bulk.ts` — তিনটা টেবিলের জন্য তিনটা আলাদা engine
`vaultEntryBulkOwnershipEngine`, `localAccountBulkOwnershipEngine`,
`walletBulkOwnershipEngine` — প্রতিটাতে `resource-ownership` rule
registered। একটা shared `auditBulkOwnership(req, engine, type, table,
ids, action)` helper — প্রতিটা candidate row-এর REAL owner fetch করে
(caller-এর `userId` দিয়ে pre-filtered না), তারপর `authorizeMany()`
কল করে শুধু audit side-effect-এর জন্য — return value intentionally
discarded, route-এর নিজের pre-existing SQL-ই ঠিক করে কোন row actually
touched হবে।

```ts
async function auditBulkOwnership(
  req: Request, engine: PolicyEngine, type: string, table: string,
  ids: number[], action: string,
): Promise<void> {
  if (!ids.length) return;
  const candidates = (await db.execute(sql.raw(
    `SELECT id, user_id FROM ${table} WHERE id IN (${ids.join(",")})`
  ))).rows as any[];
  if (!candidates.length) return;
  await authorizeMany<number>({
    req, engine, action,
    items: candidates.map((row) => ({
      key: Number(row.id),
      resource: { type, id: Number(row.id), ownerId: row.user_id != null ? Number(row.user_id) : undefined },
    })),
  });
}
```

`POST /vault/bulk`, `POST /local-accounts/bulk`, `POST /wallets/bulk`
— প্রতিটাতে নিজ নিজ engine/table/action দিয়ে handler-এর শুরুতেই একবার
call করা হলো, তারপর existing switch/SQL অপরিবর্তিত।

### `vault-shares.ts` — দুই ধরনের audit, দুটো আলাদা engine
- `PATCH`/`DELETE /vault-shares/bulk` — `vault_shares` row নিজেই টার্গেট
  (single shape, `vault_share`/`owner_id`) → `vaultShareBulkOwnershipEngine`
  + `auditVaultShareBulkOwnership(req, ids, action)`।
- `POST /vault-shares/bulk` আলাদা — এটা NEW share তৈরি করে, তাই
  audit করার মতো কোনো `vault_share` row আগে থেকে নেই; যা audit করার
  দরকার তা হলো share করা হচ্ছে যে underlying entity-টা (`local_account`
  / `vault_entry` / `kyc_entry` / `game_entry`, `item.entityType`
  অনুযায়ী) তার ownership। একটা shared `vaultShareCandidateOwnershipEngine`
  চার ধরনের entity-র জন্যই reuse হয় (`createResourceOwnershipRule()`
  শুধু `resource.ownerId` compare করে, টেবিল যেটাই হোক না কেন একই rule)।
  `auditVaultShareCreateOwnership()` প্রতিটা distinct `entityType`-এর
  জন্য একটা grouped query চালায় (per-item query না), তারপর একটাই
  `authorizeMany()` batch পুরো item সেটের উপর।

### `vault.ts` — `vaultBulkOwnershipEngine`, একটাই engine দুই route-এর জন্য
`PATCH /vault/bulk-tag` আর `PATCH /vault/bulk-action`-এর তিনটা sub-action
(tag/status/delete) — সবই `vault_entries`-এর উপর কাজ করে, তাই
`vault-entity-links.ts`-এর (C21) মতোই `vault_entry` resource type reuse
করা হলো। দুটো route-ই আগে থেকে per-id loop করে (কখনো batched UPDATE
না), তাই audit step একবার আগে পুরো id list-এর উপর চলে, তারপর existing
per-id loop অপরিবর্তিত থাকে।

## Rollout
কোনো behavior change নেই — সব ownership check আগে থেকেই raw SQL/Drizzle
`WHERE`-এ ছিল, শুধু এখন প্রতিটা bulk request-এর per-item decision
`pepDecisionObserver`-এ audit হয়। কোনো নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- তিনটা এডিট করা ফাইলেই bracket/brace/paren balance script চালানো
  হয়েছে — `bulk.ts` `{}` 131/131 `()` 207/207; `vault-shares.ts` `{}`
  322/322 `()` 531/531; `vault.ts` `{}` 565/565 `()` 1514/1514 — সব
  শূন্যে মেলে।
- `routes/index.ts`-এ তিনটা ফাইলই mount হয় কিনা grep করে নিশ্চিত করা
  হয়েছে (`vaultRouter`, `bulkRouter`, `vaultSharesRouter` — সব লাইভ
  ট্রাফিক পায়)।
- `authorizeMany()`/`allowedKeys()`/`ResourceRef`/`PolicyEngine.
  registerRule()`/`PolicyEngineOptions.onDecision`-এর actual signature
  `lib/policy/pep/authorize-many.ts`, `lib/policy/policy-engine.ts`,
  `lib/policy/resource/ownership-rule.ts`-এ গিয়ে সরাসরি মিলিয়ে দেখা
  হয়েছে — তিনটা ফাইলের নতুন কোড ঠিক matching shape ব্যবহার করছে
  (`ayzen-mailbox.ts`-এর C13 reference call-site-এর সাথে এক প্যাটার্ন)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে: audit call সবসময় route-এর
  pre-existing SQL-এর *আগে* বসেছে, কখনো ownership decision-এর উপর branch
  করে route logic বদলায়নি (pure audit side-effect, "return value
  intentionally discarded" প্রতিটা call site-এ)।

## এখনো যা বাকি
`content.ts`-এর missing-ownership gap আগের মতোই flagged — Rakib-এর
সিদ্ধান্তের অপেক্ষায়, এখন C28 হিসেবে শুরু হলো (দেখুন
`CHANGES_ROUTE_INTEGRATION_PHASE_C28.md`)। `project-dates.ts`
visibility decision (C29) এখনো pending। `vault.ts` মূল CRUD (C30) আর
peripheral sweep (C31) এখনো শুরু হয়নি।
