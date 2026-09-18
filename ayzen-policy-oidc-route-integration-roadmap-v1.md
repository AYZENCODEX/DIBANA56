# AYZEN — Policy Engine + OIDC কে Business Routes-এ Integrate করার Roadmap

## Status: প্রস্তাব মাত্র — কোনো কোড এখনো লেখা হয়নি

---

## 1. আগে যা audit করে পাওয়া গেছে (current state, honest)

Codebase-এ দুটো বড় engine আলাদাভাবে সম্পূর্ণ, কিন্তু একে অপরের সাথে বা
main app-এর সাথে এখনো জোড়া লাগেনি:

**Policy & Authorization Mega Engine** — Phase 1A থেকে Phase 25 পর্যন্ত
build হয়ে গেছে:
- PDP core (`lib/policy/policy-engine.ts`), PIP (`policy-information-point.ts`),
  PAP (registry, admin console), simulator, explain, telemetry — সবই আছে
- PEP / Express SDK পুরো তৈরি (`lib/policy/pep/`): `requirePolicy()`,
  `requirePermission()`, `requireOwnership()`, `requireRole()`,
  `requireStepUp()`, `requireApproval()`
- কিন্তু **138টা route-এর মধ্যে মাত্র ১টা** (`routes/oidc-resource.ts`)
  আসলে PEP দিয়ে protect করা। বাকি সব build হয়ে "shelf"-এ বসে আছে।

**OIDC Provider** — 10+ phase (crypto foundation, client registry,
authorize/token flow, consent, dynamic client registration, introspection,
logout propagation) সম্পূর্ণ:
- এটা প্রথম-পক্ষ + third-party client-দের জন্য "Sign in with AYZEN" SSO
  provider হিসেবে কাজ করে
- কিন্তু এটা এখনো **isolated** — OIDC দিয়ে ইস্যু করা access token নিয়ে
  AYZEN-এর নিজের business API (finance, vault, mail, marketplace...) call
  করলে `getUserFromToken()`/`requireAuth` সেটা চিনবে না

**Legacy auth** (`middlewares/auth.ts`) — `requireAuth`/`requireAdmin`/
`requireRoles`/`requireDev`:
- 138টার মধ্যে **106টা route** এখনো শুধু এই hand-rolled, non-PDP path দিয়ে
  protected — কোনো decision-reason code নেই, কোনো audit trail নেই, PDP-র
  simulator/explain কিছুই এখানে touch করে না

সংক্ষেপে: দুটো শক্তিশালী engine বানানো হয়ে গেছে, কিন্তু বাস্তব traffic এখনো
তার কোনোটার মধ্য দিয়েই যায় না।

---

## 2. দুটো design decision (যা তুমি "যেটা better হয়" বলে ছেড়ে দিয়েছ)

### Decision A — OIDC token acceptance: **dynamic/dual**
`requireAuth` (এবং যা কিছু তার উপর নির্ভর করে) দুই ধরনের token-ই নেবে —
পুরনো legacy JWT আর নতুন OIDC access token — structurally আলাদা করে
(token-এর `kid`/`iss` claim দেখে, নতুন কোনো header বা flag ছাড়াই), তারপর
দুটোকেই একই `AuthUser` shape-এ normalize করবে (`authType: "oidc"` যোগ
হবে, বাকি shape অপরিবর্তিত)। Route handler-রা কখনো জানবেই না কোন পথে
token এসেছে — এটাই "dynamic" রাখার মানে: ভবিষ্যতে কোনো নতুন token source
এলেও এই একই dispatch point-এ যোগ হবে, route-level কোড অপরিবর্তিত থাকবে।

### Decision B — Legacy vs Policy Engine: **"strangler fig", দুটো আলাদা সিস্টেম না**
Legacy আর PDP-based — এই দুইটাকে চিরকাল **parallel** রাখাটা বিপজ্জনক
(একই route-এ দুই জায়গায় auth logic maintain করতে হবে, একটাতে fix করলে
অন্যটাতে ভুলে যাওয়ার ঝুঁকি)। আবার ১০৬টা route **একসাথে** rewrite করাটাও
ঝুঁকিপূর্ণ (একটা mega-PR, regression ধরা কঠিন)।

তাই প্রস্তাব: `middlewares/auth.ts`-এর `requireAuth`/`requireAdmin`/
`requireRoles`/`requireDev` — এই ফাংশনগুলোর **নাম, signature, response
shape (401/403 code গুলো) অপরিবর্তিত রেখে**, ভেতরের implementation-টা
হাতে-লেখা `if (user.role !== ...)` চেক থেকে সরিয়ে ভেতরে ভেতরে
`requirePolicy()` + একটা generated RBAC rule দিয়ে চালানো হবে। মানে —

