# Route Integration Roadmap — Season C, Phase C17: Mechanical Sweep (batch 17, marketplace-bundles.ts + marketplace-offers.ts + marketplace-reviews.ts + marketplace-cart.ts)

## এই ফেজের scope

C16-এর "এখনো যা বাকি" নোটে flag করা marketplace satellite ফাইলগুলোর
(bundles, offers, cart, reviews) মধ্যে চারটা এই ফেজে migrate করা হলো —
সবগুলোই `marketplace.ts`-এর মতোই raw `pool.query` (node-postgres) দিয়ে
লেখা, তাই resource lookup-ও একই style-এ লেখা হয়েছে, নতুন কোনো dependency
আনা হয়নি।

## Part 1 — marketplace-bundles.ts

`marketplace_bundles`-এর একটাই owner column (`seller_id`) —
`marketplace_listings`-এর মতোই plain single-owner shape। চারটা route-এর
মধ্যে শুধু একটাই gate দরকার:

| Route | আগের 404 body |
|---|---|
| `DELETE /marketplace/bundles/:id` | `"Bundle not found, not yours, or already resolved"` |

`marketplaceBundleResource` + `requireMarketplaceBundleOwnership(action,
notFoundBody)`। Handler-এর নিজস্ব `status='active'` combined condition
হুবহু থেকে গেল — PEP শুধু ownership অংশ নেয়, listings PATCH-এর মতোই আগের
ফেজগুলোর treatment।

## Part 2 — marketplace-offers.ts

`marketplace_offers`-এর দুটো owner column (`buyer_id`, `seller_id`), কিন্তু
`marketplace_orders`-এর মতো কোনো route-ই "যেকোনো এক পক্ষ" allow করে না —
প্রতিটা route consistently একটাই column চেক করে: accept/reject/counter
seller-only, delete (withdraw) buyer-only। তাই party-OR trick লাগেনি,
দুটো আলাদা single-owner builder যথেষ্ট (`marketplaceOfferSellerResource`,
`marketplaceOfferBuyerResource`)।

| Route | Resource builder | আগের 404 body |
|---|---|---|
| `POST /offers/:id/accept` | seller | `"Offer not found, not yours, or already resolved"` |
| `POST /offers/:id/reject` | seller | একই |
| `POST /offers/:id/counter` | seller | একই |
| `DELETE /offers/:id` | buyer | `"Offer not found, not yours, or cannot be withdrawn"` |

## Part 3 — marketplace-reviews.ts

দুই ধরনের resource এই ফাইলে:

- **`POST /orders/:id/review`** আসলে `marketplace_orders` (buyer_id)-এর
  উপর একটা ownership+status combined check (`buyer_id=$2 AND
  status='completed'`) — `marketplace.ts`-এর `marketplaceOrderBuyerResource`
  একই টেবিল/কলামের উপর, কিন্তু এই সিরিজের "প্রতিটা ফেজ নিজের
  `ResourceRefBuilder` নিজের ফাইলে self-contained রাখে" নীতি অনুযায়ী
  (Phase C14-এর local `emailAccountResource`-এর মতোই) আলাদাভাবে
  `marketplaceReviewOrderResource` নামে locally বানানো হলো, cross-file
  import না করে।
- **`marketplace_reviews`**-এর নিজেরও দুটো owner column (`buyer_id`,
  `seller_id`) — PATCH/DELETE buyer-only, response route seller-only —
  offers.ts-এর same two-single-owner-builders shape।

| Route | Resource | আগের 404 body |
|---|---|---|
| `POST /orders/:id/review` | order (buyer_id) | `"Completed order not found or not yours"` |
| `PATCH /reviews/:id` | review buyer | `"Review not found or not yours"` |
| `DELETE /reviews/:id` | review buyer | একই |
| `POST /reviews/:id/response` | review seller | `"Review not found or not yours to respond to"` |

## Part 4 — marketplace-cart.ts

`marketplace_cart_items`-এর নিজস্ব `id` + plain `user_id` owner column —
এটা C16-এর "favorite" exclusion-এর ক্লাস না (favorite কোনো client-facing
row id refer করে না, শুধু caller-এর নিজের set-এ membership toggle করে)।
এখানে `:id` একটা নির্দিষ্ট existing row-কে refer করে যেটার সাথে অন্য
user-এর id collision হতে পারে — এটা ঠিক `local_accounts.ts`
(Phase C15)-এর same "client-supplied :id + hand-rolled WHERE id=$1 AND
user_id=$2" shape, genuine ownership gate।

