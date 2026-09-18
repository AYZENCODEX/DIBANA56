# OIDC Roadmap — Season 1, Phase 2A-a/2A-b: Client Registry Table Design + Migration

## যা আগে থেকেই ছিল
- Phase 1 (1a–1e, migration 078 পর্যন্ত) দিয়ে crypto foundation সম্পূর্ণ —
  RS256 signing, key rotation, JWKS, `/.well-known/*` discovery — সবই আছে।
- কিন্তু **কোনো OIDC client registry নেই**। কোন `client_id` বৈধ, তার কোন
  `redirect_uri`-তে ফেরত পাঠানো নিরাপদ, কোন scope রিকোয়েস্ট করতে পারবে —
  এসবের কোনো durable রেকর্ড ছিল না। আজ প্রতিটা first-party app (Sylo, Ryft,
  Wisp, Verve, Zynth) `*.ayzen.tech`-জুড়ে shared httpOnly cookie দিয়ে চলে,
  কোনো real Authorization Code flow নেই।

## যেটা যোগ করা হলো (Phase 2A-a + 2A-b)
শুধু **table design + migration** — নতুন `oidc_clients` টেবিল।

### কলাম (roadmap 2A-a স্পেক অনুযায়ী)
| কলাম | টাইপ | নোট |
|---|---|---|
| `client_id` | TEXT, unique | পাবলিক আইডেন্টিফায়ার, যেমন `"sylo"` |
| `client_secret_hash` | TEXT, nullable | hashed, plaintext কখনো না। Nullable কেন — নিচে দেখুন |
| `redirect_uris` | JSONB array | exact-match allow-list (validation আসবে 2C-তে) |
| `allowed_scopes` | JSONB array | validation আসবে 2D-তে |
| `is_first_party` | BOOLEAN | default `false` |
| `created_at` / `updated_at` | TIMESTAMP | |

### ডিজাইন সিদ্ধান্ত
- **`client_secret_hash` nullable কেন:** roadmap-এর global security section
  (3.2) অনুযায়ী সব first-party client-এর জন্য PKCE বাধ্যতামূলক। PKCE-ই
  possession-এর প্রমাণ দেয়, তাই public client (secret ছাড়া) হওয়াটা বৈধ একটা
  case। Sylo/Ryft/ইত্যাদি আসলে confidential না public হবে — সেই সিদ্ধান্ত
  Phase 2B-এর (seed data), এই টেবিল শুধু দুটো case-ই সাপোর্ট করে।
- **`redirect_uris` / `allowed_scopes` JSONB array, native Postgres
  `TEXT[]` না:** এই কোডবেসে ইতিমধ্যে `api_keys.scopes` কলাম JSONB array
  হিসেবে আছে (কোনো native array column এখনো ব্যবহৃত হয়নি) — সেই একই
  প্যাটার্ন অনুসরণ করা হলো, নতুন কোনো column-style ইন্ট্রোডিউস না করে।
- **Surrogate `id SERIAL PRIMARY KEY` + unique `client_id`:** `jwt_signing_keys`
  (migration 078)-এর `id` + unique `kid` প্যাটার্নের সাথে সামঞ্জস্যপূর্ণ,
  বদলে `client_id`-কে সরাসরি PK না করে।
- **কোনো delete-guard trigger নেই:** `jwt_signing_keys`/`encryption_keys`-এর
  মতো append-only audit table না এটা — client registry mutable (secret
  rotate হতে পারে, redirect_uris আপডেট হতে পারে), তাই সেই ধরনের trigger এখানে
  প্রযোজ্য না।

### এই ফেজে যা **নেই** (ইচ্ছাকৃতভাবে — পরের sub-phase-গুলোর কাজ)
- কোনো seed row নেই — Sylo/Ryft/Wisp/Verve/Zynth রেজিস্টার করা হয়নি (Phase 2B)
- কোনো repository/data-access ফাংশন নেই (Phase 2A-c)
- কোনো client lookup / redirect URI validation নেই (Phase 2C)
- কোনো scope validation নেই (Phase 2D)
- `/oidc/authorize` বা অন্য কোনো route এই টেবিল read/write করে না

### Rollback strategy (2A-b-এর "rollback strategy is understood" শর্ত)
এই কোডবেসে কোনো migration-এর জন্য আলাদা down/rollback ফাইলের precedent নেই
(078 পর্যন্ত সবগুলোই forward-only)। এই migration-ও একই ধারা মেনে চলে।
রোলব্যাক দরকার হলে:
```sql
DROP INDEX IF EXISTS oidc_clients_client_id_idx;
DROP TABLE IF EXISTS oidc_clients;
```
নিরাপদ, কারণ এখনো কোনো app code এই টেবিল read/write করে না এবং কোনো foreign
key এর উপর নির্ভর করে না — existing data (users, sessions, ইত্যাদি) অপ্রভাবিত
থাকে।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `migrations/079_ayzen_oidc_clients.sql` | **নতুন migration** — `oidc_clients` টেবিল তৈরি + unique index on `client_id` |
| `lib/db/src/schema/oidc-clients.ts` | **নতুন ফাইল** — উপরের টেবিলের drizzle mirror + `InsertOidcClient`/`OidcClientRow` টাইপ |
| `lib/db/src/schema/index.ts` | নতুন schema export যোগ |

## যা টেস্ট করা হয়েছে
- নতুন/edited ফাইলের bracket/paren balance স্ক্রিপ্ট দিয়ে চেক করা হয়েছে
  (`oidc-clients.ts`, `schema/index.ts`) — সব balanced।
- Migration SQL-এর paren balance এবং কলাম/constraint প্রতিটা হাতে ভেরিফাই
  করা হয়েছে; `078`-এর প্রমাণিত pattern (`CREATE TABLE IF NOT EXISTS` +
  `CREATE UNIQUE INDEX IF NOT EXISTS`) হুবহু অনুসরণ করা হয়েছে।
- এই পরিবেশে `node_modules` ইনস্টল নেই (network off), তাই `drizzle-kit push`
  বা `tsc` দিয়ে সরাসরি compile/push যাচাই করা যায়নি — schema ফাইল
  `jwt-signing-keys.ts`-এর (ইতিমধ্যে working) ইম্পোর্ট ও প্যাটার্ন হুবহু
  অনুসরণ করে লেখা হয়েছে, `drizzle-zod@0.8.3`-এর `createInsertSchema(table,
  refineShape)` API অনুযায়ী।
- Phase 2A-d ("Schema Tests" — valid client, duplicate `client_id`, missing
  required data, malformed registry data) **ইচ্ছাকৃতভাবে এই sub-phase-এ করা
  হয়নি** — roadmap-এ এটা আলাদা sub-phase হিসেবেই তালিকাভুক্ত।

## পরের ধাপ (Phase 2A-c, তারপর 2A-d)
- 2A-c: repository/data-access — client lookup, existence check, safe field
  mapping
- 2A-d: schema tests — valid client, duplicate `client_id`, missing data,
  malformed registry data
- এরপর Phase 2B: Sylo/Ryft/Wisp/Verve/Zynth first-party seed data
