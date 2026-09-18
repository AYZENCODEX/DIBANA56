# Route Integration Roadmap — Season C, Phase C23: vault_shares cluster (vault-shares.ts)

## এই ফেজের scope
`vault_shares` টেবিলের নিজস্ব একটা plain `owner_id` কলাম আছে — C19-এর
মতোই simple single-owner shape, এই সিরিজের mechanical batch-গুলোর
একটা।

| Route | আগের behavior |
|---|---|
| `PATCH /vault-shares/:id` | `404 {error:"Not found or not yours to manage"}` |
| `DELETE /vault-shares/:id` | একই body |

দুটো route-ই ঠিক একই deny body শেয়ার করে বলে একটাই resource builder +
একটাই shared `onDeny` callback দিয়ে কভার হয়েছে।

## পরিবর্তন
`vaultShareResource` (নতুন, `owner_id` কলাম থেকে ownership পড়ে) আর
`requireVaultShareOwnership(action, onDeny)` wrapper যোগ হয়েছে —
এই সিরিজের বাকি নতুন resource-lookup-গুলোর মতোই parameterized `sql`
tagged-template স্টাইলে লেখা, যদিও এই ফাইলের বাকি সব query
`sql.raw`+`safe()`-ভিত্তিক। কোনো অন্য ফাইল এই builder ব্যবহার করে না,
তাই export করা হয়নি — module-local।

`PATCH /vault-shares/:id` আর `DELETE /vault-shares/:id`-এ middleware
বসানো হয়েছে, handler-এর নিজস্ব `WHERE id=X AND owner_id=Y`
query/logic (field-permission parsing, notification, ইত্যাদি) অপরিবর্তিত।

## যা এই ফেজে টাচ করা হয়নি
- `POST /vault-shares` — client-supplied `:id` route না, body-তে
  `entityType`/`entityId` (যে entity share করা হচ্ছে তার ownership,
  `vault_shares` row-এর নিজের ownership না) — এই সিরিজের
  `ResourceRefBuilder`-এর `req.params.id`-shaped ধরন এই body-based
  dual-resource check-এ ফিট করে না, C21-এর `POST /vault-entity-links`
  exclusion-এর same class।
- `GET /vault-shares/*` (list/detail-by-share-token routes) — roadmap-এর
  table-এ এগুলো ছিলই না, touch করা হয়নি।
- `PATCH /vault-shares/bulk`, `DELETE /vault-shares/bulk` —
  roadmap-এ আগে থেকেই flagged: ownership pre-filter ইতিমধ্যে query-তেই
  বসানো (`... AND owner_id = ${userId}`), C13-এর `authorizeMany()`
  bulk pattern দিয়ে migrate করার প্রশ্ন — সেটা একটা future bulk-family
  sweep-এর সিদ্ধান্ত, এই ফেজের scope না। Route registration order
  অপরিবর্তিত রাখা হয়েছে (`bulk` route দুটো এখনো `:id` route-এর আগেই
  আছে, যাতে "bulk" স্ট্রিংটা `:id` হিসেবে match না হয়ে যায়)।

## Rollout
দুটো route-এরই owner-এর success path আর non-owned/nonexistent-id-এর
deny body — কোনোটাই বদলায়নি (আগেও `404 "Not found or not yours to
manage"`, এখনো তাই, শুধু এখন explicit PDP deny-path দিয়ে আসে)। কোনো
নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- `vault-shares.ts` `{}` 294/294 `()` 469/469 — bracket-balance শূন্যে
  মেলে।
- `routes/index.ts`-এ `vaultSharesRouter` import + `router.use(...)`
  করা আছে confirm করা হয়েছে।
- grep করে নিশ্চিত করা হয়েছে `bulk` route দুটো এখনো `:id` route দুটোর
  আগেই registered আছে (registration-order regression নেই)।
- ম্যানুয়ালি verify করা হয়েছে: owner → gate ALLOW → handler-এর নিজস্ব
  query/logic আগের মতোই চলে (field-permission parsing, notification
  dispatch touch হয়নি)। Non-owner/nonexistent id → gate deny → দুটো
  route-ই আগের মতো একই body দেয়।

## Sizing note — roadmap আপডেট
C23 সম্পন্ন। বাকি roadmap: C24 (ayzen_mail dual-owner, নতুন
predicate-shape লাগবে, ২ route) → C25 (security.ts + two-factor.ts
mechanical sweep, ৩ route)। মোট বাকি ~৫টা route, ৩টা ফাইল জুড়ে, ২টা
ফেজে।
