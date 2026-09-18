# OIDC Roadmap — Season 1, Phase 2A-c/2A-d: Client Repository + Schema Tests

## যা আগে থেকেই ছিল
- Phase 2A-a/2A-b (migration 079) দিয়ে `oidc_clients` টেবিল তৈরি হয়েছে —
  `client_id` (unique), `client_secret_hash` (nullable), `redirect_uris` /
  `allowed_scopes` (JSONB array), `is_first_party`, timestamps। কিন্তু এই
  টেবিল পড়ার/লেখার কোনো কোড ছিল না — শুধু schema/migration।

## যেটা যোগ করা হলো

### Phase 2A-c — Repository/Data Access
`artifacts/api-server/src/lib/oidc-clients.ts` — ঠিক `lib/jwt-keys.ts`-এর
`fetchDbVerificationKeys()`/`mergeVerificationKeys()` split-এর প্যাটার্ন
অনুসরণ করে:
- **`getOidcClientById(clientId)`** — client lookup, raw parameterized
  `pool.query()` দিয়ে। না পাওয়া গেলে বা DB read fail করলে `null` (error
  আলাদাভাবে log হয়)।
- **`oidcClientExists(clientId)`** — existence check, `SELECT 1 ... LIMIT 1`
  দিয়ে আলাদা, ছোট query — শুধু boolean দরকার হলে পুরো row (এবং
  `client_secret_hash`) fetch/map করার খরচ এড়াতে।
- **`mapOidcClientRow()`** / **`toStringArray()`** — safe field mapping:
  Postgres-এর snake_case/JSONB shape থেকে typed `OidcClient` object। JSONB
  column malformed হলে (array না, বা mixed-type array) exception না ছুঁড়ে
  `[]`-এ defensively fallback করে — একটা bad row-এর জন্য পুরো caller ভেঙে
  পড়বে না।

**যা ইচ্ছাকৃতভাবে নেই:** insert/update/delete helper। Roadmap-এর 2A-c task
list-এ শুধু "client lookup; client existence check; safe field mapping" —
এই তিনটাই আছে, তার বেশি না। Phase 2B (seed data) কীভাবে row লিখবে (এই
ফাইলে helper যোগ করে, নাকি সরাসরি seed script-এ SQL দিয়ে) সেটা সেই
ফেজের সিদ্ধান্ত।

**Safety note:** `client_secret_hash` এই ফাইলের `getOidcClientById()`
থেকে real data হিসেবে ফেরত আসে (ভবিষ্যতের token exchange step-এর এটা লাগবে)
— কিন্তু কোথাও log হয় না। warn log-এ শুধু `clientId` যায়, roadmap-এর global
observability rule ("client secrets কখনো log করা যাবে না") মেনে।

### Phase 2A-d — Schema Tests
`scripts/src/test-oidc-clients.ts` — ঠিক `test-verification-keys.ts` /
`test-rotate-jwt-signing-key.ts`-এর মতো: শুধু DB-free pure function টেস্ট,
`npx tsx scripts/src/test-oidc-clients.ts` দিয়ে যেকোনো জায়গায় চালানো যায়।

Roadmap-এর 2A-d টেস্ট-লিস্ট (valid client, duplicate client_id, missing
required data, malformed registry data) DB-free ভাবে যতটা কভার করা যায়:

| Roadmap-এর টেস্ট | কীভাবে কভার হলো |
|---|---|
| valid client | `mapOidcClientRow()` well-formed row-এ; `insertOidcClientSchema` সঠিক payload-এ (confidential + public দুটো ভ্যারিয়েন্ট) |
| missing required data | `insertOidcClientSchema` — `clientId` বাদ দিলে reject |
| malformed registry data | `mapOidcClientRow()`/`toStringArray()` — non-array JSONB, mixed-type array, null; `insertOidcClientSchema` — non-string array element, non-array scope string |
| **duplicate client_id** | **কভার করা যায়নি** — নিচে দেখুন |

**duplicate client_id কেন DB-free টেস্ট করা যায়নি:** এটা pure function-এর
আচরণ না — migration 079-এর `oidc_clients_client_id_idx` UNIQUE index-এর
লাইভ DB আচরণ (দ্বিতীয়বার একই `client_id` INSERT করলে Postgres error 23505
ছুঁড়বে)। এই environment-এ `DATABASE_URL` নেই, তাই সেটা চালিয়ে verify করা
সম্ভব হয়নি — CHANGES_JWT_MULTIKEY_PHASE1C.md-এ একই সীমাবদ্ধতা যেভাবে নোট
করা হয়েছিল, ঠিক সেভাবে migration 079-এর DDL হাতে re-read করে verify করা
হয়েছে (একই `CREATE UNIQUE INDEX` idiom যা `jwt_signing_keys.kid`-এও
প্রমাণিতভাবে কাজ করে)।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-clients.ts` | **নতুন ফাইল** — repository/data-access layer (2A-c) |
| `scripts/src/test-oidc-clients.ts` | **নতুন ফাইল** — schema tests (2A-d) |
| `scripts/package.json` | নতুন script যোগ: `oidc:test-clients` |

## যা টেস্ট করা হয়েছে
- নতুন ফাইলগুলোর bracket/paren balance স্ক্রিপ্ট দিয়ে চেক করা হয়েছে — সব
  balanced।
- `test-oidc-clients.ts`-এর প্রতিটা assertion হাতে trace করে verify করা
  হয়েছে (drizzle-zod-এর `createInsertSchema` + custom refine shape-এর
  আচরণ, `toStringArray()`-এর filter logic)।
- `pool.query<T>()` generic ব্যবহার করা থেকে সরে এসে বাকি কোডবেসের (email.ts,
  login-security.ts, market-config.ts, jwt-keys.ts) সাথে মেলানো হয়েছে —
  কোথাও `pool.query()`-তে generic type param ব্যবহৃত হয় না (pg-এর
  `QueryResultRow` constraint এড়াতে), তাই row-টা query-এর পর cast করা হয়েছে।
- এই পরিবেশে `node_modules` ইনস্টল নেই এবং `DATABASE_URL` সেট নেই (network
  off), তাই `npx tsx scripts/src/test-oidc-clients.ts` বাস্তবে রান করে
  ভেরিফাই করা যায়নি — যেমনটা আগের সব `test-*.ts` ফাইলের ক্ষেত্রেও হয়েছিল
  (দেখুন CHANGES_JWT_MULTIKEY_PHASE1C.md)। ফাইলটা `jwt-keys.ts`/
  `test-verification-keys.ts`-এর ইতিমধ্যে-established import ও structure
  প্যাটার্ন হুবহু অনুসরণ করে লেখা হয়েছে।

## পরের ধাপ
Phase 2A সম্পূর্ণ (2a-a → 2a-d)। পরেরটা **Phase 2B — First-Party Seed Data**:
Sylo/Ryft/Wisp/Verve/Zynth-কে first-party client হিসেবে register করা
(2b-a থেকে 2b-f)।
