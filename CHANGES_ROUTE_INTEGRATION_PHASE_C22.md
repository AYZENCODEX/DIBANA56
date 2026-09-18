# Route Integration Roadmap — Season C, Phase C22: local_accounts value-history routes (value-history.ts-এর বাকি অংশ)

## এই ফেজের scope
`value-history.ts`-এর `vault_entries` অংশ C21-এ গেটেড হয়ে গিয়েছিল; এই
ফেজ সেই একই ফাইলের বাকি দুই route — `local_accounts` টেবিলের উপর —
কভার করে। C15-এ `local-accounts.ts`-এ ইতিমধ্যে `localAccountResource` +
`requireLocalAccountOwnership` তৈরি হয়ে গিয়েছিল (module-local, export
হতো না) — এই ফেজের কাজ মূলত সেটা export করে reuse করা, নতুন কিছু
বানানো না।

## C21-এর চেয়ে ছোট changeset — কেন
C21-এ `vault-entity-links.ts`-এর `vaultEntryResource` export করতে হয়েছিল
কিন্তু ওই ফাইলের নিজস্ব `requireVaultEntryOwnership()` wrapper-টা fixed-
`onDeny` (শুধু ওই ফাইলের নিজস্ব 404 body দেয়) বলে দুই caller ফাইলেই
আলাদা parameterized wrapper লিখতে হয়েছিল। এখানে উল্টো — `local-
accounts.ts`-এর `requireLocalAccountOwnership(action, onDeny)` C15
থেকেই parameterized (প্রতিটা route নিজের `onDeny` পাস করে) — তাই
`value-history.ts`-এ নতুন wrapper লেখার দরকার হয়নি, wrapper function-টাই
সরাসরি import করে reuse করা হয়েছে।

## পরিবর্তন

### `local-accounts.ts`
`localAccountResource` module-local-ই থাকল (শুধু নিজের ফাইলেই
ব্যবহৃত)। `requireLocalAccountOwnership` — এই একটাই `export` পেয়েছে।

### `value-history.ts` (২টা route)
| Route | আগের/এখনকার deny body (অপরিবর্তিত) |
|---|---|
| `GET /local-accounts/:id/value-history` | silent — non-owned id → খালি array (`200 []`) |
| `POST /local-accounts/:id/value` | `404 {error:"Account not found"}` |

## Rollout
দুটো route-এরই owner-এর success path আর non-owned/nonexistent-id-এর
deny body — কোনোটাই বদলায়নি। কোনো নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- `value-history.ts` `{}` 137/137 `()` 239/239; `local-accounts.ts` `{}`
  418/418 `()` 686/686 — bracket-balance দুই ফাইলেই শূন্যে মেলে।
- `routes/index.ts`-এ `localAccountsRouter` import + `router.use(...)`
  করা আছে confirm করা হয়েছে (`valueHistoryRouter` আগে থেকেই C21-এ
  confirm করা)।
- `local-accounts.ts` → `value-history.ts` কোনো import নেই (import
  শুধু এক দিকে — `value-history.ts` → `local-accounts.ts`) — circular
  import নেই, grep করে নিশ্চিত।
- `value-history.ts`-এর পাঁচটা `:id`-route-ই (C21-এর তিনটা vault route
  + C22-এর এই দুটো) এখন গেটেড, `GET /value-history/pnl` (কোনো `:id`
  নেই, aggregate route) অপরিবর্তিত — grep করে confirm করা হয়েছে।
- ম্যানুয়ালি verify করা হয়েছে: owner → gate ALLOW → handler-এর নিজস্ব
  query আগের মতোই চলে। Non-owner/nonexistent id → gate deny → route-এর
  pre-existing exact body।

## Sizing note — roadmap আপডেট
C22 সম্পন্ন। `value-history.ts` এখন পুরোপুরি audited (C21 + C22 মিলিয়ে
৫টা route)। বাকি roadmap: C23 (vault_shares, ২ route) → C24 (ayzen_mail
dual-owner, নতুন predicate-shape লাগবে, ২ route) → C25 (security.ts +
two-factor.ts mechanical sweep, ৩ route)। মোট বাকি ~৭টা route, ৩টা
ফাইল জুড়ে, ৩টা ফেজে।
