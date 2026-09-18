# OIDC Roadmap — Season 1, Phase 1D-d: Rotation Trigger

## যা আগে থেকেই ছিল
- Phase 1C (migration 078, `jwt_signing_keys`): schema-only, কোনো write path
  ছিল না — টেবিলটা বাস্তবে খালি।
- Phase 1D-a/1D-b (`getVerificationKeys()`, `resolveVerificationKeys()`):
  verify পথ multi-key aware আর `kid`-deterministic হলো, কিন্তু কিছু লেখার
  জায়গা ছিল না।
- Phase 1D-c (`canSign()`, `canVerify()`): কোন state সাইন/verify করতে পারে
  তার rule explicit হলো, কিন্তু কোনো caller `canSign()` আসলে ব্যবহার
  করছিল না — সাইনিং তখনও শুধু env-resolved `getActiveKeypair()` দিয়ে হতো।

## যেটা যোগ করা হলো (Phase 1D-d)
`scripts/src/rotate-jwt-signing-key.ts` — একটা ম্যানুয়াল rotation script,
`jwt_signing_keys`-এ প্রথম **write path**:

- **`planRotation(dbActiveRows, envKid)`** — pure decision function (কোনো
  I/O না, কোনো key generate করে না): বর্তমান DB state আর env-এর
  `AYZEN_JWT_KID` দেখে ঠিক করে rotation নিরাপদ কিনা, আর নিরাপদ হলে কোন
  mode-এ:
  - **০টা active DB row** → `bootstrap` mode। আজকের বাস্তবতা (1C-এর কোনো
    write path ছিল না) — outgoing row সরাসরি `retiring` হিসেবে লেখা হয়
    (কখনো transiently `active` না হয়ে)।
  - **১টা active DB row, kid env-এর সাথে মেলে** → `retire-existing` mode,
    স্বাভাবিক কেস।
  - **১টা active DB row, kid env-এর সাথে মেলে না** → **refuse**। এর মানে
    DB আর env-এর "active" ধারণা আগে থেকেই আলাদা হয়ে গেছে — অন্ধভাবে
    rotate করলে ভুল row retire হয়ে যেত।
  - **১-এর বেশি active DB row** → **refuse**। `jwt_signing_keys_single_active`
    (migration 078)-এর এটা হওয়ার কথাই না; হয়ে গেলে সেটার উপর rotate করা
    বিপদ বাড়াবে, কমাবে না (Phase 1D-c-এর `warnIfMultipleActive()`-এর
    concept-টাই এখানে refuse-এ রূপ নিলো)।
- আসল rotation (dry-run না হলে): নতুন RSA-2048 keypair + নতুন `kid`
  generate (Phase 1A-এর `generate-jwt-keypair.ts`-এর same generation),
  তারপর **একটাই DB transaction**-এ:
  1. outgoing row → `retiring` (bootstrap হলে নতুন insert, নাহলে
     `UPDATE ... WHERE kid = $1 AND status = 'active'`, `rowCount !== 1`
     হলে concurrent change ধরে নিয়ে abort/rollback);
  2. নতুন row → `active` insert।
  ব্যর্থ হলে পুরোটাই rollback — আংশিক state কখনো থাকে না।
- সফল হলে নতুন `AYZEN_JWT_PRIVATE_KEY`/`AYZEN_JWT_PUBLIC_KEY`/`AYZEN_JWT_KID`
  প্রিন্ট হয় (ঠিক `generate-jwt-keypair.ts`-এর মতোই ফরম্যাটে) — পরের ধাপ
  স্পষ্টভাবে লেখা: env var আপডেট করে restart করলেই সাইনিং নতুন `kid`-এ যাবে।
- `--dry-run` ফ্ল্যাগ: শুধু বর্তমান DB state validate করে plan প্রিন্ট করে,
  কোনো key generate/write হয় না।

