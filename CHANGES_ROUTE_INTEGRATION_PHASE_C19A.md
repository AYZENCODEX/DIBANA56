# Route Integration Roadmap — Season C, Phase C19A: Mechanical Sweep (batch 19A, KYC/game/earn-link/NFT-subscription family — new files for this series)

## এই ফেজের scope

C18-এর audit marketplace family + mcp-agents/ai-agent/users শেষ করে দেওয়ার
পর, এই ফেজে পুরো `routes/` ডিরেক্টরির বাকি ~১০০টা ফাইলের মধ্যে fresh sweep
চালানো হলো `:id`-প্যারাম route থাকা ফাইলগুলো খুঁজে বের করতে। বেশিরভাগ
(project-templates.ts, project-dates.ts, reward-links.ts, ad-tasks.ts,
custom-buttons.ts, key-manager.ts, networks.ts, nft-subscriptions.ts-এর
categories sub-routes) আগে থেকেই `requireAdmin`/`requireRoles`/`requireDev`
দিয়ে গেটেড — RBAC, ownership না, Phase A2-তেই PDP-routed। `messages.ts`-এর
`:otherUserId`/`:toUserId` কোনো owned resource id না, DM-এর অন্য পক্ষ বেছে
নেওয়ার selector — বাদ। `entities.ts` সরাসরি `vault_entries` টেবিলের উপর
কাজ করে — Season B-এর `vault.ts` reservation-এর আওতায়, বাদ। এসবের বাইরে
পাঁচটা ফাইলে সত্যিকার ownership-gate candidate পাওয়া গেছে — সবগুলোই একই
"KYC entity" ecosystem-এর আশেপাশে, যদিও টেবিল আলাদা আলাদা।

## Part 1 — kyc.ts (`kyc_entries`, owner=`user_id`)

| Route | আগের behavior |
|---|---|
| `GET /kyc-entries/:id` | `404 { error: "Not found" }` |
| `PUT /kyc-entries/:id` | `404 { error: "Not found or forbidden" }` |
| `PATCH /kyc-entries/:id/status` | একই |
| `DELETE /kyc-entries/:id` | কোনো error না — quiet no-op, `{ success: true }` |

`kycEntryResource` এই ফাইলের নিজস্ব parameterized `` sql`...` `` tagged-
template style-এ লেখা (এই ফাইল `sql.raw` ব্যবহার করে না, শুধু hardcoded
JOIN/SELECT fragment-এর জন্য — request data কখনো raw interpolate হয় না,
তাই builder-ও একই নিয়ম মেনেছে)।

## Part 2 — kyc-data-entities.ts (`kyc_data_entities`, owner=`user_id`)

`entities.ts`-এর মতো এই ফাইলও `vault_entries` পড়ে (used/unused গণনার
জন্য), কিন্তু primary resource-টা `kyc_data_entities` — আলাদা টেবিল, নিজের
owner column — তাই `vault.ts` reservation-এর বাইরে।

| Route | আগের behavior |
|---|---|
| `GET /kyc-data-entities/:id` | `404 { error: "Not found" }` |
| `PUT /kyc-data-entities/:id` | `404 { error: "Not found or forbidden" }` |
| `DELETE /kyc-data-entities/:id` | quiet no-op, `{ success: true }` — কিন্তু নিচে দেখুন |

### DELETE-এ একটা real edge-case behavior tightening (deliberate, flag করা হলো)
Handler-এর নিজস্ব DELETE-এর আগে দুটো "in use" check আছে (কোনো `kyc_entries`
বা `vault_entries` row এই data-entity-কে link করে রেখেছে কিনা) — এই
check দুটো **`user_id` দিয়ে filtered ছিল না**, মানে non-owned একটা id-ও
যদি globally কোথাও in-use থাকত, caller একটা `409 "...in use..."` response
পেত — id-টা আসলে exist করে আর কার সাথে linked সেই তথ্যের একটা ছোট
cross-tenant leak। Gate বসানোর পর non-owned id সবসময় ownership check-এই
আটকে যায় (handler-এ পৌঁছায় না), ফলে এখন এই edge case-ও বাকি সব non-owned
id-র মতোই consistent quiet `{ success: true }` পায় — Phase C14/C15-এর
"সত্যিকার fix, preserve-behavior refactor না" ধরনের deliberate flag, owner-এর
normal path বা "সাধারণ" non-owned/not-in-use path-এ কোনো পরিবর্তন নেই।

