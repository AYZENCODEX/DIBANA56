# OIDC Roadmap — Season 1, Phase 1E-f: Discovery Integration Tests

## যা আগে থেকেই ছিল
রোডম্যাপের 1E-f test list-এর ৬টা আইটেম ইতিমধ্যে 1E-a/b/c/d/e-এর ইউনিট
টেস্টে আলাদাভাবে কভার হয়ে গিয়েছিল — কিন্তু প্রতিটাই হয় pure builder-এর
বিরুদ্ধে (`buildJwks()`, `buildOidcDiscoveryMetadata()`), অথবা handler-এর
বিরুদ্ধে ঠিক একটামাত্র মুহূর্তের cache state দিয়ে। কোথাও একটা আসল **key
rotation**-কে REAL handler-দের (`jwksHandler`/`openidConfigurationHandler`)
মধ্য দিয়ে, cache reload সহ, end-to-end যাচাই করা হয়নি — 1D-f (Phase 1D-এর
রোটেশন ভেরিফিকেশন) এটা করেছিল, কিন্তু pure-function লেয়ারে, JWKS/discovery
তৈরি হওয়ার আগে।

## যেটা যোগ করা হলো (Phase 1E-f)

### নতুন ফাইল — `scripts/src/test-discovery-integration.ts`
একটা একটানা **৩-স্টেজ রোটেশন** চালায় `loadVerificationKeyCache()` +
`resolveVerificationKeys()`-এর মধ্য দিয়ে (একটা stubbed `pool.query()` দিয়ে
`jwt_signing_keys` সিমুলেট করে), প্রতি স্টেজে আসল
`jwksHandler()`/`openidConfigurationHandler()` কল করে:

1. **Baseline** — env-resolved active key-ই একমাত্র DB row। JWKS format,
   `kid` presence, private-key exclusion, discovery issuer/JWKS URI,
   algorithm metadata (`RS256`) — সবগুলো real handler output-এর বিরুদ্ধে
   চেক করা হয়েছে, আর একটা real RSA-signed token published JWK দিয়ে verify
   হয়।
2. **Mid-rotation (grace)** — নতুন key active, পুরনো key retiring। **এটাই
   "rotation visibility"** — JWKS একসাথে দুটো `kid`-ই publish করে; পুরনো
   token পুরনো JWK দিয়ে এখনো verify হয়, নতুন token নতুন JWK দিয়ে verify
   হয়, আর cross-verification (পুরনো token, নতুন key) ব্যর্থ হয় বলে কনফার্ম
   করা হয়েছে। `resolveVerificationKeys(kid)` প্রতিটা kid-এর জন্য
   deterministic থাকে, unknown kid-এ `[]`। Discovery-র issuer/JWKS
   URI/algorithm metadata রোটেশনের মধ্যেও অপরিবর্তিত থাকে।

### নতুন ফাইল — `scripts/src/test-discovery-integration-post-retirement.ts`
**"Post-retirement"** স্টেজ — ইচ্ছাকৃতভাবে একটা **আলাদা প্রসেস** হিসেবে
(মূল ফাইল থেকে `spawnSync("npx", ["tsx", ...])` দিয়ে চালানো)। কারণ:

`getActiveKeypair()` (1a) তার env-resolved keypair পুরো process-এর জীবনকাল
জুড়ে memoize করে — এটা bug না, বাস্তব প্রোডাকশন আচরণের সাথে সামঞ্জস্যপূর্ণ
(env var বদলাতে হলে process restart লাগে)। এর মানে "পুরনো key DB থেকে
পুরোপুরি সরে গেছে" state একই process-এর মধ্যে env var বদলে সিমুলেট করা যায়
না — `mergeVerificationKeys()` (1D-a) তখন সঠিকভাবেই তার documented fallback
rule অনুযায়ী এখনো-env-এ-থাকা পুরনো kid-টাকে আবার "active" হিসেবে যোগ করে
দেবে, কারণ এই process-এর env অনুযায়ী কিছুই বদলায়নি। এটা 1D-a-এর
ইচ্ছাকৃত আচরণ, কোনো defect না — তাই এই সাব-ফেজে সেটা "ঠিক করা" স্কোপের
বাইরে (roadmap: "do not redesign unrelated architecture")। বাস্তবে
"post-retirement" মানেই একটা fresh redeploy, updated env সহ — তাই টেস্টও
ঠিক সেভাবেই বানানো হয়েছে: আলাদা process, শুরু থেকেই surviving key-এর env
সেট করা।

