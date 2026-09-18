# OIDC Roadmap — Season 1, Phase 1D-b: kid-Based Verification Lookup

## যা আগে থেকেই ছিল
- Phase 1D-a: `lib/jwt-keys.ts`-এ `getVerificationKeys(kid?)` (async,
  DB-backed) আর `mergeVerificationKeys()` (pure merge) যোগ হলো — কিন্তু
  `lib/jwt.ts`-এর `verifyAuthToken()` / `verifyOAuthState()` তখনও পুরনো
  `getActiveKeypair()`-ই সরাসরি কল করত, নতুন abstraction-এর সাথে wire করা
  হয়নি (ইচ্ছাকৃতভাবে — 1D-a-এর scope-এর বাইরে)।
- ফলে verify পথ তখনও effectively single-key ছিল, আর কোনো token-এর `kid`
  header দেখেই না — যেকোনো valid RS256 signature (active env keypair দিয়ে)
  পাশ করে যেত, `kid` মিলুক বা না মিলুক।

## যেটা যোগ করা হলো (Phase 1D-b)
`lib/jwt.ts`-এর verify পথ এখন **deterministic, kid-based**:

- `decodeHeader(token)` — টোকেনের `alg`/`kid` header পড়ে (signature verify
  না করেই — শুধু কোন key(s) ট্রাই করতে হবে বোঝার জন্য)।
- `tryVerifyRs256(token, kid)` — `resolveVerificationKeys(kid)`
  (`lib/jwt-keys.ts`) যা যা key রিটার্ন করে, একে একে সেগুলো দিয়ে ট্রাই করে;
  প্রথমটা যেটা verify হয় সেটাই রিটার্ন হয়।
- `resolveVerificationKeys(kid?)` (নতুন, `jwt-keys.ts`-এ) — **সিঙ্ক্রোনাস**
  lookup, in-memory cache থেকে পড়ে (`lib/vault-crypto.ts`-এর
  `loadKeyManager()`-এর একই pattern — async load, sync read, self-heal)।
  - পরিচিত `kid` → ঠিক সেই key resolve হয়।
  - অপরিচিত `kid` → খালি array, **কখনোই** অন্য কোনো (যেমন active env) key-তে
    fallback করে না — এটাই "unknown kid নিরাপদে fail করে" behavior।
  - `kid` না দিলে → সব বৈধ key রিটার্ন হয় (legacy/`kid`-বিহীন টোকেনের জন্য,
    Phase 1D আগের মতোই permissive)।
  - Cache লোড হওয়ার আগের সংক্ষিপ্ত window-এও (process শুরুর প্রথম কয়েক কল)
    এই একই discipline বজায় থাকে — শুধু active env keypair-এর নিজের `kid`
    ছাড়া অন্য কোনো `kid` তখনও resolve হয় না।

**Sync থাকা জরুরি ছিল কেন**: `getVerificationKeys()` (1D-a) async, কারণ DB
পড়ে। কিন্তু `verifyAuthToken()`/`verifyOAuthState()` codebase জুড়ে
synchronous ভাবে call হয় (routes/auth.ts, auth-utils.ts,
vault-backup-cloud.ts — কোথাও `await` নেই)। এদের async বানালে পুরো call
chain-টাই async করতে হতো — সেটা "one sub-phase"-এর scope না, তাই
`resolveVerificationKeys()`-এর মতো একটা sync, cached layer যোগ করা হলো,
ঠিক `vault-crypto.ts`-এর `loadKeyManager()`/`dekCache` যেভাবে কাজ করে সেভাবেই।

### এই ফেজে যা **নেই** (ইচ্ছাকৃতভাবে — Phase 1D-c/1D-d-এর কাজ)
- Key lifecycle state machine (ACTIVE → RETIRING → GRACE → REMOVED) — এখনও
  শুধু DB-এর `active`/`retiring`/`retired` কলাম যা 1C দিয়েছে তাই ব্যবহার
  হচ্ছে, কোনো নতুন state semantics যোগ হয়নি।
- Rotation trigger/script — 1D-d।
- Boot-time cache warm-up (`index.ts`-এ `loadVerificationKeyCache()` কল করা)
  — যোগ করা হয়নি, cache lazily প্রথম call-এই self-heal করে; explicit
  boot-wiring ইচ্ছাকৃতভাবে বাদ রাখা হলো কারণ সেটা `index.ts` touch করত।
