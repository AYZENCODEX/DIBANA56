# OIDC Roadmap — Season 1, Phase 2B-a..2B-f: First-Party Seed Data

## যা আগে থেকেই ছিল
- Phase 2A (2a-a..2a-d) দিয়ে `oidc_clients` টেবিল, তার schema mirror, এবং
  read-only repository layer (`getOidcClientById`, `oidcClientExists`)
  তৈরি হয়ে গেছে — কিন্তু টেবিলে একটাও row ছিল না।
- `CHANGES_SYLO_SUBDOMAIN_SPLIT.md`/`subdomain-app.ts` থেকে জানা যায় AYZEN-এর
  পাঁচটা first-party app কোনগুলো এবং তাদের subdomain কী: Sylo
  (`sylo.ayzen.tech`, ইতিমধ্যে split হয়ে গেছে) এবং Ryft/Wisp/Verve/Zynth
  (`ryft.ayzen.tech` ইত্যাদি, subdomain split এখনো বাকি — কিন্তু app-গুলো
  ইতিমধ্যে নামে চিহ্নিত)।

## যেটা যোগ করা হলো (Phase 2B-a থেকে 2B-f)

### Seed data (2B-a..2B-e)
`scripts/src/seed-oidc-clients.ts` — পাঁচটা first-party client-ই একটামাত্র
idempotent script দিয়ে register করা হয় (roadmap প্রতিটা app-এর জন্য আলাদা
sub-phase-এর নাম দিলেও, কাজটা structurally একটাই "একই shape-এর ৫টা row" —
তাই একটা data-driven script, পাঁচটা আলাদা কাজ না):

| ফিল্ড | মান | কেন |
|---|---|---|
| `client_id` | `sylo` / `ryft` / `wisp` / `verve` / `zynth` | |
| `client_secret_hash` | `NULL` সবগুলোর জন্য | পাঁচটাই browser-served SPA (একই bundle, hostname দিয়ে scoped — দেখুন `subdomain-app.ts`), তাই confidential secret রাখার নিরাপদ জায়গা নেই। PKCE (first-party-দের জন্য roadmap 3.2 অনুযায়ী বাধ্যতামূলক) নিজেই possession-এর প্রমাণ — Phase 2A-a-তেই এই nullable সিদ্ধান্ত নেওয়া হয়েছিল |
| `redirect_uris` | `["https://<client_id>.ayzen.tech/oidc/callback"]` | একটামাত্র production callback। এই route এখনো নেই (Phase 3), কিন্তু migration 079-এর সাথে `/oidc/authorize`-এরও একই সম্পর্ক — registry data flow-এর আগে |
| `allowed_scopes` | `["openid", "profile", "email"]` (সব ৫টাতে একই) | `lib/oidc-discovery.ts`-এর কমেন্টেই বলা আছে `profile`/`email` scope যোগ করা "Phase 2's job (client allowed_scopes registry)" — ঠিক সেই কাজ এখানে করা হলো |
| `is_first_party` | `true` সবগুলোর জন্য | |

**Idempotent:** `INSERT .. ON CONFLICT (client_id) DO UPDATE` — script বারবার
চালানো নিরাপদ (যেমন `SEED_CLIENTS` এডিট করার পর re-run করলে)। **`ON CONFLICT`
আপডেট ইচ্ছাকৃতভাবে `client_secret_hash` টাচ করে না** — কোনো পরবর্তী
out-of-band প্রসেস যদি কোনো client-এর জন্য secret hash সেট করে, একটা reseed
সেটা মুছে দেবে না।

**Usage:** `npx tsx scripts/src/seed-oidc-clients.ts [--dry-run]`

### Seed Verification (2B-f)
`scripts/src/test-seed-oidc-clients.ts` — roadmap-এর ঠিক ৪টা verification
পয়েন্ট কভার করে, কিন্তু **live DB row-এর বদলে `SEED_CLIENTS` array-এর
উপর** (এই পরিবেশে DATABASE_URL নেই, তাই seed script আসলে রান করে তারপর row
পড়ে verify করা সম্ভব হয়নি — একই সীমাবদ্ধতা যা Phase 2A-d-তে "duplicate
client_id"-এর ক্ষেত্রে নোট করা হয়েছিল):

| Roadmap-এর verification | কীভাবে চেক করা হলো |
|---|---|
| unique client IDs | `SEED_CLIENTS`-এর ৫টা `client_id`-এ `Set` size === length |
| exact redirect URIs | প্রতিটা client-এর `redirectUris` ঠিক `https://<client_id>.ayzen.tech/oidc/callback`-এর সাথে deep-equal; স্কিম/হোস্ট আলাদাভাবেও যাচাই |
| expected scopes | প্রতিটা client-এর `allowedScopes` ঠিক `["openid","profile","email"]`-এর সাথে deep-equal |
| first-party flag | প্রতিটা client-এর `isFirstParty === true` |

(বোনাস: `clientSecretHash === null` সবগুলোতে, যদিও roadmap-এ আলাদা
পয়েন্ট হিসেবে নেই — কিন্তু "public/PKCE-only" ডিজাইন সিদ্ধান্তটাই টেস্ট করা
উচিত মনে হলো যেহেতু এটা নিরাপত্তা-সংক্রান্ত।)

"No admin UI" — roadmap-এর এই নির্দেশ মানা হয়েছে, কোনো UI/route যোগ করা
হয়নি, শুধু script + test।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `scripts/src/seed-oidc-clients.ts` | **নতুন ফাইল** — idempotent seed script (2B-a..2B-e) |
| `scripts/src/test-seed-oidc-clients.ts` | **নতুন ফাইল** — seed verification (2B-f) |
| `scripts/package.json` | নতুন scripts যোগ: `oidc:seed-clients`, `oidc:seed-clients:dry-run`, `oidc:test-seed-clients` |

## যা টেস্ট করা হয়েছে
- নতুন ফাইলগুলোর bracket/paren balance চেক করা হয়েছে — সব balanced।
- `test-seed-oidc-clients.ts`-এর প্রতিটা assertion হাতে trace করে ভেরিফাই
  করা হয়েছে `SEED_CLIENTS`-এর actual ডেটার বিপরীতে।
- এই পরিবেশে `node_modules` এবং `DATABASE_URL` কোনোটাই নেই, তাই
  `npx tsx scripts/src/seed-oidc-clients.ts` বাস্তবে চালিয়ে row লেখা এবং
  `test-seed-oidc-clients.ts` রান করে verify করা — কোনোটাই সম্ভব হয়নি।
  Script দুটো `retire-jwt-signing-keys.ts` (Phase 1D-e)-এর
  `main()`/`--dry-run`/`process.exitCode`/`pool.end()` প্যাটার্ন হুবহু
  অনুসরণ করে লেখা হয়েছে, যেটা ইতিমধ্যে working হিসেবে established।

## পরের ধাপ (Phase 2C)
**Client & Redirect URI Validation** (2c-a..2c-e): unknown `client_id`
reject করা, redirect URI exact matching, near-match reject করা (path/scheme/
host/query ভিন্নতা), validation error contract, এবং টেস্ট ম্যাট্রিক্স —
এখন যা Phase 2A-c বানিয়েছে (`getOidcClientById`) তার উপর ভিত্তি করে।
