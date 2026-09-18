# OIDC Roadmap — Season 1, Phase 2E-a..2E-e: Unified Client Validation

**এই ফাইলের পর Phase 2 — CLIENT REGISTRY সম্পূর্ণ।**

## যা আগে থেকেই ছিল
- Phase 2A: `oidc_clients` টেবিল + read-only repository (`getOidcClientById`)।
- Phase 2B: পাঁচটা first-party client seed করা।
- Phase 2C: `oidc-client-validation.ts`-এ `validateOidcClientId` (client
  lookup) আর `validateOidcRedirectUri` (exact redirect matching)।
- Phase 2D: `oidc-scope-validation.ts`-এ `validateOidcScopes`।
- তিনটাই আলাদা ফাইলে, আলাদা কল করতে হতো — একটাও একসাথে wire করা ছিল না।

## যেটা যোগ করা হলো (Phase 2E-a..2E-e)

### `artifacts/api-server/src/lib/oidc-client-request-validation.ts` (নতুন ফাইল)

**2E-a — Validation Service**
`validateOidcClientRequest(clientId, redirectUri, rawScope)` — roadmap-এর
নিজের example-এর ঠিক সেই সিগনেচার (`validateClientRequest(client_id,
redirect_uri, scope)`)। ভিতরে তিনটা ধাপ ক্রমান্বয়ে:
1. `validateOidcClientId` (2C-a) — client resolve করে।
2. `validateOidcRedirectUri` (2C-b/2C-c) — redirect exact-match চেক করে।
3. `validateOidcScopes` (2D-b/2D-c) — scope চেক করে।
প্রথম যেটা fail করে সেখানেই থেমে যায় (fail-fast) — একটা bad redirect_uri
আর একটা bad scope দুটোই থাকলে রেজাল্ট সবসময় `invalid_redirect_uri`,
`invalid_scope` না। কেন এই অর্ডার: `oidc-client-validation.ts`-এর নিজের
কমেন্টেই বলা আছে — client + redirect_uri যাচাই না হওয়া পর্যন্ত request-এর
আর কিছু নিয়ে (scope-সহ) সিদ্ধান্ত নেওয়া নিরাপদ না।

**পিওর/DB-স্প্লিট:** `lib/jwt-keys.ts`-এর pattern অনুসরণ করে দুইভাগে ভাগ
করা হলো —
- `validateOidcClientRequestForClient(client, redirectUri, rawScope)` —
  **pure**, ইতিমধ্যে resolve করা `OidcClient` অবজেক্ট নেয়, কোনো DB কল
  নেই। ধাপ ২ আর ৩ (redirect + scope) এখানেই compose হয়।
- `validateOidcClientRequest(clientId, redirectUri, rawScope)` — public
  entrypoint, `validateOidcClientId` দিয়ে client resolve করে তারপর উপরের
  pure ফাংশনে delegate করে। এটাই একমাত্র জায়গা যেখানে DB টাচ হয়।

**2E-b — Result Model**
```text
{ ok: true, client, redirectUri, scopes }
  |
{ ok: false, error: "invalid_client" }
  |
{ ok: false, error: "invalid_redirect_uri" }
  |
{ ok: false, error: "invalid_scope", reason, scope }
```
roadmap-এর ঠিক ৪টা ফিল্ড (client / validated redirect URI / validated
scopes / status-error) — Phase 2C/2D-এর নিজেদের error shape-এর একটা
সরাসরি union, নতুন করে চতুর্থ কোনো shape বানানো হয়নি।

**2E-c — Consumer Contract**
`/oidc/authorize` route এখনো নেই (Phase 3) — তাই কোনো route ফাইল যোগ
করা হয়নি। ফাইলের হেডার কমেন্টে একটা worked example আছে দেখানোর জন্য যে
Phase 3 এই একটামাত্র ইন্টারফেস (`await validateOidcClientRequest(...)` +
`result.ok`/`result.error`-এর উপর switch) দিয়ে কীভাবে কাজ চালাতে পারবে —
কোনো নতুন লজিক না, শুধু প্রমাণ যে shape-টা call-ready।

### `scripts/src/test-oidc-client-request-validation.ts` (নতুন ফাইল) — 2E-d

`validateOidcClientRequestForClient()`-এর (pure অংশ) উপর ৮টা assertion —
roadmap-এর "test all client + redirect + scope combinations":

| কম্বিনেশন | ফলাফল |
|---|---|
| valid redirect + valid scope subset | ok |
| valid redirect + কোনো scope রিকোয়েস্ট না করা | ok, scopes: [] |
| একাধিক registered redirect_uri-এর মধ্যে সঠিকটা match | ok |
| bad redirect + scope-ও bad হতো | invalid_redirect_uri (scope-এ পৌঁছায়ইনি) |
| bad redirect + scope pass করতো | invalid_redirect_uri (তাও) |
| near-match redirect (path ভিন্নতা) | invalid_redirect_uri |
| valid redirect + unknown scope | invalid_scope / unknown_scope |
| valid redirect + known কিন্তু disallowed scope | invalid_scope / disallowed_scope |

`validateOidcClientRequest()` (DB-টাচিং wrapper) এখানে টেস্ট করা হয়নি —
এটা মাত্র ৪ লাইন (client resolve + delegate), আর দুটো অংশই আলাদাভাবে
আগে থেকেই ভেরিফাইড (`validateOidcClientId` 2C-e-তে হাতে-ট্রেসড,
`validateOidcClientRequestForClient` এখানে ১০০% এক্সিকিউটেড) — তাই এই
৪ লাইনের composition হাতে ট্রেস করে verify করা হয়েছে।

