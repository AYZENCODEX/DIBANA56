# OIDC Roadmap — Season 1, Phase 1D-a: Verification-Key Abstraction

## যা আগে থেকেই ছিল
- Phase 1A/1B (`lib/jwt-keys.ts`, `lib/jwt.ts`): sign আর verify দুটোই
  `getActiveKeypair()`-এর একটামাত্র env-resolved keypair দিয়ে হতো।
- Phase 1C (migration 078, `jwt_signing_keys` টেবিল): `kid`-indexed retained
  public-key storage যোগ হলো, কিন্তু schema-only — কোনো app code এই টেবিল
  read/write করত না, তাই বাস্তবে টেবিলটা এখনো খালি।
- ফলে rotation করলে এখনো সমস্যা: `AYZEN_JWT_KID` বদলালেই পুরনো `kid` দিয়ে
  সাইন-করা সব টোকেন সাথে সাথে unverifiable — 7 দিনের natural expiry পর্যন্ত
  অপেক্ষা করার সুযোগ নেই।

## যেটা যোগ করা হলো (Phase 1D-a)
`lib/jwt-keys.ts`-এ নতুন **verification-key abstraction** — sign করার key আর
verify করার key(s) resolve করা এখন আলাদা:

- `getVerificationKeys(kid?)` — verify-এর জন্য valid সব key (active +
  retiring, `retired` বাদে) রিটার্ন করে, `jwt_signing_keys` টেবিল থেকে পড়ে;
  `kid` দিলে সেটাতে narrow করে।
- টেবিল read করতে ব্যর্থ হলে (এখনও সংযোগ না থাকা / এরর) silently fallback না
  করে warn log দিয়ে fallback করে single env-resolved active keypair-এ।
- টেবিল খালি হলে (আজকের বাস্তবতা — Phase 1C-এর কোনো write path নেই এখনো)
  একই কারণে fallback করে — তাই বর্তমান আচরণ **অপরিবর্তিত** থাকে।
- `mergeVerificationKeys(dbKeys, envKeypair, kid?)` — pure, I/O-free merge
  logic আলাদা করে বার করা হয়েছে যাতে DB connection ছাড়াই unit-test করা যায়।

`getActiveKeypair()` (signing path) touch করা হয়নি — `signAuthToken()` /
`signOAuthState()` (lib/jwt.ts) আগের মতোই সরাসরি এটা কল করে।

### এই ফেজে যা **নেই** (ইচ্ছাকৃতভাবে — Phase 1D-b/1D-d-এর কাজ)
- `verifyAuthToken()` / `verifyOAuthState()` (lib/jwt.ts) এখনো
  `getActiveKeypair()`-ই কল করে — এই নতুন abstraction-এর সাথে wire করা হয়নি।
  JWT header-এর `kid` অনুযায়ী deterministic lookup + unknown-`kid`
  fail-safe behavior define করা Phase 1D-b-এর কাজ, এখানে preempt করা হয়নি।
