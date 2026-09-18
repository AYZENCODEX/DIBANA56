# Route Integration Roadmap — Season D, Phase D4: long-tail triage (১৯৯ route, ৭০ ফাইল) — ১টা বাগ ফিক্স

## Scope
D1 (`teams.ts`), D2 (`finance.ts`+`finance-invoices.ts`), D3 (`projects.ts`+
`tasks.ts`) মিলিয়ে বেসলাইনের ১৪১টা route triage হয়ে গিয়েছিল। এই ফেজ বাকি
পুরোটা কভার করে — `ownership-gate-baseline.json`-এর অবশিষ্ট **১৯৯টা**
route, **৭০টা** ফাইল জুড়ে। Roadmap-এর নিজস্ব sizing note এইটাকে ~৮০ route,
~৪০ ফাইল অনুমান করেছিল (marketplace satellite + vault-attachments/snapshot/
backup-cloud + বাকি ছোট ফাইলগুলো) — বাস্তব সংখ্যা D2/D3-এর মতোই বেশি হলো,
কারণ heuristic অনুমানটা শুধু "auth-only, no PDP" ২০৬-বাকেটের হিসাবে করা
হয়েছিল, বেসলাইনের role-gated (১১০) + public/token (২৪) অংশ — যেগুলো C35-এ
আগেই "safe, শুধু script-recognized middleware নাম না" হিসেবে classify
হয়েছিল কিন্তু এখনো বেসলাইনে grandfathered আছে — সেগুলোও এই দুই ফাইল-সেটের
বাইরে পড়ায় একসাথে চলে এসেছে।

প্রতিটা route নিজে পড়ে (handler body extract করে) classify করা হয়েছে,
D1-D3-এর same methodology: (ক) role/permission middleware বা inline role
check, (খ) membership-shape, (গ) raw-SQL/Drizzle owner-scoped বা ইতিমধ্যে
inline `authorize()`/`requireOwnership()`-রুটেড (D2-এর "already PDP" bucket-
এর মতো), (ঘ) public/token-possession by design, (ঙ) login-gate-only —
`requireAuth` আছে কিন্তু ownership প্রযোজ্য না (D1-D4-এর precedent, presence/
streak-এর মতো), (চ) সত্যিই কোনো check নেই — বাগ।

## ফলাফল সংক্ষেপে

| Bucket | সংখ্যা |
|---|---|
| (ক) Role/permission-gated (`requireAdmin`/`requireDev`/`requireRoles(...)`/`requirePolicy`/inline `role !== "admin"` — script-এর `PEP_WIRING_NAMES`-এর বাইরের নাম, বা B3-তে আগে থেকেই dogfooding-reviewed admin console) | ১০৯ |
| (গ) Raw-SQL/Drizzle owner-scoped, বা ইতিমধ্যে inline `authorize()`/`requireOwnership()`/`assertEntityOwnership()`-রুটেড (`userId`/`ownerId` দিয়ে scoped, শুধু router-middleware আর্গুমেন্ট আকারে না) | ৫৮ |
| (ঘ) Public/token-possession by design (receipt-by-token, marketplace public listing/rating/review reads, OIDC RFC7592 registration-access-token, OAuth callback state-token, username-availability check ইত্যাদি) | ২৫ |
| (ঙ) Login-gate-only — ownership প্রযোজ্য না (spot market ডেটা, presence, streak — নিচে দেখুন) | ৬ |
| (চ) **সত্যিই কোনো check নেই — বাগ, সাথে সাথে ফিক্স হয়েছে** | ১ |
| **মোট** | **১৯৯** |

কোনো bucket (খ) membership-shape এই ব্যাচে পাওয়া যায়নি — সেটা মূলত
`teams.ts`-নির্দিষ্ট শেপ (D1/D6), বাকি ফাইলগুলোতে দেখা যায়নি।

---

## বাগ: `plugins.ts` — `/admin/plugins` দুটো route-এই কোনো auth ছিল না

