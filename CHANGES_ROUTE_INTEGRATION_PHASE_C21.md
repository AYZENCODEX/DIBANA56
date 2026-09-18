# Route Integration Roadmap — Season C, Phase C21: vault_entries peripheral surface (entities.ts + value-history.ts-এর vault অংশ)

## এই ফেজের scope
`vault.ts`-এর মূল CRUD এখনো Season B/Phase B2-এর জন্য reserved, কিন্তু
`vault_entries` টেবিলের উপর `entities.ts` আর `value-history.ts`-এ read/
mutate route ছিল যেগুলো সেই reservation-এর বাইরে — draft roadmap-এর মতে
এই ফেজেই `lib/policy/`-এ প্রথম `vault_entries` resource builder বানানোর
কথা ছিল।

## একটা real finding — builder আগে থেকেই ছিল, নতুন বানাতে হয়নি
Draft-এর ধারণা ছিল `vault_entries`-এর কোনো resource builder কোথাও নেই।
বাস্তবে grep করে দেখা গেল Phase C8 (`vault-entity-links.ts`) নিজের
`GET /vault/:id/links` route-এর জন্য ইতিমধ্যে ঠিক এই shape-এর একটা
`vaultEntryResource` বানিয়ে রেখেছিল (`vault_entries.user_id`, Drizzle
query-builder স্টাইলে) — module-local, export হতো না। C19B-এর precedent
(export over duplicate copy) অনুসরণ করে **নতুন builder বানানো হয়নি** —
`vault-entity-links.ts`-এ শুধু `export` কিওয়ার্ড যোগ করে সেটাই reuse করা
হয়েছে `entities.ts` আর `value-history.ts`-এ।

`vault-entity-links.ts`-এর নিজস্ব `requireVaultEntryOwnership()` wrapper
**export করা হয়নি** — ওটার `onDeny` ওই ফাইলের নিজের জন্য hardcoded
(`404 {error:"Vault entry not found"}`), কিন্তু নিচের সাতটা route-এর
প্রতিটার নিজস্ব ভিন্ন pre-existing deny body আছে (কোনোটা 404 অন্য
message-এ, কোনোটা 403, কোনোটা silent empty-array)। তাই দুই ফাইলেই
`kyc.ts`-এর মতো parameterized local wrapper বানানো হয়েছে —
`requireVaultEntryOwnership(action, onDeny)` — যাতে route-ভেদে deny body
আলাদা রাখা যায়, কোনো route-এর behavior না বদলে।

## পরিবর্তন

### `entities.ts` (৫টা route)
| Route | আগের/এখনকার deny body (অপরিবর্তিত) |
|---|---|
| `GET /entities/:id/summary` | `404 {error:"Entity not found"}` |
| `GET /entities/:id/health` | `404 {error:"Entity not found"}` |
| `GET /entities/:id/roi` | `403 {error:"Forbidden"}` |
| `POST /entities/:id/roi` | `403 {error:"Forbidden"}` |
| `PATCH /entities/:id/status` | `404 {error:"Not found"}` |

**Note:** draft roadmap-এর table এই পাঁচটাকেই "same pattern" (৪০৪
Entity not found) ধরে নিয়েছিল — বাস্তব কোড পড়ে দেখা গেল roi দুটো route
আসলে `403 Forbidden` দেয়, আর status route-এর message ঠিক "Entity not
found" না, "Not found"। প্রতিটার আসল pre-existing body-ই preserve করা
হয়েছে, draft-এর অনুমান না।

`GET /entities/health-overview` (কোনো `:id` param নেই, aggregate-across-
own-entities route) — scope-এর বাইরে, touch হয়নি।

### `value-history.ts` (শুধু vault অংশ, ৩টা route)
| Route | আগের/এখনকার deny body (অপরিবর্তিত) |
|---|---|
| `GET /vault/:id/value-history` | silent — non-owned id → খালি array (`200 []`) |
| `POST /vault/:id/value` | `404 {error:"Entity not found"}` |
| `POST /vault/:id/followers` | `404 {error:"Entity not found"}` |

`GET /local-accounts/:id/value-history` আর `POST /local-accounts/:id/value`
— এই ফাইলেরই বাকি দুই route, `local_accounts` টেবিলের উপর, আলাদা owner
shape — **C22**-এর জন্য অপরিবর্তিত রাখা হয়েছে।

### `vault-entity-links.ts`
শুধু `vaultEntryResource`-এ `export` যোগ করা হয়েছে। বাকি ফাইল
(handler logic, `vaultEntityLinkResource`, নিজস্ব
`requireVaultEntryOwnership()`) অপরিবর্তিত।

## B2 coordination note
`vaultEntryResource` এখন তিনটা ফাইল থেকে ব্যবহৃত হচ্ছে
(`vault-entity-links.ts`, `entities.ts`, `value-history.ts`) — Season B/
Phase B2 `vault.ts`-এর মূল CRUD implement করার সময় এটাই reuse করতে
পারবে, নতুন কিছু বানানোর দরকার নেই। B2 owner-এর সাথে আগে থেকে coordinate
করার সুপারিশ draft roadmap-এই ছিল, এখনো প্রযোজ্য — বিশেষত builder এখন
তিন জায়গায় import হচ্ছে বলে, ভবিষ্যতে শেপ বদলালে সব ক-টা caller-এ প্রভাব
পড়বে।

## Rollout
প্রতিটা route-এর owner-এর success path আর non-owned/nonexistent-id-এর
deny body — দুটোই আগের মতোই অপরিবর্তিত (উপরের টেবিল দুটো দেখুন)। কোনো
নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- তিনটা ফাইলেই bracket-balance script চালানো হয়েছে: `entities.ts` `{}`
  97/97 `()` 191/191; `value-history.ts` `{}` 133/133 `()` 228/228;
  `vault-entity-links.ts` `{}` 95/95 `()` 222/222 — সব শূন্যে মেলে।
- `routes/index.ts`-এ তিনটা router-ই (`entitiesRouter`,
  `valueHistoryRouter`, `vaultEntityLinksRouter`) import + `router.use(...)`
  confirm করা হয়েছে।
- `vault-entity-links.ts` → `entities.ts`/`value-history.ts` import ঠিক
  এক দিকেই, উল্টো দিকে কোনো import নেই — circular import নেই, grep করে
  নিশ্চিত করা হয়েছে।
- গ্রেপ করে নিশ্চিত করা হয়েছে ঠিক সাতটা target route-ই নতুন middleware
  পেয়েছে, `health-overview` আর দুটো `local-accounts` route অপরিবর্তিত
  আছে।
- ম্যানুয়ালি প্রতিটা route-এ verify করা হয়েছে: owner → gate ALLOW →
  handler-এর নিজস্ব query/logic আগের মতোই চলে (roi-এর নিজস্ব inline
  ownership-check query-ও touch করা হয়নি, redundant-but-harmless রাখা
  হয়েছে, C19A-এর নিজস্ব precedent অনুযায়ী)। Non-owner/nonexistent id →
  gate deny → route-এর নিজস্ব pre-existing exact body।

## Sizing note — roadmap আপডেট
C21 সম্পন্ন। বাকি roadmap: C22 (local_accounts value-history, export +
reuse, ২ route) → C23 (vault_shares, ২ route) → C24 (ayzen_mail
dual-owner, নতুন predicate-shape লাগবে, ২ route) → C25 (security.ts +
two-factor.ts mechanical sweep, ৩ route)। মোট বাকি ~৯টা route, ৪টা
ফাইল জুড়ে, ৪টা ফেজে।