- কোনো scheduled/manual rotation trigger নেই (Phase 1D-d)।
- `jwt_signing_keys`-এ কোনো নতুন write path নেই — শুধু read।
- Token claims অপরিবর্তিত। কোনো discovery endpoint যোগ হয়নি।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/jwt-keys.ts` | নতুন exports: `VerificationKey`, `JwtKeyStatus`, `mergeVerificationKeys()` (pure), `getVerificationKeys(kid?)` (DB read + env fallback)। `getActiveKeypair()`, sign path — অপরিবর্তিত। |
| `scripts/src/test-verification-keys.ts` | **নতুন ফাইল** — `mergeVerificationKeys()`-এর জন্য ৬টা assertion-ভিত্তিক unit test (DB connection লাগে না)। |
| `scripts/package.json` | নতুন script: `pnpm --filter @workspace/scripts jwt:test-verification-keys` |

`lib/jwt.ts`, `routes/auth.ts`, `routes/passkey.ts`, `sessions.ts`,
`auth-utils.ts` — এই ফাইলগুলো `getActiveKeypair()` / `verifyAuthToken()` /
`signAuthToken()` ব্যবহার করে, এদের signature বা behavior অপরিবর্তিত, তাই
কোনো পরিবর্তন লাগেনি।

## যা টেস্ট করা হয়েছে
- **Logic tests (পাশ)**: `mergeVerificationKeys()`-এর হুবহু body একটা
  dependency-free `.mjs` ফাইলে বসিয়ে plain `node`-এ চালানো হয়েছে (এই
  sandbox-এ `node_modules` ইনস্টল করা নেই, network off, তাই আসল `tsx`
  চালানো যায়নি) — ৬টা কেসই পাশ করেছে:
  1. খালি DB টেবিল → শুধু env keypair fallback করে।
  2. active + retiring দুটো DB row-ই env key-র পাশাপাশি রিটার্ন হয়।
  3. `retired` row (unfiltered পাস করলেও) কখনো surface করে না।
  4. env-এর নিজের `kid`-এ DB row থাকলে সেটাই জেতে, duplicate হয় না।
  5. `kid` filter দিলে ঠিক সেই key-টাই ফেরত আসে।
  6. অজানা `kid` filter দিলে খালি array — কোনো ভুল key-তে silently
     fallback করে না।
  `scripts/src/test-verification-keys.ts` একই টেস্টগুলো আসল export থেকে
  চালানোর জন্য repo-তে রাখা হয়েছে (`npx tsx scripts/src/test-verification-keys.ts`
  বা `pnpm --filter @workspace/scripts jwt:test-verification-keys`) — dev
  environment-এ node_modules থাকলে সরাসরি চলবে, এখানে চালিয়ে verify করা যায়নি।
- `tsc --noEmit --skipLibCheck` দিয়ে `jwt-keys.ts` standalone চেক করা
  হয়েছে — শুধু প্রত্যাশিত noise (missing `@types/node`, `pino`,
  `@workspace/db` type declarations — dependencies ইনস্টল করা নেই বলে,
  Phase 1A/1C-এও একই situation ছিল), নতুন কোডে কোনো actual syntax/logic
  error পাওয়া যায়নি।
- Import graph গ্রেপ করে দেখা হয়েছে — `jwt-keys.ts`-কে import করে এমন সব
  ফাইল (`jwt.ts`, `sessions.ts`, `auth-utils.ts`, `generate-jwt-keypair.ts`)
  — কেউই নতুন `getVerificationKeys`/`mergeVerificationKeys` এখনো কল করে না,
  তাই existing behavior ভাঙার ঝুঁকি নেই।

## জানা limitation
- `getVerificationKeys()`-এর DB-read অংশ (`fetchDbVerificationKeys`) আসল
  `pool.query` দিয়ে integration-test করা যায়নি (এই sandbox-এ কোনো
  `DATABASE_URL`/DB সংযোগ নেই) — শুধু logic/merge অংশ টেস্ট করা হয়েছে।
  Real DB-এর সাথে (empty টেবিল অবস্থায়) `pnpm --filter @workspace/scripts
  jwt:test-verification-keys` চালিয়ে, এবং সম্ভব হলে ম্যানুয়ালি
  `jwt_signing_keys`-এ একটা টেস্ট row insert করে `getVerificationKeys()` কল
  করে, deploy-এর আগে একবার sanity-check করে নেওয়া ভালো।

## পরের ধাপ (Phase 1D-b)
- `kid`-based verification lookup: `verifyAuthToken()`/`verifyOAuthState()`
  কে `getVerificationKeys(kid)`-এর সাথে wire করা।
- Known `kid` → deterministic resolve; unknown `kid` → নিরাপদে fail (কোনো
  ভুল key-তে fallback না করে)।
- দুই পথই (known + unknown `kid`) covering test যোগ করা।