## Part 3 — game-entries.ts (`game_entries`, owner=`user_id`)

| Route | আগের behavior |
|---|---|
| `PUT /game-entries/:id` | `404 { error: "Not found or forbidden" }` |
| `DELETE /game-entries/:id` | quiet no-op, `{ success: true }` |

## Part 4 — earn-links.ts (`earn_links`, owner=`user_id`)

| Route | আগের behavior |
|---|---|
| `PATCH /earn-links/:id` | কোনো rows-check-ই ছিল না — সবসময় `{ ok: true }` |
| `DELETE /earn-links/:id` | একই |

দুটো route-ই আগে win/miss নির্বিশেষে unconditionally `{ ok: true }`
রিটার্ন করত — `denySilentSuccess`-এর same treatment, C15-এর local-accounts
DELETE-এর মতোই। `GET /r/:code` (public click-through redirect, code দিয়ে
lookup, resource ownership প্রশ্নই না) বাদ।

## Part 5 — nft-subscriptions.ts (`nft_subscriptions`, owner=`owner_id`)

| Route | আগের behavior |
|---|---|
| `POST /nft-subscriptions/:id/list` | `404 { error: "NFT not found, not yours, or already listed" }` |
| `POST /nft-subscriptions/:id/delist` | কোনো rows-check না — সবসময় `{ success: true }` |

`POST /:id/buy` **ইচ্ছাকৃতভাবে বাদ** — ওটার `nft.owner_id === buyerId`
check আসলে "এটা আমার নিজের listing কিনা" জিজ্জ্ঞেস করছে না, উল্টো —
"buyer অন্য কারো NFT কিনছে কিনা" — এই সিরিজে marketplace offers/listings
buy flow-এ যেমন ownership gate বসানো হয়নি ঠিক সেই একই class-এর check।

## এই ফেজে যা সরানো হয়নি
- `project-templates.ts`, `project-dates.ts`, `reward-links.ts`,
  `ad-tasks.ts`, `custom-buttons.ts`, `key-manager.ts`, `networks.ts` —
  পুরোপুরি `requireAdmin`/`requireRoles`/`requireDev`-gated, ownership
  question নেই।
- `messages.ts`-এর `:otherUserId`/`:toUserId` — conversation-partner
  selector, owned resource id না।
- `entities.ts` — সরাসরি `vault_entries`-এর উপর কাজ করে, Season B-এর
  Phase B2-এর জন্য সংরক্ষিত `vault.ts` family-র আওতায়।
- `watchlist.ts` — toggle-membership (add/remove own watchlist by
  projectId), C16-এর `favorite` exclusion-এর same class।
- Handler-এর নিজস্ব business logic (encrypt/decrypt field, KYC data-entity
  used/unused গণনা, NFT buy escrow) হুবহু অপরিবর্তিত।

## Rollout
`kyc-data-entities.ts`-এর DELETE-এ উপরে বর্ণিত একটা real edge-case
tightening আছে (non-owned-কিন্তু-globally-in-use id-র জন্য)। বাকি সব
route-এর owner-এর success path বা common non-owned/nonexistent-id path —
দুটোই আগের মতোই অপরিবর্তিত। কোনো নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- পাঁচটা ফাইলেই bracket/brace/paren balance script চালানো হয়েছে:
  `kyc.ts` `{}` 155/155 `()` 229/229; `kyc-data-entities.ts` `{}` 98/98
  `()` 154/154; `game-entries.ts` `{}` 79/79 `()` 123/123;
  `earn-links.ts` `{}` 62/62 `()` 102/102; `nft-subscriptions.ts` `{}`
  167/167 `()` 353/353 — সব শূন্যে মেলে।
- `routes/index.ts`-এ পাঁচটা ফাইলই mount হয় কিনা grep করে নিশ্চিত করা
  হয়েছে (dead code না)।
- মোট ১৩টা route grep করে নিশ্চিত করা হয়েছে ঠিক intended helper দিয়েই
  wired হয়েছে।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner →
  gate ALLOW → handler-এর নিজস্ব query/combined-condition আগের মতোই চলে
  (nft list-এর `is_burned=FALSE AND is_listed=FALSE` এখনো handler-এই)।
  Non-owner/nonexistent id → gate deny → route-specific pre-existing body,
  quiet-no-op route-গুলোতে বিশেষভাবে verify করা হয়েছে যে deny path-ও ঠিক
  আগের unconditional success body-ই দেয়, নতুন কোনো 404/403 না।

