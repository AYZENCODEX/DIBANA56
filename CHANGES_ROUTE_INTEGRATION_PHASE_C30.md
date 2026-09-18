# Route Integration Roadmap — Season C, Phase C30: `vault.ts` মূল CRUD (Phase B2) — policy-engine-এর ভেতরে আনা

## এই ফেজের scope
Season B, Phase B2-এর জন্য reserved ছিল, C19-C29 সিরিজে বারবার "এখনো
শুরু হয়নি" হিসেবে flagged থেকেছে — `vault.ts`-এর চারটা core route:
`POST /vault`, `GET /vault/:id`, `PATCH /vault/:id`, `DELETE /vault/:id`।

## যা পাওয়া গেছে
তিনটা `:id` route-ই (GET/PATCH/DELETE) আগে থেকেই সঠিকভাবে scoped —
`selectVaultOne(id, userId)` আর `db.update()`/soft-delete-এর
`db.delete()`-সমতুল্য উভয়েই `and(eq(vaultEntriesTable.id, id),
eq(vaultEntriesTable.userId, userId))` দিয়ে ফিল্টার করে। এই সিরিজের
বাকি সব ফেজের মতোই — bug না, কিন্তু ownership check policy-engine-এর
`authorizeMany()`/`requireOwnership()` PDP-এর বাইরে ছিল, তাই decision
centrally audit হতো না।

`POST /vault` scope-এর বাইরে রাখা হয়েছে: এটা create, কোনো `:id` নেই,
তৈরির আগে ownership check করার মতো কোনো existing row নেই — ঠিক যেভাবে
`POST /vault/bulk`/`POST /wallets/bulk` (C27) আর এই সিরিজের বাকি সব
body-only create route বাদ পড়েছে।

## পরিবর্তন
`vault.ts`-এ নতুন কোনো resource builder বানানো হয়নি — C21-এ
`vault-entity-links.ts`-এ export হওয়া `vaultEntryResource` (একই
`vault_entries.user_id` shape, `entities.ts`/`value-history.ts` আগে
থেকেই reuse করে) সরাসরি import করা হয়েছে। `entities.ts`-এর thin
local-wrapper pattern অনুসরণ করে (vault-entity-links.ts-এর নিজের
fixed-404 helper না, কারণ সেটার `onDeny` hardcoded), একটা
`requireVaultEntryOwnership(action, onDeny)` wrapper যোগ হলো যাতে
প্রতিটা route তার own pre-existing deny body ঠিক রাখতে পারে:

- `GET /vault/:id` → `requireVaultEntryOwnership("vault_entry.read", ...)`
  — deny body অপরিবর্তিত: `{ error: "Vault entry not found" }`
- `PATCH /vault/:id` → `requireVaultEntryOwnership("vault_entry.update", ...)`
  — deny body অপরিবর্তিত: `{ error: "Vault entry not found" }`
- `DELETE /vault/:id` → `requireVaultEntryOwnership("vault_entry.delete", ...)`
  — deny body অপরিবর্তিত: `{ message: "Vault entry not found" }` (GET/PATCH-এর
  থেকে ভিন্ন key — এই ফেজ সেই pre-existing পার্থক্যটাও touch করেনি)।

তিনটা route-এর handler body-ই অপরিবর্তিত — `selectVaultOne()`/
`db.update()`-এর নিজের `userId` filter এখনও থাকছে, সেটাই আসলে কোন row
touch হবে ঠিক করে (defense-in-depth, C27-এর bulk routes-এর মতোই
"pre-existing SQL still decides, PDP layer শুধু decision audit করে"
নীতি — তবে এখানে single-row route হওয়ায় `requireOwnership()`
middleware নিজেই deny করে দেয়, handler-এ pৌঁছায়ই না, `authorizeMany()`
audit-only pattern থেকে ভিন্ন)।

## Rollout
Behavior-এর দিক থেকে কার্যত কোনো পরিবর্তন নেই — যে request আগে
`selectVaultOne`-এর `WHERE`-এ ম্যাচ না করে 404 পেত, সেটা এখন middleware
layer-এই deny হয়ে একই 404 body পায়। নতুন যা যোগ হলো: decision এখন
`pepDecisionObserver`-এর মাধ্যমে centrally audit হয়। কোনো নতুন env var,
migration লাগেনি। নতুন import (`requireOwnership`, `vaultEntryResource`)
ছাড়া কোনো dependency যোগ হয়নি — কোনো circular import ঝুঁকি নেই
(`vault-entity-links.ts` `vault.ts`-কে import করে না)।

## যা টেস্ট করা হয়েছে
- `vault.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  `{}` 577/577, `()` 1539/1539 — শূন্যে মেলে।
- `requireOwnership()`-এর actual signature
  (`lib/policy/pep/middleware.ts`) সরাসরি মিলিয়ে দেখা হয়েছে —
  `entities.ts`-এর existing call-site-এর সাথে exact matching shape।
- `vault-entity-links.ts`-এর import list পড়ে নিশ্চিত করা হয়েছে সেটা
  `vault.ts` import করে না — circular import নেই।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে তিনটা case প্রতিটা route-এ:
  owner → allow, handler pৌঁছায়, pre-existing SQL match করে normal
  response; non-owner (existing row কিন্তু ভিন্ন `user_id`) →
  `vaultEntryResource` real owner ফেরত দেয়, ownership rule deny করে,
  route-এর own `onDeny` চলে, handler body-তে কখনো ঢোকে না; nonexistent
  id → `vaultEntryResource`-এর sentinel `ownerId: -1` ফেরত দেয়, একইভাবে
  deny হয় — তিনটাই route-ভেদে তার own pre-existing deny body ফেরত দেয়।
- `routes/index.ts`-এ `vaultRouter` mount হয় কিনা আগে থেকেই confirmed
  (আগের ফেজগুলোয়) — এই ফেজ সেই wiring টাচ করেনি।

## এখনো যা বাকি
`vault.ts`-এর peripheral sweep (C31 — gas, seed, drive-wallet,
validate-key, refresh-wallet-worth, field, field-history, restore,
receipt create/delete, activity, মোট ~১১টা route) এখন শুরু করা যায়
(dependency C30 satisfied)। C32 (automated regression suite), C33
(pattern doc + CI lint guard), C34 (delta re-audit), C35 (season
close-out) — এখনো শুরু হয়নি।