### কেন সাইনিং এখনো বদলায় না (ইচ্ছাকৃতভাবে)
`signAuthToken()`/`signOAuthState()` (lib/jwt.ts) এখনো শুধু
`getActiveKeypair()`-এর env-resolved keypair দিয়ে সাইন করে — কোনোদিনই
`jwt_signing_keys` পড়ে না। এই sub-phase সাইনিং পথে হাত দেয়নি (roadmap-এর
"Do not: add admin UI; implement automatic scheduling yet" অনুযায়ী scope
tighter রাখা হলো)। তাই rotation বাস্তবে দুই ধাপে হয়:
1. এই script চালানো — DB row লেখে, নতুন env values প্রিন্ট করে।
2. অপারেটর env var আপডেট করে app restart করে — তখনই আসলে নতুন `kid` দিয়ে
   সাইন হওয়া শুরু হয়।

Verification যদিও ধাপ ১-এর পরপরই নতুন `kid` accept করা শুরু করে দেয় (আর old
`kid`-ও verify করতেই থাকে) — কারণ `resolveVerificationKeys()`-এর cache
(Phase 1D-b) DB থেকেই self-heal করে। এটাই roadmap-এর "old tokens remain
verifiable during grace" শর্তটা পূরণ করে, ধাপ ২ হওয়ার আগেও।

### এই ফেজে যা **নেই** (ইচ্ছাকৃতভাবে — Phase 1D-e-এর কাজ)
- Admin UI — নেই, CLI script-ই।
- Automatic/scheduled rotation — নেই, সম্পূর্ণ ম্যানুয়াল।
- Retention duration — `retiring` কতদিন পর `retired` হওয়া নিরাপদ, clock-skew
  allowance, ইত্যাদি — Phase 1D-e।
- এই script কখনো `status = 'retired'` লেখে না।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `scripts/src/rotate-jwt-signing-key.ts` | **নতুন ফাইল** — `planRotation()` (pure) + CLI entrypoint (`main()`) যেটা `@workspace/db`-এর `pool` দিয়ে transaction-এ DB পড়ে/লেখে, `lib/jwt-keys.ts`-এর `getActiveKeypair()`/`canSign()` import করে। |
| `scripts/src/test-rotate-jwt-signing-key.ts` | **নতুন ফাইল** — `planRotation()`-এর জন্য ৫টা assertion-ভিত্তিক unit test। |
| `scripts/package.json` | নতুন scripts: `jwt:rotate`, `jwt:rotate:dry-run`, `jwt:test-rotate`। |

`lib/jwt-keys.ts`, `lib/jwt.ts` — টাচ করা হয়নি এই ফেজে। `canSign()` (1D-c)
প্রথমবার একটা real caller পেলো (`planRotation()`-এর ভেতরে একটা
self-consistency assertion হিসেবে), কিন্তু তার নিজের export/behavior
অপরিবর্তিত।

## যা টেস্ট করা হয়েছে
- **Logic tests (পাশ)**: `planRotation()`-এর হুবহু body একটা dependency-free
  `.mjs` ফাইলে বসিয়ে plain `node`-এ চালানো হয়েছে (আগের ফেজগুলোর মতোই এই
  sandbox-এ `node_modules`/DB নেই) — ৫টা কেসই পাশ করেছে:
  1. ০টা active row → bootstrap mode, সঠিক outgoing kid।
  2. ১টা active row, kid মিললে → retire-existing mode।
  3. ১টা active row, kid না মিললে → refuse, reason-এ "diverged" শব্দটা থাকে।
  4. ১-এর বেশি active row → refuse, reason-এ "expected at most one" থাকে।
  5. পরপর দুইবার (bootstrap তারপর একই kid-এ retire-existing) দুটোই ঠিকভাবে
     resolve হয়।
  `scripts/src/test-rotate-jwt-signing-key.ts` একই কেসগুলো আসল export থেকে
  চালানোর জন্য repo-তে রাখা হয়েছে (`npx tsx
  scripts/src/test-rotate-jwt-signing-key.ts`) — dev environment-এ
  node_modules থাকলে সরাসরি চলবে, এখানে চালিয়ে verify করা যায়নি।