### `scripts/src/test-oidc-phase2-exit.ts` (নতুন ফাইল) — 2E-e

Phase 2-এর Final Verification — এখানে **synthetic fakeClient না, আসল
`SEED_CLIENTS`** (Phase 2B) ডেটা দিয়ে:
- পাঁচটা seeded client-ই তার নিজের redirect_uri + নিজের পুরো seeded
  scope set নিয়ে validate হয় (ok)।
- পাঁচটা client-ই শুধু `"openid"` রিকোয়েস্ট করেও validate হয় (ok)।
- **cross-client rejection matrix**: প্রতিটা client অন্য চারটার
  redirect_uri রিজেক্ট করে কিনা — ৫×৪ = ২০টা কম্বিনেশন, সবগুলো
  `invalid_redirect_uri`।
- শেষে Phase 2 exit criteria-র একটা checklist প্রিন্ট করে, প্রতিটা
  পয়েন্ট কোন phase-এ কীভাবে satisfy হয়েছে তার রেফারেন্সসহ।

মোট ২৮টা assertion + checklist।

**একটা pre-existing quirk নোট করা হলো (এই phase-এর scope না, ঠিক করা
হয়নি):** `seed-oidc-clients.ts` (2B) নিজের `main()`-কে module-level-এই
unconditionally কল করে (অন্য সব `scripts/src/*.ts`-এর মতোই প্যাটার্ন) —
তাই শুধু `SEED_CLIENTS` ইম্পোর্ট করলেও (2B-f-এর test ফাইলও এটাই করে)
ব্যাকগ্রাউন্ডে `main()` চলে। DATABASE_URL না থাকায় সেটা প্রতিটা client-এর
জন্য নিজের try/catch-এ error ধরে লগ করে — কোনো assertion-কে প্রভাবিত করে
না, কিন্তু test আউটপুটে বাড়তি লগ দেখা যায়। এই roadmap-এ প্রথমবার
`SEED_CLIENTS` ইম্পোর্ট করা কোনো স্ক্রিপ্ট আসলেই রান হওয়ায় এটা এখন
চোখে পড়ল, তাই ভবিষ্যতের জন্য নোট করে রাখা হলো।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-client-request-validation.ts` | **নতুন ফাইল** — 2E-a..2E-c |
| `scripts/src/test-oidc-client-request-validation.ts` | **নতুন ফাইল** — 2E-d |
| `scripts/src/test-oidc-phase2-exit.ts` | **নতুন ফাইল** — 2E-e |
| `scripts/package.json` | নতুন script যোগ: `oidc:test-client-request-validation`, `oidc:test-phase2-exit` |

## যা টেস্ট করা হয়েছে
- **`check-all.ts --syntax-only`** (`artifacts/api-server` ও `scripts`
  দুটো module-এই) — নতুন তিনটা ফাইলসহ সব ক্লিন।
- **দুটো নতুন টেস্ট ফাইলই সত্যিকারের রান করা হয়েছে** — `@workspace/db`/
  `pino`-এর জন্য সাময়িক in-memory stub বসিয়ে (module resolution
  satisfy করার জন্যই, deliverable-এ কিছু যোগ হয়নি, টেস্ট শেষে stub মুছে
  ফেলা হয়েছে):
  - `test-oidc-client-request-validation.ts` — ৮টা assertion pass।
  - `test-oidc-phase2-exit.ts` — ২৮টা assertion pass, checklist প্রিন্ট
    হয়ে "Phase 2 — CLIENT REGISTRY: DONE." দেখা গেছে।
- `validateOidcClientRequest()` (DB-টাচিং wrapper) — উপরে বলা কারণে হাতে
  ট্রেস করে verify করা হয়েছে, রান করা হয়নি।

## Phase 2 সম্পূর্ণ — SEASON 1 EXIT CRITERIA-তে অবস্থান
roadmap-এর "SEASON 1 EXIT CRITERIA" তালিকার ৮টা আইটেমের মধ্যে Phase 2
তিনটা কভার করে — **Client registry, Redirect validation, Scope
validation** — তিনটাই এখন DONE। বাকি পাঁচটা (RS256, Key storage,
Rotation, JWKS, OIDC discovery) Phase 1 (1a..1e) থেকে ইতিমধ্যে DONE।
তাই **Season 1 এখন সম্পূর্ণ** — পুরনো cookie-based login-ই এখনো
active user-facing পথ, roadmap অনুযায়ী ঠিক তাই থাকার কথা।

## পরের ধাপ (Season 2, Phase 3)
**Phase 3 — Authorization Code + PKCE**, শুরু `3a — Authorization Request
Validation` দিয়ে:
- 3a-a Request Parser — `/oidc/authorize`-এর query params পার্স করা।
- 3a-b Client Validation — এই ফেজে বানানো `validateOidcClientRequest()`
  এখানেই প্রথমবার একটা route থেকে কল হবে।
- 3a-c response_type validation, 3a-d state, 3a-e nonce, 3a-f PKCE
  parameters, 3a-g Authorization Error Contract, 3a-h Request Validation
  Tests।

এখান থেকেই `/oidc/authorize` route প্রথমবার তৈরি হবে — Phase 2-এর সব
validation ফাংশনই তার জন্য প্রস্তুত হয়ে আছে।