| Route | আগের 404 body |
|---|---|
| `DELETE /cart/:id` | `"Cart item not found"` |
| `POST /cart/:id/save-for-later` | একই |
| `POST /cart/saved/:id/move-to-cart` | `"Saved item not found"` |

## এই ফেজে যা সরানো হয়নি
- `marketplace-offers.ts`-এর `POST/GET /listings/:id/offers`,
  `GET /offers/my`, `GET /offers/received` — এগুলো single-resource
  ownership gate না, বরং listing-scoped বা caller-scoped list read
  (non-owner হলে 404 না, শুধু খালি/ফিল্টার্ড রেজাল্ট) — এই সিরিজের
  gate-before-404 primitive-এ ফিট করে না, বাদ।
- `marketplace-reviews.ts`-এর `GET /sellers/:id/reviews`,
  `GET /sellers/:id/rating`, `GET /reviews/my` — public/self-scoped read,
  কোনো ownership question নেই।
- `marketplace-cart.ts`-এর `GET/POST /cart`, `GET /cart/count`,
  `DELETE /cart` (clear all), `GET /cart/validate`, `POST
  /cart/checkout` — কোনোটাই client-supplied `:id` দিয়ে single row target
  করে না, সবই caller-এর নিজের `userId`-স্কোপড bulk অপারেশন — বাদ।
- Handler-এর নিজস্ব business logic (bundle escrow transaction, offer
  accept-এর auto-reject-others, review upsert, cart price resolution,
  checkout escrow) হুবহু অপরিবর্তিত।

## Rollout
কোনো behavior change নেই এই ফেজে — সব ownership check আগে থেকেই ছিল,
শুধু এখন PDP-র মধ্য দিয়ে যায় আর `pepDecisionObserver`-এ audit হয়। কোনো
নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- চারটা ফাইলেই bracket/brace/paren balance script চালানো হয়েছে:
  `marketplace-bundles.ts` `{}` 59/59 `()` 118/118;
  `marketplace-offers.ts` `{}` 77/77 `()` 142/142;
  `marketplace-reviews.ts` `{}` 70/70 `()` 131/131;
  `marketplace-cart.ts` `{}` 99/99 `()` 187/187 — সব শূন্যে মেলে।
- `routes/index.ts`-এ চারটা ফাইলই mount হয় কিনা grep করে নিশ্চিত করা
  হয়েছে (dead code না, সবগুলো live traffic পায়)।
- মোট ১২টা route grep করে নিশ্চিত করা হয়েছে ঠিক intended helper দিয়েই
  wired হয়েছে (`marketplace-reviews.ts`-এ `MARKETPLACE_ORDER_OWNER_
  SENTINEL_NONE` নাম আগে থেকে exist করে না, শুধু নতুন যোগ হওয়া constant,
  duplicate-declaration risk নেই বলে যাচাই করা হয়েছে)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner →
  gate ALLOW → handler-এর নিজস্ব combined query আগের মতোই চলে (bundle
  status='active', review order status='completed', offer status='pending'
  ইত্যাদি এখনো handler-এই রয়ে গেছে, ফলে non-eligible-কিন্তু-owned
  case-এও আগের 404 বডিই আসে)। Non-owner id → gate deny → route-specific
  pre-existing body।

## এখনো যা বাকি
`marketplace-alerts.ts`, `marketplace-analytics.ts`, `marketplace-azn.ts`,
`marketplace-discovery.ts`, `marketplace-game.ts`,
`marketplace-market-config.ts`, `marketplace-nft.ts`,
`marketplace-reports.ts`, `marketplace-spot.ts`, `marketplace-usdt.ts`,
`marketplace-vault.ts`, `marketplace-wallet.ts`, `polymarket.ts` — এখনো
audit বাকি (marketplace family-র বাকি resource ownership surface)।
`mcp-agents.ts`, `ai-agent.ts`, `users.ts` এখনো unaudited। `content.ts`-এর
missing-ownership gap আগের মতোই flagged, ফিক্স হয়নি — Rakib-এর সিদ্ধান্তের
অপেক্ষায়। `vault.ts` family Season B-এর Phase B2-এর জন্য সংরক্ষিত।
