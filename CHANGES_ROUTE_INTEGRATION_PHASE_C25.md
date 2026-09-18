# Route Integration Roadmap — Season C, Phase C25: mechanical batch — single-owner cleanup (security.ts + two-factor.ts)

## এই ফেজের scope
এই সিরিজের শেষ ফেজ। দুই ফাইলে তিনটা plain single-owner route,
`earn-links.ts`/`game-entries.ts` (C19A-তে আগেই হয়ে যাওয়া) বাদ দিয়ে
draft-এর C25-এ যা বেঁচে ছিল:

| Route | ফাইল | আগের behavior |
|---|---|---|
| `DELETE /security/magic-codes/:id` | security.ts | silent no-op, unconditional `{ok:true}` |
| `PATCH /two-factor/other/:id` | two-factor.ts | `404 {error:"Not found"}` |
| `DELETE /two-factor/other/:id` | two-factor.ts | silent no-op, unconditional `{ok:true}` |

## পরিবর্তন

### `security.ts` — `user_magic_codes` (owner=`user_id`)
এই ফাইল বাকি সিরিজের মতো Drizzle `db.execute(sql...)` না, বরং
`pool.query()` (node-postgres) সরাসরি ব্যবহার করে — নতুন
`magicCodeResource` builder-টা তাই এই ফাইলের নিজস্ব convention-ই
অনুসরণ করেছে (`pool.query`), সিরিজের বাকি ফাইলগুলোর Drizzle স্টাইল
না — একই "ফাইলের নিজস্ব ধরন মেলানো" নীতি যা kyc.ts/local-accounts.ts
আগে উল্টো দিকে (raw-SQL-heavy ফাইলে parameterized `sql` template)
প্রয়োগ করেছিল।

`DELETE /security/magic-codes/:id`-এ middleware বসানো হয়েছে, deny
body অপরিবর্তিত — এই ফাইলের নিজস্ব success-body-এর key `ok` (অন্য
অনেক ফাইলে `success`), সেটাই deny-তেও রাখা হয়েছে (`{ok:true}`, না
`{success:true}`)।

### `two-factor.ts` — `other_two_factor_codes` (owner=`user_id`)
`otherTwoFactorResource` নতুন builder, parameterized `sql`
tagged-template-এ লেখা (এই ফাইলের বাকি সব query `sql.raw`, কিন্তু এই
সিরিজের প্রতিটা নতুন resource-lookup-ই parameterized স্টাইলে লেখা
হয়েছে, kyc.ts থেকে শুরু করে)।

`PATCH`/`DELETE /two-factor/other/:id` দুটোতেই middleware বসানো
হয়েছে — দুটোর deny body আলাদা (PATCH-এর `404 "Not found"`, DELETE-এর
`{ok:true}`), দুটোই আগের মতোই preserve করা হয়েছে।

## Rollout
তিনটা route-এরই owner-এর success path আর deny body — কোনোটাই
বদলায়নি। কোনো নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- `security.ts` `{}` 120/120 `()` 213/213; `two-factor.ts` `{}` 68/68
  `()` 117/117 — bracket-balance দুই ফাইলেই শূন্যে মেলে।
- `routes/index.ts`-এ `securityRouter`/`twoFactorRouter` দুটোই import +
  `router.use(...)` confirm করা হয়েছে।
- grep করে নিশ্চিত করা হয়েছে ঠিক তিনটা target route-ই নতুন middleware
  পেয়েছে; `security.ts`-এর বাকি সব route (`backup-codes/*`,
  `magic-codes/login`, `2fa/*`, `recovery-email`) আর `two-factor.ts`-এর
  `all`/`other` (GET/POST, কোনো `:id` নেই) অপরিবর্তিত আছে।
- ম্যানুয়ালি verify করা হয়েছে: owner → gate ALLOW → handler-এর নিজস্ব
  query আগের মতোই চলে। Non-owner/nonexistent id → gate deny → প্রতিটা
  route তার নিজস্ব exact pre-existing body দেয়।

## এই সিরিজ সম্পূর্ণ — সারসংক্ষেপ
C25 দিয়ে "Route Integration Roadmap — Season C, Phase C19 থেকে সামনে"
(draft roadmap, `ROADMAP_ROUTE_INTEGRATION_PHASE_C19_PLUS.md`) পুরোপুরি
সম্পন্ন হলো। এই সিরিজে মোট migrate হওয়া ফাইল/route (C19A থেকে C25):

| ফেজ | ফাইল | route সংখ্যা | নোট |
|---|---|---|---|
| C19A | kyc.ts, kyc-data-entities.ts, game-entries.ts, earn-links.ts, nft-subscriptions.ts | ১৩ | এই সিরিজ শুরুর আগেই সম্পন্ন ছিল |
| C19B | exchange-api.ts | ১ | kyc.ts-এর resource export করে reuse |
| C20 | kyc-data-entities.ts | — | C19A-এর ভেতরেই আগে সম্পন্ন, আলাদা কাজ লাগেনি |
| C21 | entities.ts, value-history.ts (vault অংশ) | ৭ | vault-entity-links.ts-এর আগে-থেকে-থাকা builder export করে reuse |
| C22 | value-history.ts (local-accounts অংশ) | ২ | local-accounts.ts-এর আগে-থেকে-থাকা wrapper সরাসরি reuse |
| C23 | vault-shares.ts | ২ | নতুন builder, plain single-owner |
| C24 | ayzen-mail.ts | ২ | এই সিরিজের একমাত্র dual-role owner shape |
| C25 | security.ts, two-factor.ts | ৩ | মেকানিক্যাল ক্লোজআউট |

**Still flagged, not code-phased** (draft roadmap-এর নিজস্ব "যা code
phase-এ যাচ্ছে না" সেকশন থেকে, এখনো unresolved):
- `content.ts` — ownership gap, owner-এর সিদ্ধান্তের অপেক্ষায়।
- `vault.ts`-এর মূল CRUD — Season B, Phase B2-এর জন্য সংরক্ষিত;
  C21-এর `vaultEntryResource` (vault-entity-links.ts-এ export করা) সেই
  ফেজে reuse করা যাবে।
- `project-dates.ts`-এর `GET /projects/:id/dates` — কোনো ownership
  check-ই নেই, কিন্তু project visibility model-এর design decision
  দরকার (কোডে উত্তর নেই), তাই এই সিরিজের বাইরে।