## টেস্ট ফলাফল
**মূল ফাইলে ১০টা assertion** (baseline ৫টা + mid-rotation ৫টা) **+
post-retirement প্রসেসে ৩টা assertion = মোট ১৩টা, সব পাশ** —
`npx tsx scripts/src/test-discovery-integration.ts`
(এটা নিজেই post-retirement স্ক্রিপ্টটা spawn করে চালায়)।

Regression check হিসেবে 1E-b (৯টা), 1E-c (৬টা), 1E-d (১৪টা), 1E-e (৮টা) —
সবগুলো আবার চালানো হয়েছে, সব পাশ, কোনো regression নেই।

## Sandbox নোট
আগের ফেজগুলোর মতোই — offline sandbox-এ `express`/`@workspace/db`/`pino`
stub নতুন করে বানানো হয়েছে; `@types/node`-এর ambient stub-টা এবার আরও
সম্প্রসারিত করা হয়েছে (`node:crypto`-এর `sign`/`verify`/`KeyObject`,
`node:child_process`-এর `spawnSync`, `Buffer` টাইপ) যাতে এই ফেজের নতুন
কোড টাইপচেক করা যায়। `tsc --noEmit --strict` (isolated config:
`jwt-keys.ts` + `oidc-discovery.ts` + `logger.ts` + `well-known-jwks.ts` +
`well-known-openid-configuration.ts` + এই ফেজের দুটো টেস্ট ফাইল) — কোনো
error নেই।

## জানা limitation
- আগের ফেজগুলোর মতোই — real HTTP server/Express routing engine এখনো এক্সারসাইজ
  করা হয়নি, শুধু handler-দের নিজস্ব লজিক। `pool.query()` stub একটা
  in-memory simulation, real Postgres না — real DB-backed rotation
  (`jwt:rotate` স্ক্রিপ্ট আসল DB-তে চালিয়ে) staging-এ deploy-এর আগে আলাদাভাবে
  sanity-check করা উচিত, আগের ফেজগুলোর মতোই।
- Post-retirement স্টেজ একটা child process spawn করে — `npx`/`tsx` PATH-এ
  থাকা লাগে (এই sandbox-এ আছে, কনফার্ম করা হয়েছে); CI pipeline-এ একই
  থাকা উচিত।

## Phase 1E — সম্পূর্ণ
রোডম্যাপের Definition of Done অনুযায়ী: implementation complete (1E-a
থেকে 1E-e), architecture preserved, relevant tests added ও pass করেছে —
1E-b (৮টা) + 1E-c (৬টা) + 1E-d (১৪টা) + 1E-e (৮টা) + 1E-f (১৩টা) = মোট
৪৯টা assertion, সব sub-phase-এই আবার রি-রান করে কনফার্ম করা, কোনো known
regression নেই। Acceptance criteria (JWKS format, kid presence,
private-key exclusion, discovery issuer, JWKS URI, algorithm metadata,
rotation visibility) সবগুলো এখন real handler-দের বিরুদ্ধে, একটা আসল
rotation lifecycle-এর প্রতিটা স্টেজে যাচাই করা। **Phase 1E এখন DONE।**

## পরের ধাপ
রোডম্যাপ অনুযায়ী পরের কাজ **Phase 2 — Client Registry** (`2a-a` — Client
Schema / Table Design দিয়ে শুরু): first-party OIDC client-দের জন্য trusted
registry (`client_id`, `client_secret_hash`, `redirect_uris[]`,
`allowed_scopes[]`, `is_first_party`)। এই রানে শুরু করা হয়নি — রোডম্যাপের
hard execution boundary অনুযায়ী পরবর্তী রানের কাজ।