## এখনো যা বাকি
`content.ts`-এর missing-ownership gap আগের মতোই flagged, ফিক্স হয়নি —
Rakib-এর সিদ্ধান্তের অপেক্ষায়। `vault.ts`/`entities.ts` family Season
B-এর Phase B2-এর জন্য সংরক্ষিত। বাকি ~১০০টা route file-এর মধ্যে এখনো
সম্পূর্ণ line-by-line audit হয়নি (এই ফেজে শুধু `:id`-প্যারাম-যুক্ত
ফাইলগুলোর উপর targeted grep sweep করা হয়েছে) — একটা future phase পুরো
বাকি surface-টা সম্পূর্ণভাবে ঝাড়াই-বাছাই করতে পারে যদি দরকার মনে হয়।

## Numbering note — কেন "C19A"
আগের draft roadmap (audit-only, কোনো কোড ছাড়া) `kyc_entries`,
`kyc_data_entities`, single-owner mechanical batch, আর
`nft_subscriptions`-কে আলাদা আলাদা ফেজ (C19/C20/C25/C26) হিসেবে ভেবেছিল।
বাস্তবে implementation একবারে এই পাঁচটা ফাইল একসাথে batch করে ফেলেছে
নিজের নাম্বারে "C19" হিসেবে — draft-এর সাথে ১:১ না মেলায় এটাকে **C19A**
হিসেবে apply করা হলো, যাতে সিরিয়াল নম্বর না ভেঙে বাকি draft phase-গুলোকে
renumber করতে হয়।

**একটা real gap ধরা পড়েছে এই consolidation-এ:** draft-এর C19 প্ল্যানে
`exchange-api.ts`-এর `PATCH /kyc-entries/:id/exchange-keys` route-টাও
`kycEntryResource` শেয়ার করার কথা ছিল (একই `kyc_entries` টেবিল, একই owner
column) — কিন্তু এই batch-এ শুধু `kyc.ts` টাচ হয়েছে, `exchange-api.ts` না়।
মানে `kyc_entries` resource-এর উপর এখনো একটা unwired route বাকি আছে।
সেটা **C19B**-তে যাচ্ছে (নিচে দেখুন)।

এছাড়া এই ফেজের audit `entities.ts`-কে সরাসরি Season B-এর `vault.ts`
reservation-এর ভেতরেই রাখল (draft roadmap-এ এটাকে vault.ts থেকে আলাদা করে
C21-এ রাখার প্রস্তাব ছিল) — এই সিদ্ধান্তকে authoritative ধরে বাকি roadmap
আপডেট করা হলো। `watchlist.ts`ও নতুন করে audit হয়ে toggle-membership ক্লাসে
বাদ পড়েছে (C16 favorite-এর মতো) — draft-এ এটা ছিলই না, নতুন finding।

## পরের ফেজ — C19B থেকে renumbered draft

- **C19B** — `exchange-api.ts`-এর `PATCH /kyc-entries/:id/exchange-keys`,
  `kyc.ts`-এর `kycEntryResource`-ই reuse করে (এখন সেটা export করতে হবে)।
- **C20** — `value-history.ts`-এর `/vault/:id/*` তিনটা route (নতুন
  `vaultEntryResource` লাগবে — `entities.ts` যেহেতু এখন সরাসরি Phase B2-এর
  আওতায়, এই resource builder-টা কে বানাবে সেটা B2-owner-এর সাথে সমন্বয়
  করে ঠিক করতে হবে)।
- **C21** — `value-history.ts`-এর `/local-accounts/:id/*` দুইটা route
  (C15-এর `localAccountResource` export করে reuse)।
- **C22** — `vault-shares.ts` (`PATCH`/`DELETE /vault-shares/:id`, owner
  column `owner_id`)।
- **C23** — `ayzen-mail.ts` dual-owner resource (`to_user_id` /
  `from_user_id`, নতুন predicate-shape লাগবে)।
- **C24** — ছোট mechanical batch: `security.ts`-এর
  `DELETE /security/magic-codes/:id` + `two-factor.ts`-এর
  `PATCH`/`DELETE /two-factor/other/:id`।
