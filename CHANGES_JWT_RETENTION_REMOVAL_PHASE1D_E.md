# OIDC Roadmap — Season 1, Phase 1D-e: Retention & Removal Policy

## যা আগে থেকেই ছিল
- Phase 1D-d (`rotate-jwt-signing-key.ts`): rotation-এর সময় outgoing key-কে
  `retiring`-এ নিয়ে যায়, কিন্তু কখনো `retired` লেখে না — সেই সিদ্ধান্তটা
  ইচ্ছাকৃতভাবে এই ফেজের (1D-e) জন্য রাখা হয়েছিল।
- Phase 1D-c (`canVerify()`): `retiring` key যতদিন ইচ্ছা verify করতে পারে,
  কিন্তু "কতদিন নিরাপদ" — সেই নির্দিষ্ট সময়সীমা কোথাও define করা ছিল না।
- Migration 078 (`jwt_signing_keys`): DELETE ট্রিগার দিয়ে ব্লক করা —
  কখনোই row মুছে যায় না, শুধু `status`/`retired_at` বদলাতে পারে।

## যেটা যোগ করা হলো (Phase 1D-e)

### `lib/jwt-keys.ts`-এ retention policy (pure)
- **`MAX_TOKEN_LIFETIME_MS`** — 7 দিন, `lib/jwt.ts`-এর `signAuthToken()`-এর
  `DEFAULT_EXPIRY` ("7d")-এর সাথে ম্যানুয়ালি sync রাখা constant (circular
  import এড়াতে; `test-rotation-lifecycle.ts`-এ এই দুইটা মিলছে কিনা assert
  করা হয়েছে)।
- **`CLOCK_SKEW_ALLOWANCE_MS`** — 10 মিনিট, DB সার্ভার আর app host-এর মধ্যে
  clock drift-এর জন্য buffer।
- **`RETENTION_PERIOD_MS`** = দুটোর যোগফল — একটামাত্র জায়গা যেখান থেকে বাকি
  সব ফাংশন "কতদিন" প্রশ্নের উত্তর নেয়।
- **`retirementEligibleAt(retiringAt)`** — pure: `retiringAt +
  RETENTION_PERIOD_MS`।
- **`isRetirementSafe(retiringAt, now?)`** — pure, boundary inclusive (ঠিক
  `retirementEligibleAt()`-এর মুহূর্তেই safe হয়ে যায়, তার আগে না)।
- **`planRetirement(retiringRows, now?)`** — pure planning step: প্রতিটা
  `retiring` row-এর জন্য এখনই retire করা নিরাপদ কিনা, নাহলে কবে নিরাপদ হবে
  (`eligibleAt`) — এটাই "premature removal ব্লক করা" গ্যারান্টিটার আসল জায়গা,
  কারণ কোনো caller-এরই `planRetirement()`-এর `safe: true` ছাড়া `retired`
  লেখার আর কোনো পথ নেই।

### `scripts/src/retire-jwt-signing-keys.ts` — **নতুন ফাইল**, দ্বিতীয় write path
`rotate-jwt-signing-key.ts`-এর মতোই একটা ম্যানুয়াল CLI script, কিন্তু উল্টো
দিকের কাজ করে:
- শুধু `status = 'retiring'` row পড়ে (কখনো `active` row টাচ করে না — SQL
  filter-এই বাদ)।
- `planRetirement()` দিয়ে ঠিক করে কোনগুলো এখনই retire করা নিরাপদ।
- প্রতিটা eligible row-এর জন্য আলাদা transaction-এ
  `UPDATE ... SET status = 'retired', retired_at = NOW() WHERE kid = $1 AND
  status = 'retiring'` — `rowCount !== 1` হলে (কেউ ইতিমধ্যে বদলে দিয়েছে)
  সেই একটাকে skip করে, বাকিগুলো আটকায় না।