`GET /admin/plugins` আর `PATCH /admin/plugins/:slug` — দুটোই `/admin/...`
prefix থাকা সত্ত্বেও কোনো middleware ছাড়া রেজিস্টার করা ছিল (না `requireAuth`,
না `requireAdmin`)। মানে যেকোনো unauthenticated caller:
- পুরো plugin catalog দেখতে পারত (GET), আর
- **যেকোনো plugin-এর `enabled`/`config` state বদলে দিতে পারত** (PATCH) —
  `authenticator` (2FA) বা `smtp`/email plugin platform-wide off করে দেওয়াও
  এর মধ্যে পড়ে।

`PATCH /admin/plugins/:slug`-এর `:slug` param C33-এর lint-এ ধরা পড়েছিল
(`:id`-shaped), কিন্তু `GET /admin/plugins`-এর কোনো param নেই বলে সেটা
script-এর scope-এর বাইরেই ছিল — C34-এর body-id বাগের মতো, "script-এর নিজস্ব
shape-filter-এর বাইরে পড়া গ্যাপ" ক্লাসের আরেকটা উদাহরণ, এবারে file-by-file
triage করতে গিয়ে চোখে পড়ল।

**ফিক্স**: দুটো route-এই `requireAdmin` যোগ করা হয়েছে (`../middlewares/auth`
থেকে) — এই কোডবেসের বাকি সব `/admin/...` route যে pattern অনুসরণ করে
(`ad-tasks.ts`, `reward-links.ts`, ইত্যাদি) ঠিক সেটাই। এটা per-user ownership
resource না, platform-wide config — তাই `requireOwnership()` না,
role-gating (`requireAdmin`) সঠিক ফিক্স, C28-এর (`content.ts`) সিদ্ধান্তের
মতোই ("owner column নেই, role-based")। C26/C34-এর precedent অনুযায়ী পাওয়ার
সাথে সাথে ফিক্স হয়ে গেছে, D5-এর অপেক্ষায় রাখা হয়নি (D5 শুধু owner-decision
দরকার এমন flagged item-এর জন্য, এটা একটা স্পষ্ট bug, decision-গেটেড না)।

---

## ফ্ল্যাগড — owner decision দরকার (D5-এ resolved)

D1-D4-এর triage-এ মোট ৪টা route flag হয়েছিল ambiguous হিসেবে (bucket (চ) না,
কিন্তু কোনো established bucket-এও পরিষ্কার fit করে না) — D1-এর ২টা
(`teams.ts` mission create/update) আর এই ফেজের ২টা:

- **`GET /projects/:id/presence`** (`events.ts`) — কোনো auth-ই ছিল না;
  anonymous caller `projectId` enumerate করে raw presence userId list পড়তে
  পারত। Ownership-এর প্রশ্ন না ("কার presence" প্রশ্নটাই প্রযোজ্য না — এটা
  read-only broadcast state), কিন্তু login-gate থাকা উচিত কিনা সেটা owner-
  decision হিসেবে flag করা হলো।
- **`GET /tools/streak/:userId`** — কোনো auth ছিল না; anonymous caller
  যেকোনো `userId`-র streak/last-active data পড়তে পারত। একইভাবে, ownership
  na, কিন্তু login-gate কিনা owner-decision।

দুটোই D5-এ resolve হয়েছে: উভয় route-এ `requireAuth`-স্টাইল login-gate যোগ
(ownership না, শুধু authenticated হতে হবে) — দেখুন
`CHANGES_ROUTE_INTEGRATION_PHASE_D5.md`।

---

## Bucket-ভিত্তিক উল্লেখযোগ্য উদাহরণ

**(ক) বড় cluster-গুলো**: `admin-rbac-console.ts` (৮, B3-reviewed RBAC
console), `admin-policy-console.ts` (৬, B3-reviewed PDP console,
`requireDev`+`requirePolicy`), `admin-resource-console.ts` (৪, B3),
`admin-oidc-clients.ts` (৫) + `admin-oidc-rollout.ts` (২) — `requireDev`
uniformly, ফাইল-header-এই লেখা "`requireDev` on every route below",
`mcp-agents.ts` (৭), `project-templates.ts` (৬, `requireRoles("admin",
"moderator", "dev")`), `users.ts` (৬, `requireAdmin`)।

