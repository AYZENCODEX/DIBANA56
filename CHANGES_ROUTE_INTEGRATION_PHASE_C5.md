# Route Integration Roadmap — Season C, Phase C5: Mechanical Sweep (batch 5, marketplace listing-cancel routes)

## যা আগে থেকেই ছিল
Phase C4 পর্যন্ত Season C-এর জন্য চিহ্নিত দুটো বড় ফাইলই (`finance-invoices.ts`,
`teams.ts`) হয়ে গেছে। এই ফেজ পুরো `routes/` ডিরেক্টরিতে আবার
`userId !== `/`!== .*userId` grep চালিয়ে বাকি candidate খুঁজল:

```
routes/events.ts             — আগেই (Phase C1) false positive হিসেবে বাদ
routes/finance-invoices.ts   — Phase C3-এ হয়ে গেছে
routes/marketplace-azn.ts    — নতুন
routes/marketplace-game.ts   — নতুন
routes/marketplace-nft.ts    — নতুন hit, কিন্তু false positive (নিচে দেখুন)
routes/marketplace-usdt.ts   — নতুন
routes/marketplace-vault.ts  — নতুন
routes/passkey.ts            — Phase C2-এ হয়ে গেছে
routes/teams.ts              — Phase C4-এ হয়ে গেছে
routes/vault-reauth.ts       — Phase C2-এ হয়ে গেছে
```

চারটা নতুন `marketplace-*.ts` ফাইলে হুবহু **একই shape**, একই বাক্য পর্যন্ত
মিলে যায়:

```ts
if (listing.seller_id !== userId && req.user!.role !== "admin") {
  res.status(403).json({ error: "Forbidden" }); return;
}
```

— প্রতিটাই তাদের নিজস্ব `DELETE /marketplace/<type>/listings/:id` (listing
cancel) route-এ, ঠিক Phase C1-এর `support.ts`/`tasks.ts`-এর "owner, OR
admin" shape-এর same pattern। `marketplace-nft.ts`-এর hit
(`liked.filter(x => x !== userId)`) একটা like-toggle-এর array filter —
কোনো authorization gate না, Phase C1-এর `events.ts`/Phase C2-এর
login/verify exclusion-এর মতোই false positive, untouched রাখা হলো।

## এই ফাইলগুলোর নিজস্ব বৈশিষ্ট্য
এই চারটা ফাইলে (`marketplace-azn.ts`/`marketplace-game.ts`/
`marketplace-usdt.ts`/`marketplace-vault.ts`) কোনো Drizzle table object
নেই — সব raw `pool.query()` (node-postgres pool, `@workspace/db`-র
`pool` export)। তাই `finance.ts`/`teams.ts`-এর মতো `ResourceRefBuilder` +
router-level `requireOwnership()` লাগেনি — প্রতিটা route হ্যান্ডলার
নিজেই আগে থেকে listing row fetch করে (404 check-এর জন্য, আর `azn`/`usdt`-এ
sell-listing হলে wallet-refund লজিকের জন্যও লাগে), তাই ownership
check-টা সেই already-fetched row-এর `seller_id` reuse করে ঠিক জায়গায়
বসানো হলো — Phase C3/C4-এর "already-fetched field, direct replacement"
shape।

## যেটা যোগ করা হলো (Phase C5)

Phase C1-এর `ticketOwnerOrAdminEngine`-এর মতোই, প্রতিটা ফাইল নিজের
module-load-time engine বানাল — `createResourceOwnershipRule()` OR
`createRoleOverrideRule(["admin"])`, `pepDecisionObserver` (Phase A3)-এর
সাথে wired। চারটা ফাইল, চারটা আলাদা engine (finance-invoices.ts/teams.ts-এর
"এক ফাইলে একটাই shared engine" পোস্টার অনুসরণ করে, কিন্তু এখানে চারটা
আলাদা ফাইল বলে চারটা আলাদা instance)।

| ফাইল | Route | নতুন `action` | Response gate (অপরিবর্তিত) |
|---|---|---|---|
| `marketplace-azn.ts` | `DELETE /marketplace/azn/listings/:id` | `marketplace.azn_listing.cancel` | `403 { error: "Forbidden" }` |
| `marketplace-game.ts` | `DELETE /marketplace/game/listings/:id` | `marketplace.game_listing.cancel` | `403 { error: "Forbidden" }` |
| `marketplace-usdt.ts` | `DELETE /marketplace/usdt/listings/:id` | `marketplace.usdt_listing.cancel` | `403 { error: "Forbidden" }` |
| `marketplace-vault.ts` | `DELETE /marketplace/vault/listings/:id` | `marketplace.vault_listing.cancel` | `403 { error: "Forbidden" }` |

চারটাতেই ownership check-এর ঠিক আগে যা চলে তা অপরিবর্তিত: `SELECT *
... WHERE id=$1 AND status='active'` → `!r.rows[0]` হলে `404 { error:
"Not found" }` (একটা DIFFERENT প্রশ্ন — existence — hand-rolled-ই থাকল,
Phase C1-এর নিজস্ব নীতি অনুযায়ী)। তারপরই ownership decision, এখন PDP-র
মধ্য দিয়ে।

## Resource lookup — client-supplied কিছু trust করা হয়নি
`listing.seller_id` — handler-এর নিজের `SELECT ... WHERE id=$1
AND status='active'`-এর result থেকে, প্যারামিটারাইজড query দিয়ে DB থেকে
পড়া (client কোনো ownerId সরবরাহ করেনি এখানে) — কোনো নতুন query যোগ হয়নি,
existing lookup-ই reuse হয়েছে। এই routes-গুলোয় "listing নেই" কেসটা আগে
থেকেই আলাদা 404 দেয় (ownership check-এর আগেই), তাই এই চারটায়
`FINANCE_OWNER_SENTINEL_NONE`-এর মতো কোনো sentinel দরকার হয়নি — ownership
rule কখনো একটা nonexistent listing-এর জন্য call-ই হয় না।