- `--dry-run`: শুধু plan প্রিন্ট করে, কিছু লেখে না।
- Not-yet-eligible row-গুলোর জন্য কবে eligible হবে সেটা প্রিন্ট করে।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/jwt-keys.ts` | নতুন exports: `MAX_TOKEN_LIFETIME_MS`, `CLOCK_SKEW_ALLOWANCE_MS`, `RETENTION_PERIOD_MS`, `RetiringKeyRow`, `retirementEligibleAt()`, `isRetirementSafe()`, `RetirementDecision`, `planRetirement()`। আগের সব export (`getActiveKeypair`, `getVerificationKeys`, `resolveVerificationKeys`, `mergeVerificationKeys`, `canSign`, `canVerify`, ...) — অপরিবর্তিত। |
| `scripts/src/retire-jwt-signing-keys.ts` | **নতুন ফাইল** — `status='retired'`-এর প্রথম write path। |
| `scripts/src/test-retire-jwt-signing-keys.ts` | **নতুন ফাইল** — retention constant/boundary/planning-এর জন্য ১১টা assertion। |
| `scripts/package.json` | নতুন scripts: `jwt:retire`, `jwt:retire:dry-run`, `jwt:test-retire`। |

`lib/jwt.ts`, `rotate-jwt-signing-key.ts` — টাচ করা হয়নি এই ফেজে।

## যা টেস্ট করা হয়েছে
- **আসল `tsx` দিয়ে সরাসরি চালানো (পাশ, dependency-free .mjs না)** — আগের
  ফেজগুলোতে (1D-a থেকে 1D-d) `@workspace/db`/`pino` resolve করতে না পারায়
  শুধু pure logic-এর body আলাদা `.mjs`-এ কপি করে টেস্ট করা হয়েছিল। এই ফেজে
  একটা লোকাল, sandbox-only stub প্যাকেজ বসানো হয়েছে
  (`node_modules/@workspace/db`, `node_modules/pino` — শুধু import resolve
  করার জন্য, বাস্তব DB/logging কিছু করে না; বাস্তব DB call করলে জোরে error
  থ্রো করে) যাতে **আসল ফাইল, আসল import গ্রাফ দিয়েই** `npx tsx
  scripts/src/test-retire-jwt-signing-keys.ts` চালানো যায় — কোনো body কপি
  করা লজিক না। ১১টা assertion-ই পাশ করেছে (constant relationship, boundary
  inclusive/exclusive দুই দিকেই, mix eligible/not-yet-eligible split, empty
  input, default clock)।
- `tsc --noEmit --strict` (isolated config, project tsconfig ছাড়া) দিয়ে
  `jwt-keys.ts`, `jwt.ts`, `retire-jwt-signing-keys.ts`,
  `test-retire-jwt-signing-keys.ts`, `rotate-jwt-signing-key.ts` — সবগুলো
  চেক করা হয়েছে — শুধু প্রত্যাশিত noise (`@types/node`, `jsonwebtoken`,
  `pino` type declarations ইনস্টল করা নেই), নতুন কোডে কোনো actual
  syntax/logic error পাওয়া যায়নি।
- Import graph গ্রেপ করে দেখা হয়েছে — `planRetirement`/`isRetirementSafe`/
  `retirementEligibleAt`/`RETENTION_PERIOD_MS` এর আগে কোথাও ব্যবহার হতো না
  (নতুন); `retire-jwt-signing-keys.ts` ছাড়া অন্য কোনো ফাইল
  `status = 'retired'` লেখে না।

## জানা limitation
- আসল DB-তে (empty টেবিল, তারপর একটা real `retiring` row, boundary সময়
  পার হওয়ার আগে আর পরে দুইবার script চালিয়ে) — এই sandbox-এ
  integration-test করা যায়নি (network off, কোনো `DATABASE_URL` নেই)। শুধু
  pure planning function-গুলো (যেগুলো আসল সিদ্ধান্তটা নেয়) real execution-এ
  টেস্ট হয়েছে।
- `RETENTION_PERIOD_MS` আজকে `lib/jwt.ts`-এর `DEFAULT_EXPIRY`-এর সাথে
  ম্যানুয়ালি sync রাখা একটা duplicate constant — সেই দুইটা future-এ কেউ
  আলাদা বদলে ফেললে চুপচাপ drift করবে; `test-rotation-lifecycle.ts` (1D-f)
  একটা assertion দিয়ে এটা ধরে, কিন্তু compile-time guarantee না।

## পরের ধাপ (Phase 1D-f)
- সম্পূর্ণ rotation lifecycle একসাথে verify করা: old key signs → new key
  introduced → new tokens নতুন kid ব্যবহার করে → old tokens পুরনো key দিয়ে
  verify হয় → unknown kid fail করে → old key eventually removable হয় →
  removed key আর verify করে না। Phase 1d DONE শুধু এই টেস্টগুলো পাশ করলেই।