- **106টা route-এর একটা লাইনও ছুঁতে হবে না** — তারা এখনো `requireAdmin`
  import করছে, কিন্তু এখন প্রতিটা call PDP-র মধ্য দিয়ে যাবে, decision-reason
  code পাবে, telemetry/audit hook-এ ধরা পড়বে
- এটাই "single system" — legacy নামগুলো শুধু PDP-র উপর একটা পাতলা,
  backward-compatible façade হয়ে যাবে, সত্যিকারের দ্বিতীয় auth engine না

---

## 3. প্রস্তাবিত Phase বিভাজন (repo-র existing convention অনুসরণ করে)

### Season A — Foundation glue (কোনো route touch হবে না)

- **Phase A1 — Token discriminator + OIDC verification**
  `lib/auth-utils.ts`-এ `getUserFromToken()`-এর ভেতরে token টা legacy JWT
  নাকি OIDC access token তা চেনার লজিক (kid lookup ব্যর্থ হলে বা
  token-এর `iss`/`typ` দেখে OIDC token-store/introspection-এ fallback),
  দুটো পথই একই `AuthUser` return করবে। কোনো route পরিবর্তন নেই এই ফেজে।

- **Phase A2 — RBAC-PEP shim (regression-only phase)**
  `middlewares/auth.ts`-এর ৪টা ফাংশনের ভেতরের কোড সরিয়ে `requirePolicy()`
  + `createRbacRule()`-ভিত্তিক করা, কিন্তু বাইরের behavior (status code,
  error body shape) বিট-ফর-বিট same রাখা — regression test দিয়ে verify করা
  compulsory। এই ফেজের একমাত্র লক্ষ্য: কেউ টের না পাক কিছু বদলেছে, ভেতরে
  সবকিছু এখন PDP দিয়ে যাচ্ছে।

- **Phase A3 — Telemetry hookup**
  Phase 17-এর `onDecision` audit hook সব route-এ wire করা (এখন শুধু
  console/`oidc-resource`-এ আছে), যাতে `admin-policy-console` আর
  `authorization-telemetry` real traffic দেখায়, synthetic test data না।

### Season B — Sensitive-route ABAC/ownership upgrade (RBAC-এর বাইরে যা legacy কখনো করতে পারত না)

- **Phase B1 — Finance module**: `requireOwnership()` যোগ (parties, ledger,
  repayments) — role ঠিক থাকলেও নিজের না-হওয়া record-এ hand দিতে না পারা
- **Phase B2 — Vault**: `requireStepUp()` (existing anomalous-IP/step-up
  ticket flow-এর সাথে PDP-র নিজস্ব assurance rule জোড়া), + ownership check
- **Phase B3 — Admin consoles নিজেরাই শেষে** (dogfooding: engine manage করা
  console-গুলোই engine দিয়ে শেষে migrate হবে)

### Season C — বাকি legacy route-গুলোর mechanical sweep

- Phase C1...Cn — ছোট batch-এ (৫–১০ route/phase), প্রতিটা phase-এর নিজের
  `CHANGES_POLICY_ROUTE_MIGRATION_PHASEn.md`, repo-র existing convention
  অনুযায়ী

### Season D — ভবিষ্যতের জন্য নাম মাত্র (এখনই detail না)

- App-এর নিজের frontend login-ও legacy JWT-র বদলে পুরোপুরি "Sign in with
  AYZEN" OIDC flow-এ যাওয়া (শুধু third-party SSO না) — decision এখনই না,
  পরে আলাদা আলোচনা

---

## 4. Order-টা কেন এভাবে

Season A ছাড়া B/C শুরু করলে দুটো auth path পাশাপাশি maintain করতে হতো।
A2 (shim) সবচেয়ে ঝুঁকিপূর্ণ ধাপ বলেই সবার আগে, একা, regression-focused —
যাতে ভুল থাকলে সেটা এখানেই ধরা পড়ে, পরের কোনো নতুন feature-এর সাথে না
মিশে। B, RBAC-এর বাইরে যেটুকু legacy কখনো দিতে পারত না (ownership,
step-up) সেটা আগে করে ফেলছে সবচেয়ে sensitive জায়গায় — যেখানে নতুন সুরক্ষা
সবচেয়ে বেশি value যোগ করে। C পুরোপুরি mechanical, তাই সবার শেষে, batch-এ।

---

## 5. Phase A1 শুরু করার আগে যেটা confirm করা দরকার

- OIDC access token discriminate করার signal কী হবে: `kid` lookup miss
  (legacy key store-এ না পেলে OIDC token ধরে নেওয়া), নাকি token-এর
  ভেতরের `iss`/দাবি আলাদা claim, নাকি আলাদা `token_type` prefix?
- Introspection endpoint call করে verify করা হবে, নাকি local JWKS
  verify যথেষ্ট (introspection বাড়তি latency যোগ করে, কিন্তু revocation
  সাথে সাথে ধরে)?

এই দুটো ঠিক হলেই Phase A1 কোড লেখা শুরু করা যায়।