**(গ) উল্লেখযোগ্য শেপ**: `ayzen-mailbox.ts`-এর ৫টা (email/threadId param,
কিন্তু প্রতিটা query `WHERE userId = ...` দিয়ে scoped — C10-C13-এর একই
resource, নতুন যোগ হওয়া sub-route যেগুলো ওই phase-গুলোর পরে যোগ হয়েছে)।
`vault-attachments.ts`-এর ৫টা `assertEntityOwnership(entityId, userId)`
inline helper কল করে — নামে `requireOwnership()`-এর মতো না হলেও কার্যত একই
জিনিস, script-এর `PEP_WIRING_NAMES` allowlist-এ নেই বলে unwired দেখাচ্ছে।
`marketplace-azn/game/usdt/vault.ts`-এর DELETE route-গুলো ইতিমধ্যে C5-এর
`authorize()`/marketplace-listing-ownership-resource ব্যবহার করে (D2-এর
finance.ts-এ পাওয়া "already inline-PDP" bucket-এর মতোই)। `marketplace.ts`/
`marketplace-bundles.ts`/`marketplace-offers.ts`/`marketplace-wallet.ts`-এর
buy/deposit/withdraw/favorite/report route-গুলো "self-scoped write" —
`:id`/`:type` param অন্য কারো row না, caller নিজের `userId`-তেই write করে
(marketplace listing/bundle কেনা মানে buyer নিজের নামে নতুন order বানানো,
existing seller-এর row মোটেও mutate হয় না)।

**(ঘ) Public/token**: `local-accounts.ts`/`vault.ts`-এর receipt-by-token
route-গুলোতে আগে থেকেই কোড-কমেন্টে "public, no auth" লেখা আছে।
`oidc-register.ts` bearer-token (RFC 7592 registration access token) দিয়ে
নিজস্ব ভাবে gate করা — `requireAuth` middleware না ব্যবহার করেই সঠিকভাবে
gated, তাই script miss করেছে but সেটা bug না। `marketplace-analytics.ts`/
`marketplace-discovery.ts`/`marketplace-reviews.ts`/`marketplace-bundles.ts`
(GET)/`marketplace.ts` (GET)-এর সবগুলো marketplace public browsing data
(view count, rating, review, similar-items, listing detail) — C5/C16-C18-এ
marketplace listing read ইতিমধ্যে intentionally public হিসেবে established।

**(ঙ) Login-gate-only**: `marketplace-spot.ts`-এর candles/orderbook/trades
(pair-keyed market data, কোনো user-specific field না), `project-dates.ts`
GET (C29-এর আগের সিদ্ধান্তেরই আরেকটা route — "intentionally public [to any
logged-in user]"), `vault-shares.ts`-এর `fields/:entityType` (schema
metadata, কোনো entity data না)।

---

## Audit methodology-এর নোট (transparency)

D1-D3-এর মতো প্রতিটা route হাতে পড়ে classify করা হয়েছে — এই ফেজে volume
বেশি (১৯৯) বলে প্রথমে একটা script দিয়ে handler body extract + pattern-match
(role middleware নাম, `userId`/`ownerId` inline compare, raw-SQL `WHERE
... AND user_id/owner_id`, membership table lookup) করে প্রাথমিক bucket
বসানো হয়েছে, তারপর প্রতিটা "কোনো pattern মেলেনি" entry (৭১টা — বেশিরভাগ
already-owner-scoped-via-helper-function বা public-by-design যেগুলো
regex-এ ধরা পড়েনি) হাতে পড়ে confirm করা হয়েছে — কোনো route bucket-এ
heuristic-এর ভিত্তিতে বসানো হয়নি, শুধু initial triage-এর গতি বাড়ানোর জন্য
ব্যবহার হয়েছে (C33/roadmap-এর নিজস্ব "candidate-level, hand-confirm লাগবে"
নীতির মতোই)।