- `tsc --noEmit --skipLibCheck` (আসল ফোল্ডার-স্ট্রাকচার মিরর করা isolated
  temp dir-এ, relative import path ঠিক রাখতে) দিয়ে `jwt-keys.ts`, `jwt.ts`,
  `rotate-jwt-signing-key.ts`, `test-rotate-jwt-signing-key.ts` — সবগুলো
  চেক করা হয়েছে — শুধু প্রত্যাশিত noise (missing `@types/node`,
  `@workspace/db` type declarations), নতুন কোডে কোনো actual syntax/logic
  error পাওয়া যায়নি। `pool.connect()`/`pool.query<T>()`/transaction
  কল-সিকোয়েন্স আর discriminated union (`RotationPlan`) — সবই typecheck করে।
- **DB write path (integration) টেস্ট করা যায়নি** — এই sandbox-এ
  `DATABASE_URL`/DB connection নেই (network off), তাই আসল
  `BEGIN`/`UPDATE`/`INSERT`/`COMMIT` sequence, `jwt_signing_keys_single_active`
  constraint-এর সাথে interaction, concurrent-write `rowCount !== 1` path —
  এগুলো বাস্তব DB-তে চালিয়ে দেখা হয়নি।
- Import graph গ্রেপ করে দেখা হয়েছে — `jwt_signing_keys` টেবিল আজ পর্যন্ত
  কোনো app code পড়ে/লেখে না (schema definition আর এই নতুন script ছাড়া),
  তাই এই script-এর প্রথম write path হওয়ার দাবিটা সঠিক। `lib/db/src/schema/
  jwt-signing-keys.ts`-এর কলাম নাম (`kid`, `public_key`, `algorithm`,
  `status`, `retiring_at`) script-এর raw SQL-এর সাথে হাতে মিলিয়ে দেখা
  হয়েছে।

## জানা limitation
- আসল DB-তে rotation চালিয়ে (empty table থেকে bootstrap, তারপর দ্বিতীয়
  rotation retire-existing mode-এ, তারপর একটা real token সাইন-verify
  round-trip পুরনো আর নতুন `kid` দিয়ে) — এই sandbox-এ integration-test করা
  যায়নি। Deploy-এর আগে staging-এ একবার পূর্ণ চক্র (rotate → env আপডেট →
  restart → নতুন লগইন নতুন kid দিয়ে সাইন হচ্ছে কিনা → পুরনো session টোকেন
  এখনো verify হচ্ছে কিনা) manually sanity-check করা ভালো — এটাই Phase
  1D-f-এর পূর্ণাঙ্গ integration test-এর কাজ।
- Concurrent rotation (দুইজন একসাথে script চালালে) আংশিকভাবে handle করা
  হয়েছে (`rowCount !== 1` চেক outgoing row retire করার সময়) কিন্তু দুইটা
  rotation যদি ঠিক একই মুহূর্তে bootstrap mode-এ ঢোকে (দুটোই ০টা active row
  দেখে), দুটোই একটা করে নতুন 'active' row insert করার চেষ্টা করবে —
  `jwt_signing_keys_single_active` partial unique index দ্বিতীয়টাকে
  transaction-level এ reject করবে (constraint violation → catch → rollback),
  কিন্তু প্রথমটার outgoing-row insert ইতিমধ্যে গিয়ে থাকতে পারে যদি দ্বিতীয়টা
  আগে commit করে ফেলে — এই narrow race window আজকে defend করা হয়নি
  (single-operator ম্যানুয়াল script হওয়ায় বাস্তবে low-risk, কিন্তু worth
  জানা)।

## পরের ধাপ (Phase 1D-e)
- Retention & Removal Policy: `retiring` key কতদিন verify করার কথা থাকা
  উচিত (max token lifetime + clock-skew allowance হিসাব করে), আর কবে সেটা
  নিরাপদে `retired`-এ move করা যায় — এবং early removal যেন block হয়।
