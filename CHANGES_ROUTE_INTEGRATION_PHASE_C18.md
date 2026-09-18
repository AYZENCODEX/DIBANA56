# Route Integration Roadmap — Season C, Phase C18: Mechanical Sweep (batch 18, marketplace-alerts.ts + marketplace-spot.ts; audit closes out azn/game/usdt/vault, mcp-agents.ts, ai-agent.ts, users.ts)

## এই ফেজের আসল কাজ: audit প্রথমে, code পরে

C17-এর "এখনো যা বাকি" তালিকায় দশটার বেশি ফাইল/module flag করা ছিল। এই
ফেজে প্রতিটা আসলে খুলে পড়া হলো কোড লেখার আগে — ফলাফল: বেশিরভাগই আসলে
migrate করার কিছু নেই, শুধু দুটো ফাইলে সত্যিকার gate বসানোর দরকার হলো।

### যা migrate করার দরকারই নেই তা confirm করা হলো

- **`marketplace-azn.ts`, `marketplace-game.ts`, `marketplace-usdt.ts`,
  `marketplace-vault.ts`** — এই চারটাই C17-এর "এখনো বাকি" তালিকায় ছিল,
  কিন্তু কোড খুলে দেখা গেল এগুলোর `DELETE /listings/:id` route
  **ইতিমধ্যে Phase C5-এ** PDP-routed "owner OR admin" pattern দিয়ে migrate
  হয়ে গেছে (`aznListingOwnerOrAdminEngine` ইত্যাদি, `authorize()` সরাসরি
  কল করে)। এই চারটা ফাইলের বাকি route-গুলো (create/browse/buy/stats)
  কোনোটাই single-resource ownership gate না। **এই চারটা ফাইল closed —
  আগের ফেজের backlog নোটে ভুলে "unaudited" থেকে গিয়েছিল, এখন ঠিক করা
  হলো।**
- **`mcp-agents.ts`, `ai-agent.ts`** — পুরো দুটো ফাইলের প্রতিটা route-ই
  `requireDev`-gated। এগুলো user-owned resource না — dev-only global admin
  config (agent types, skills, providers, model catalog) — কোনো ownership
  concept-ই এখানে প্রযোজ্য না। `requireDev` নিজেই Phase A2-তে RBAC-PEP
  shim দিয়ে ইতিমধ্যে PDP-routed। **কিছু migrate করার নেই, flag বন্ধ।**
- **`users.ts`** — routes দুই ভাগে: `/users/:id`, `/users/:id/stats`,
  `/admin/kyc/:userId/approve|reject` সব `requireAdmin`-gated (by design —
  admin-কে *যেকোনো* user দেখতে/manage করতে পারতে হয়, এটা ownership question
  না); `/profile`, `/profile/kyc`, `/profile/kyc/submit`,
  `/users/change-password` — কোনো client-supplied `:id` নেই, `req.user!.userId`
  দিয়ে সরাসরি self-scoped। **কিছু migrate করার নেই, flag বন্ধ।**
- **`marketplace-analytics.ts`, `marketplace-discovery.ts`,
  `marketplace-market-config.ts`, `marketplace-reports.ts`, `polymarket.ts`**
  — audit করা হলো, কোনোটাতেই client-supplied `:id` দিয়ে single owned-row
  gate করার মতো route নেই (সব public read, admin-RBAC, বা self-scoped
  create/list)। **কিছু migrate করার নেই।**
- **`marketplace-nft.ts`-এর `POST /listings/:id/like`** — toggle-membership
  (like/unlike), owner-check-then-404 না — C16-এর `favorite` exclusion-এর
  same class। বাদ।

### যেখানে সত্যিকার কাজ পাওয়া গেছে

## Part 1 — marketplace-alerts.ts

`marketplace_alerts`-এর একটাই owner column (`user_id`) — plain
single-owner shape।

| Route | আগের 404 body |
|---|---|
| `PATCH /marketplace/alerts/:id` | `"Alert not found or not yours"` |
| `DELETE /marketplace/alerts/:id` | একই |

`marketplaceAlertResource` + `requireMarketplaceAlertOwnership(action,
notFoundBody)`। `POST /alerts`, `GET /alerts` (own list), `POST/GET
/saved-searches` — কোনোটাই `:id`-গেটেড না, বাদ।

## Part 2 — marketplace-spot.ts

দুটো ভিন্ন টেবিল, দুটো ভিন্ন resource:

| Route | Table | আগের error body |
|---|---|---|
| `DELETE /spot/orders/:id` | `spot_orders` (user_id) | `"Order not found"` |
| `POST /spot/staking/unstake/:id` | `staking_positions` (user_id) | `"Position not found"` |

দুটো handler-ই gate-এর পরে নিজের `SELECT ... FOR UPDATE` দিয়ে row-টা আবার
লক করে নেয় নিজস্ব transaction-এর ভেতরে — PEP শুধু একটা additive pre-check,
এই lock-এর সাথে race করে না বা replace করে না। বাকি সব route
(pairs/orderbook/trades/candles/balances/place-order/staking pools/positions/
stake) হয় public market data নয়তো caller-এর নিজের userId দিয়ে filtered
list/create — কোনো `:id`-গেট দরকার নেই।

## Rollout
কোনো behavior change নেই — সব ownership check আগে থেকেই ছিল, শুধু এখন
PDP-র মধ্য দিয়ে যায় আর `pepDecisionObserver`-এ audit হয়। কোনো নতুন env
var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- দুটো এডিট করা ফাইলেই bracket/brace/paren balance script চালানো হয়েছে —
  `marketplace-alerts.ts` `{}` 59/59 `()` 97/97;
  `marketplace-spot.ts` `{}` 156/156 `()` 440/440 — শূন্যে মেলে।
- `routes/index.ts`-এ দুটো ফাইলই mount হয় কিনা grep করে নিশ্চিত করা
  হয়েছে (live traffic পায়)।
- `marketplace-azn.ts`/`game.ts`/`usdt.ts`/`vault.ts`-এর `DELETE
  /listings/:id` handler-গুলো grep করে সরাসরি চোখে দেখে confirm করা
  হয়েছে যে এগুলো `authorize()` + `...OwnerOrAdminEngine` দিয়ে ইতিমধ্যে
  wired — নতুন কিছু বসানো হয়নি, শুধু status confirm করা হলো।
- চারটা wired route grep করে নিশ্চিত করা হয়েছে ঠিক intended helper দিয়েই
  চলছে।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে: owner → gate ALLOW → handler-এর
  নিজস্ব `FOR UPDATE` re-select/transaction আগের মতোই চলে। Non-owner id →
  gate deny → route-specific pre-existing error body।

## এখনো যা বাকি
`content.ts`-এর missing-ownership gap আগের মতোই flagged, ফিক্স হয়নি —
Rakib-এর সিদ্ধান্তের অপেক্ষায়। `vault.ts` family Season B-এর Phase B2-এর
জন্য সংরক্ষিত। এই ফেজের audit-এর পর marketplace family + mcp-agents.ts +
ai-agent.ts + users.ts-এর মধ্যে আর কোনো known unaudited ownership surface
নেই — Season C-এর mechanical-sweep backlog এখন কার্যত এই দুইটা reserved
আইটেমেই সীমাবদ্ধ।