## এই ফেজে যা সরানো হয়নি
- প্রতিটা route-এর existing `UPDATE ... SET status='cancelled'` আর (sell
  listing হলে) wallet-refund `UPDATE marketplace_wallets` — অপরিবর্তিত।
- "Cannot buy your own listing" (`listing.seller_id === buyerId`) —
  প্রতিটা ফাইলের buy/purchase route-এ — এটা `===`, `!==` grep-এ ধরাই
  পড়েনি, আর আসলে এটা একটা ব্যবসায়িক নিয়ম (self-trading প্রতিরোধ), কোনো
  protected resource-এর উপর authorization gate না। Untouched।
- `marketplace-nft.ts`-এর like/unlike toggle — false positive, ব্যাখ্যা
  উপরে।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral —
প্রতিটা route-এর response অপরিবর্তিত (same status code, same body, same
owner-or-admin logic, একই order-এ same side-effects), শুধু ownership
decision-টুকু এখন PDP দিয়ে যায়, audit/telemetry-তে ধরা পড়ে।

## যা টেস্ট করা হয়েছে
- চারটা এডিট করা ফাইলেই bracket/brace/paren balance স্ক্রিপ্ট দিয়ে চেক করা
  হয়েছে — সবগুলোয় `{}`/`()`/`[]` সমান সংখ্যায় মেলে
  (`marketplace-azn.ts`: 79/79, 184/184, 35/35; `marketplace-game.ts`:
  87/87, 176/176, 31/31; `marketplace-usdt.ts`: 79/79, 175/175, 34/34;
  `marketplace-vault.ts`: 115/115, 226/226, 45/45)।
- `tsc --noEmit --skipLibCheck --ignoreConfig` চারটা ফাইলের উপর একসাথে
  চালানো হয়েছে — বাকি থাকা প্রতিটা error module-resolution-জনিত
  (`express`/`@workspace/db`, node_modules install না থাকায়) অথবা
  pre-existing implicit-any (`req`/`res`/`row`, `@types/node`/
  `@types/express` ছাড়া) — ঠিক আগের ফেজগুলোর মতোই বেসলাইন noise। নতুন
  যোগ করা কোনো identifier (`authorize`, `PolicyEngine`,
  `createResourceOwnershipRule`, `createRoleOverrideRule`,
  `pepDecisionObserver`, `aznListingOwnerOrAdminEngine`,
  `gameListingOwnerOrAdminEngine`, `usdtListingOwnerOrAdminEngine`,
  `vaultListingOwnerOrAdminEngine`) নিয়ে কোনো error ওঠেনি।
- প্রতিটা import সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep
  করে যাচাই করা হয়েছে (`authorize` → `lib/policy/pep/authorize.ts`,
  `PolicyEngine` → `lib/policy/policy-engine.ts`,
  `createResourceOwnershipRule` → `lib/policy/resource/ownership-rule.ts`,
  `createRoleOverrideRule` → `lib/policy/resource/role-override-rule.ts`,
  `pepDecisionObserver` → `middlewares/auth.ts`)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: seller নিজে →
  ownership rule ALLOW → আগের success path। admin (non-seller) →
  role-override rule ALLOW → আগের success path। অন্য কেউ → দুটো rule-ই
  abstain/deny → default-deny (`NO_MATCHING_POLICY`) → আগের একই
  `403 { error: "Forbidden" }`। existence (404) check এখনো ownership-এর
  আগে, hand-rolled, অপরিবর্তিত।
- প্রতিটা ফাইলে ownership check সরানোর পর হ্যান্ডলারের নিজস্ব `const userId
  = req.user!.userId;` লাইনটা technically dead হয়ে গেছে (আর কোথাও ব্যবহার
  হয় না ওই হ্যান্ডলারে) — ইচ্ছাকৃতভাবে **সরানো হয়নি**, যেহেতু এই ফেজের
  scope শুধু ownership decision routing, অতিরিক্ত cleanup না (আর
  `noUnusedLocals` এই repo-র tsconfig-এ enabled না, তাই build-এ কোনো
  প্রভাব নেই)।

## এখনো যা বাকি
পুরো `routes/` ডিরেক্টরিতে (১৩৮টা route) `userId !== `/`!== .*userId`
grep-এর সব hit এখন হয় migrate করা হয়েছে, নয়তো false-positive হিসেবে
চিহ্নিত ও untouched। এই grep pattern-এর বাইরে থাকা ownership shape-গুলো
(যেমন `finance.ts`-এর মতো SQL-এ combined `where(and(eq(id), eq(userId)))`,
`!==` শেপ না) এই mechanical sweep-এর pattern-based audit ধরেনি — একটা
ভবিষ্যৎ phase পুরো `routes/`-এ manual audit চালিয়ে সেগুলো (যদি থাকে) খুঁজে
বের করতে পারে। এছাড়া `teams.ts`-এর `/admin/teams` platform-wide role
check-গুলো (Phase C4-এ চিহ্নিত, out of scope রাখা) আর per-team
"leader" role-কে সঠিকভাবে PDP-তে মডেল করার জন্য একটা নতুন rule type —
দুটোই এখনো ভবিষ্যতের আলাদা আলোচনার বিষয়।
