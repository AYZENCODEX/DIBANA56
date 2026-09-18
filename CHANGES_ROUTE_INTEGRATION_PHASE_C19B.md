# Route Integration Roadmap — Season C, Phase C19B: exchange-api.ts (kyc_entries cluster, remaining route)

## এই ফেজের scope
C19A-তে `kyc.ts`-এর চারটা `kyc_entries` route গেটেড হয়ে গিয়েছিল, কিন্তু
একই টেবিলের পঞ্চম route — `exchange-api.ts`-এর
`PATCH /kyc-entries/:id/exchange-keys` — আলাদা ফাইলে থাকায় বাদ পড়ে
গিয়েছিল (C19A-এর "Numbering note"-এ flag করা)। এই ফেজ শুধু সেই একটা
route-এর জন্য।

## পরিবর্তন

### 1. `kyc.ts` — `kycEntryResource` / `requireKycEntryOwnership` export
আগে module-local ছিল (C19A-এর কোডে confirm করা হয়েছিল)। এখন দুটোই
`export` — নতুন কোনো resource builder বানানো হয়নি, duplicate-copy path
না নিয়ে reuse করা হয়েছে (roadmap-এর নিজের সুপারিশ অনুযায়ী)।

### 2. `exchange-api.ts` — route gated
| Route | ফাইল | আগের behavior | এখন |
|---|---|---|---|
| `PATCH /kyc-entries/:id/exchange-keys` | exchange-api.ts | silent no-op, unconditional `{success:true}` (non-owned id-এও `UPDATE ... WHERE id=X AND user_id=Y` ম্যাচ না করলেও affected-rows চেক ছাড়াই success রিটার্ন করত) | `requireKycEntryOwnership("kyc_entry.exchange_keys.update", onDeny)` গেটেড, `onDeny` **quiet no-op**, `{success:true}` — deny path-এ body অপরিবর্তিত |

`kyc.ts` থেকে `requireKycEntryOwnership` import করে বসানো হয়েছে;
handler-এর নিজস্ব encrypt/update logic অপরিবর্তিত।

## Rollout
Owner-এর success path বা non-owned/nonexistent-id-এর response body —
কোনোটাই পরিবর্তন হয়নি (আগেও unconditional `{success:true}`, এখনো তাই,
শুধু এখন সেটা explicit PDP deny-path দিয়ে আসে, handler-এ না পৌঁছেই)।
কোনো নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- `kyc.ts` `{}` 155/155, `()` 230/230; `exchange-api.ts` `{}` 72/72,
  `()` 131/131 — bracket-balance স্ক্রিপ্ট দুটো ফাইলেই শূন্যে মেলে।
- `routes/index.ts`-এ `kycRouter`/`exchangeApiRouter` দুটোই import +
  `router.use(...)` করা আছে confirm করা হয়েছে (dead code না)।
- `kyc.ts` → `exchange-api.ts` import ঠিক এক দিকেই (`kyc.ts`
  `exchange-api.ts`-কে import করে না) — circular import নেই, grep করে
  নিশ্চিত করা হয়েছে।
- ম্যানুয়ালি verify করা হয়েছে: owner → gate ALLOW → handler-এর নিজের
  encrypt/UPDATE আগের মতোই চলে। Non-owner/nonexistent id → gate deny →
  route-এর pre-existing unconditional `{success:true}` body-ই আসে, নতুন
  কোনো 404/403 না।

## Sizing note — roadmap আপডেট
C19B সম্পন্ন। C20 আগে থেকেই C19A-এর ভেতরে সম্পন্ন হয়ে গিয়েছিল (নোট
হিসেবে রাখা হয়েছিল)। বাকি roadmap: C21 (vault_entries peripheral, ৭
route, ২ ফাইল, নতুন resource builder লাগবে) → C22 (local_accounts
value-history, export + reuse, ২ route) → C23 (vault_shares, ২ route)
→ C24 (ayzen_mail dual-owner, নতুন predicate-shape লাগবে, ২ route) →
C25 (security.ts + two-factor.ts mechanical sweep, ৩ route)। মোট বাকি
~১৬টা route, ৬টা ফাইল জুড়ে, ৫টা ফেজে।