- Token claims অপরিবর্তিত, কোনো discovery endpoint নেই।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/jwt-keys.ts` | নতুন exports: `resolveVerificationKeys(kid?)` (sync, cached), `loadVerificationKeyCache()` (async cache populate, self-heal), `__resetVerificationKeyCacheForTests()` (টেস্ট-only)। `getActiveKeypair()`, `getVerificationKeys()` (1D-a) — অপরিবর্তিত। |
| `artifacts/api-server/src/lib/jwt.ts` | `verifyAuthToken()`/`verifyOAuthState()` এখন `getActiveKeypair()`-এর বদলে `resolveVerificationKeys()` কল করে, টোকেনের `kid` header দিয়ে; নতুন হেল্পার `decodeHeader()`, `tryVerifyRs256()`। `signAuthToken()`/`signOAuthState()` — অপরিবর্তিত, সবসময়ের মতো `getActiveKeypair()` কল করে সাইন করে। Function signature (sync, `string \| null` রিটার্ন) অপরিবর্তিত। |
| `scripts/src/test-resolve-verification-keys.ts` | **নতুন ফাইল** — `resolveVerificationKeys()`-এর জন্য ৫টা টেস্ট (পরিচিত/অপরিচিত `kid`, cache-লোডের আগে ও পরে দুটোই)। |
| `scripts/package.json` | নতুন script: `pnpm --filter @workspace/scripts jwt:test-resolve-verification-keys` |

`routes/auth.ts`, `lib/auth-utils.ts`, `lib/vault-backup-cloud.ts` — এই
ফাইলগুলো `verifyAuthToken()`/`verifyOAuthState()` কল করে, সবগুলোই
synchronous (`await` কোথাও নেই) — grep করে confirm করা হয়েছে, কোনো call
site পরিবর্তন লাগেনি কারণ function signature-ই বদলায়নি।

## যা টেস্ট করা হয়েছে
- **Logic tests (পাশ)**: `resolveVerificationKeys()`-এর cache-lookup logic
  হুবহু আসল implementation-এর মতো একটা dependency-free `.mjs`-এ বসিয়ে plain
  `node`-এ চালানো হয়েছে (এই sandbox-এ `node_modules`/DB নেই) — ৭টা কেসই
  পাশ করেছে:
  1. Cache-লোডের আগে, পরিচিত (env-এর নিজের) `kid` → ঠিক সেই key resolve হয়।
  2. Cache-লোডের আগে, অপরিচিত `kid` → খালি — env key-তেও fallback করে না।
  3. Cache-লোডের আগে, `kid` না দিলে → env key permissively রিটার্ন হয়।
  4. Cache-লোডের পরে, পরিচিত `kid` (একটা `retiring` key, active থেকে
     আলাদা) → সঠিকভাবে resolve হয়।
  5. Cache-লোডের পরে, অপরিচিত `kid` → খালি, active key-তে fallback করে না।
  6. একটা `retired` `kid` (cache-এ কখনোই ঢোকেনি, কারণ
     `getVerificationKeys()` সেটা বাদ দেয়) → খালি।
  7. Cache-লোডের পরে, `kid` না দিলে → সব বৈধ key (২টা) রিটার্ন হয়।
  `scripts/src/test-resolve-verification-keys.ts` একই কেসগুলো (real DB সহ)
  আসল export থেকে চালানোর জন্য repo-তে রাখা হয়েছে — এখানে চালানো যায়নি।
- `tsc --noEmit --skipLibCheck` দিয়ে `jwt.ts`, `jwt-keys.ts`, নতুন test
  script — সবগুলো standalone চেক করা হয়েছে; শুধু প্রত্যাশিত noise (missing
  `@types/node`, `jsonwebtoken`, `pino`, `@workspace/db` type declarations —
  dependencies ইনস্টল করা নেই), নতুন কোডে কোনো actual syntax/logic error
  পাওয়া যায়নি।
- Import graph গ্রেপ করে দেখা হয়েছে — `verifyAuthToken`/`verifyOAuthState`
  যত জায়গায় call হয় (`routes/auth.ts` ৩ জায়গায়, `lib/auth-utils.ts` ২
  জায়গায়, `lib/vault-backup-cloud.ts` ১ জায়গায়) — কোথাও `await` নেই,
  function এখনও sync, তাই কোনো call site ভাঙেনি।

## জানা limitation
- `tryVerifyRs256()`-এর আসল crypto-level অংশ (real RSA key দিয়ে `jwt.sign`
  → `jwt.verify` রাউন্ড-ট্রিপ) integration-test করা যায়নি (এই sandbox-এ
  `jsonwebtoken` প্যাকেজ ইনস্টল করা নেই) — শুধু candidate-selection logic
  (`resolveVerificationKeys()`) টেস্ট করা হয়েছে, যেটাই মূল "kid resolve
  করে vs. fail করে" সিদ্ধান্তটা নেয়। Deploy-এর আগে real keypair দিয়ে
  sign→verify round-trip (rotated kid সহ) একবার ম্যানুয়ালি sanity-check
  করা ভালো — সেটাই Phase 1D-f-এর পূর্ণাঙ্গ integration test-এর কাজ।
- Cache pre-load window-এ (process শুরুর প্রথম কয়েক call) যদি টোকেনের `kid`
  সত্যিকারের কোনো `retiring` key-র হয় (DB-তে থাকা, কিন্তু cache তখনও
  লোড হয়নি) — সেই টোকেন সাময়িকভাবে reject হবে, cache লোড শেষ হওয়া পর্যন্ত।
  Self-heals নিজে থেকেই (পরের call-এ cache রেডি থাকবে), তাই bounded এবং
  transient — কিন্তু worth জানা।

## পরের ধাপ (Phase 1D-c)
- Key lifecycle states (ACTIVE → RETIRING → GRACE → REMOVED) explicitly
  represent করা — কোন state সাইন করতে পারে, কোনটা শুধু verify করতে পারে,
  সেটার rule test করা।
