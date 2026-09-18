# Route Integration Roadmap — Season C, Phase C16: Mechanical Sweep (batch 16, local-accounts.ts's deferred routes + marketplace.ts — new file)

## Part 1 — local-accounts.ts: C15-এ deferred দুটো route

`local_account_category` আর `local_account_point` — নিজেদের id-space,
নিজেদের `user_id` owner column, `local_accounts` থেকে আলাদা টেবিল বলে
C15-এ আলাদা রাখা হয়েছিল। এই ফেজে সেই দুটোই একই C15-এর pattern-এ:

| Route | আগের behavior |
|---|---|
| `DELETE /local-accounts/categories/:id` | কোনো error না — quiet no-op, `{ success: true }` |
| `DELETE /local-accounts/points/:pointId` | কোনো error না — quiet no-op, `{ success: true }` |

দুটোরই নিজস্ব `ResourceRefBuilder` (`localAccountCategoryResource`,
`localAccountPointResource`) — C15-এর `denySilentSuccess` পুনরায় ব্যবহার
করা হলো, কারণ এই দুটো route-ও কখনো 404 দিত না।

## Part 2 — marketplace.ts (নতুন ফাইল, original audit-এ ছিল না)

C15-এর মতোই fresh sweep-এ খুঁজে পাওয়া — এই ফাইল raw `pool.query`
(node-postgres) দিয়ে লেখা, Drizzle বা `db.execute` কোনোটাই না। Resource
lookup-গুলোও তাই একই style-এ লেখা হলো, নতুন কোনো dependency আনা হয়নি।

### `marketplace_listings` — সাধারণ single-owner (seller_id)

| Route | আগের 404 body |
|---|---|
| `PATCH /listings/:id` | `"Listing not found, not yours, or no longer active"` |
| `PUT /listings/:id/platform-pricing` | একই |
| `DELETE /listings/:id/platform-pricing/:platform` | `"Listing not found or not yours"` |
| `DELETE /listings/:id` | `"Listing not found or not yours"` |

`marketplaceListingResource` (owner = `seller_id`) + parameterized
`requireMarketplaceListingOwnership(action, notFoundBody)`। প্রথম দুটো
route-এর নিজস্ব ownership+status='active' combined check হুবহু থেকে
গেল (PEP শুধু ownership অংশ আগে নেয়, ঠিক reschedule/undo-send-এর মতো
আগের ফেজগুলোর treatment)।

### `marketplace_orders` — দুই owner (buyer বা seller), route ভেদে ভিন্ন owner-প্রশ্ন

এই টেবিলটা এই সিরিজে প্রথমবার একটা নতুন shape আনল: buyer আর seller
দুজনেই order-এর legitimate party, কিন্তু কে কী করতে পারবে সেটা
route-ভেদে আলাদা।

- `GET /orders/:id`, `GET /orders/:id/receipt` — **দুজনের যে কেউ** দেখতে
  পারে (আগের query: `buyer_id=$2 OR seller_id=$2`)
- `POST /orders/:id/confirm`, `POST /orders/:id/dispute` — **শুধু buyer**

`createResourceOwnershipRule()` শুধু একটাই `resource.ownerId` কে
`subject.userId`-র সাথে তুলনা করে — দুইটা owner-এর OR ধারণা এতে নেই।
এই ফেজে সেটা হ্যাক না করে, দুইটা আলাদা `ResourceRefBuilder` দিয়ে সমাধান
করা হলো:

- **`marketplaceOrderBuyerResource`** — `ownerId` সরাসরি `buyer_id`,
  confirm/dispute-এর জন্য।
- **`marketplaceOrderPartyResource`** — rule-এর contract যেহেতু শুধু
  "ownerId === বর্তমান subject-এর নিজের userId" চেক করে, এই builder
  নিজেই OR-check করে ফেলে (`buyer_id === userId || seller_id ===
  userId`) আর যখন মিলে যায় তখন `ownerId`-কে সেই **same userId**-ই
  রিপোর্ট করে (না মিললে sentinel) — rule-এর single-equality contract-এর
  মধ্যেই থেকে "caller এই order-এর একটা party কিনা" প্রশ্নের বৈধ উত্তর
  দেওয়ার একটা পদ্ধতি, hack না।

| Route | Resource builder | আগের 404 body |
|---|---|---|
| `GET /orders/:id` | party | `"Order not found"` |
| `GET /orders/:id/receipt` | party | `"Order not found"` |
| `POST /orders/:id/confirm` | buyer-only | `"Order not found, not yours, or not in a confirmable state"` |
| `POST /orders/:id/dispute` | buyer-only | `"Order not found, not yours, or cannot be disputed"` |

## এই ফেজে যা সরানো হয়নি
- `POST/DELETE /listings/:id/favorite` — এটা resource ownership-এর
  প্রশ্নই না, caller-এর নিজের favorite list-এ যোগ/বাদ, self-scoped
  (C9-এর নিজের exclusion যুক্তির same class) — বাদ।
- Handler-এর নিজস্ব business logic (platform-pricing-এর transaction,
  buy/confirm/dispute-এর status-machine, escrow) হুবহু অপরিবর্তিত।

## Rollout
কোনো behavior change নেই এই ফেজে — সব ownership check আগে থেকেই ছিল,
শুধু এখন PDP-র মধ্য দিয়ে যায় আর `pepDecisionObserver`-এ audit হয়। কোনো
নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- দুটো ফাইলেই bracket/brace/paren balance script চালানো হয়েছে —
  `local-accounts.ts`: `{}` 418/418, `()` 684/684; `marketplace.ts`:
  `{}` 359/359, `()` 725/725 — শূন্যে মেলে।
- `marketplace.ts`-এ `req.user?.userId` ব্যবহারের আগে
  `middlewares/auth.ts`-এর `declare global` block দেখে নিশ্চিত করা হয়েছে
  যে `Request.user` টাইপ optional (`user?: AuthUser`) — তাই
  `marketplaceOrderPartyResource`-এর ভেতরে optional chaining সঠিক।
- ম্যানুয়ালি verify করা হয়েছে: buyer-only route-এ seller (owner না)
  → deny → pre-existing body। Party route-এ buyer বা seller যে কেউ
  → allow; তৃতীয় কোনো user → deny → `"Order not found"`।
- সবগুলো (১০টা) route grep করে নিশ্চিত করা হয়েছে যে ঠিক intended
  helper দিয়েই wired হয়েছে।

## এখনো যা বাকি
`marketplace.ts`-এর বাকি resource-গুলো (bundles, coupons, cart, offers,
reviews ইত্যাদি আলাদা ফাইলে) এখনো audit বাকি। `content.ts`-এর
missing-ownership gap আগের মতোই flagged। `vault.ts` family Season B-এর
জন্য সংরক্ষিত।
