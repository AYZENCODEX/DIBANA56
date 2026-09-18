# OIDC Roadmap — Season 2, Phase 3a-a..3a-h: Authorization Request Validation

**এই ফাইলের পর Phase 3a — AUTHORIZATION REQUEST VALIDATION সম্পূর্ণ।**

## যা আগে থেকেই ছিল (Season 1 / Phase 1-2)
- RS256 signing, key rotation, JWKS, OIDC discovery (Phase 1a..1e) — DONE।
- `oidc_clients` রেজিস্ট্রি + পাঁচটা first-party client seed (Phase 2a/2b) — DONE।
- `validateOidcClientId` / `validateOidcRedirectUri` (Phase 2c), `validateOidcScopes`
  (Phase 2d), আর সব একসাথে wire করা `validateOidcClientRequest()` (Phase 2e) — DONE।
- `/oidc/authorize` কোনো route হিসেবে এখনো ছিল না — Phase 2e-c-এর নিজের
  worked example-ই বলেছিল এটা Phase 3-এর কাজ।

## যেটা যোগ করা হলো (Phase 3a-a..3a-h)

### `artifacts/api-server/src/lib/oidc-authorize-request.ts` (নতুন ফাইল)

**3a-a — Request Parser**
`parseOidcAuthorizeRequest(query)` — `/oidc/authorize`-এর query params
(`client_id`, `redirect_uri`, `response_type`, `scope`, `state`, `nonce`,
`code_challenge`, `code_challenge_method`) parse করে একটা টাইপড
`RawOidcAuthorizeRequest`-এ। খালি স্ট্রিং বা অ্যারে (parameter pollution)
নিরাপদে `string | undefined`-এ normalize হয় — `firstQueryValue()` হেল্পার
দিয়ে। Pure, DB-free, কখনো throw করে না।

**3a-b — Client Validation**
Phase 2e-এর `validateOidcClientRequest()` — নতুন কিছু লেখা হয়নি, শুধু
প্রথমবার একটা route (`routes/oidc-authorize.ts`) থেকে কল হলো, ঠিক
2e-c-এর worked example যেমনটা প্রেডিক্ট করেছিল।

**3a-c — Response-Type Validation**
`response_type` শুধু `"code"` হলেই পাস করে — `lib/oidc-discovery.ts`-এর
`RESPONSE_TYPES_SUPPORTED` (Phase 1e-d)-ও শুধু `"code"` ঘোষণা করে, তাই
এখানেও implicit/hybrid (`token`, `id_token`) পুরোপুরি out of scope,
আর missing মানেই "assume code" না — reject করা হয়।

**3a-d — State Validation**
`state` required — না থাকলে `invalid_request` / `missing_state`। এই
লেয়ার শুধু presence চেক করে, `state`-এর মধ্যে কী আছে সেটা parse/interpret
করে না — client-এর পাঠানো opaque value হিসেবে verbatim ধরে রাখা হয়, যাতে
পরে (client-এর নিজের CSRF check-এ) hubuhu ফেরত দেওয়া যায়।

**3a-e — Nonce Validation**
`nonce` accept করা হয় (present থাকলে verbatim, না থাকলে `null`) — কোনো
format validation বা required-check নেই, কারণ OIDC Core 1.0 §3.1.2.1
অনুযায়ী Authorization Code flow-এ nonce optional (শুধু implicit/hybrid-এ
required, যেগুলো এই provider কখনোই সাপোর্ট করবে না)। **Persist করা** এই
সাব-ফেজের কাজ না — সেটা Phase 3b-e (authorization code persistence)-এর
কাজ; এই ফাইল শুধু value-টা carry করে দেয় পরের ধাপের জন্য।

**3a-f — PKCE Parameter Validation**
তিনটা ধাপে:
1. `code_challenge` missing হলে -> `missing_code_challenge`।
2. Format ভুল হলে (RFC 7636 §4.1/4.2 অনুযায়ী base64url, ৪৩-১২৮ ক্যারেক্টার,
   `[A-Za-z0-9\-_]`) -> `malformed_code_challenge`।
3. `code_challenge_method` — **শুধু `"S256"` accepted, `"plain"` কখনোই না**
   (missing হলে defaulted to plain করা হয়নি — RFC 7636-এর spec-literal
   ডিফল্ট আচরণ ইচ্ছাকৃতভাবে অনুসরণ করা হয়নি, কারণ `plain` PKCE-এর পুরো
   protection-টাই বাতিল করে দেয়)। Missing আর unsupported — এই দুটো আলাদা
   `reason` হিসেবে ধরা হয়েছে, Phase 2d-এর `unknown_scope`/`disallowed_scope`
   split-এর একই প্যাটার্নে।

**3a-g — Authorization Error Contract**
`OidcAuthorizeRequestValidationResult` — Phase 2e-b-এর union-এর সরাসরি
সম্প্রসারণ। প্রতিটা failure-এ একটা নতুন `redirectable` ফিল্ড:
- `invalid_client` / `invalid_redirect_uri` -> `redirectable: false` (Phase
  2c-এর open-redirect rationale অপরিবর্তিত — কোনো verified redirect target
  নেই, তাই সরাসরি error page রেন্ডার করতে হবে, redirect করা যাবে না)।
- বাকি সব (`invalid_scope`, `unsupported_response_type`, `invalid_request`)
  -> `redirectable: true` + verified `redirectUri` — কারণ এই পর্যায়ে client
  + redirect_uri + scope ইতিমধ্যে verified, তাই roadmap-এর global error
  model (section 4) অনুযায়ী client-এর কাছে `?error=...`-সহ redirect করে
  ফেরত পাঠানো নিরাপদ।

**অর্ডার:** client+redirect+scope (Phase 2e) -> response_type (3a-c) ->
state (3a-d) -> nonce (3a-e, কখনো fail করে না) -> PKCE (3a-f) — ঠিক
roadmap-এ সাব-ফেজগুলো যে অর্ডারে লেখা আছে, সেই অর্ডারে। client/redirect_uri
validate না হওয়া পর্যন্ত অন্য কিছু নিয়ে (response_type-সহ) কোনো redirect-ভিত্তিক
সিদ্ধান্ত নেওয়া হয় না — Phase 2c-এর নিজের rationale-এরই সম্প্রসারণ।

**পিওর/DB-স্প্লিট:** আগের সব ফাইলের মতোই —
- `validateOidcAuthorizeRequestForClient(clientRequest, raw)` — **pure**,
  আগে থেকে resolve করা `{ client, redirectUri, scopes }` নেয়, কোনো DB কল
  নেই। 3a-c..3a-f এখানেই হয়।
- `validateOidcAuthorizeRequest(raw)` — public entrypoint, `client_id`/
  `redirect_uri` presence-এর একটা সস্তা early short-circuit-এর পর
  `validateOidcClientRequest()` (একমাত্র DB কল) দিয়ে client resolve করে,
  তারপর pure ফাংশনে delegate করে।

### `artifacts/api-server/src/routes/oidc-authorize.ts` (নতুন ফাইল)

`GET /oidc/authorize` — **শুধু request validation, এর বেশি কিছু না।**

- **যা এই route করে:** query parse (3a-a) -> validate (3a-b..3a-f) ->
  সফল হলে একটা ডায়াগনস্টিক `200 { ok: true, ... }` (কোনো `code` নেই — কারণ
  কোনো code ইস্যু করা হয়নি), ব্যর্থ হলে `redirectable` অনুযায়ী হয় `400 JSON`
  (non-redirectable) নয়তো `302` redirect (`?error=...&state=...`,
  redirectable)।
- **যা এই route করে না (Phase 3b-এর কাজ, ইচ্ছাকৃতভাবে বাদ):** existing
  session detect করা, central login-এ redirect করা, authorization code
  generate/persist করা, `code`-সহ callback-এ redirect করা। সফল রেজাল্টের
  `200` response-টা **অস্থায়ী scaffolding** — Phase 3b এসে এই ব্রাঞ্চের
  বডি replace করবে, validation call-টা না।
- **Mount:** bare origin-এ (`/api` prefix-এর বাইরে), `well-known-jwks.ts`/
  `well-known-openid-configuration.ts`-এর মতো — client `${issuer}/oidc/authorize`
  সরাসরি build করে, `/api` দিয়ে না, আর এই deployment-এর নিজের API key বহন
  করার কথাও না, তাই `apiKeyScopeGate`-এর পিছনে না।
- **Rate limiting:** `authLimiter` — `/auth/login`, `/auth/init` ইত্যাদি এই
  codebase-এর প্রতিটা user-facing login entry point যেটা ব্যবহার করে, ঠিক
  সেটাই — কারণ এই endpoint-ও একই ধরনের login-flow entry point।

`app.ts`-এ `wellKnownJwksRouter`/`wellKnownOpenidConfigurationRouter`-এর
ঠিক পরে `oidcAuthorizeRouter` mount করা হলো, একই bare-origin ব্লকে,
`apiKeyScopeGate`-এর আগে।

### `scripts/src/test-oidc-authorize-request-validation.ts` (নতুন ফাইল) — 3a-h

Section 6-এর "GLOBAL TESTING MATRIX -> Authorization" তালিকার প্রতিটা
আইটেম কভার করা হয়েছে:

| আইটেম | কভারেজ |
|---|---|
| missing parameters | missing state, missing code_challenge, missing code_challenge_method, missing response_type |
| invalid state | state opaque — এই লেয়ারে "invalid" মানে "absent"; presence-only চেক টেস্ট করা |
| invalid nonce | nonce-এর কোনো format নেই যেটা "invalid" হতে পারে — তাই accept/omit দুটো behavior-ই টেস্ট করা হয়েছে |
| invalid PKCE challenge | too-short, invalid-charset, over-128, missing method, plain method, wrong-case method |
| unsupported response type | missing, `token`, `id_token` |

মোট **২৬টা assertion** — parser edge cases (3a-a: array/empty/nested-object
query values), response_type/state/nonce/PKCE-এর প্রতিটা শাখা, আর 3a-g-এর
`redirectable` contract একটা combined টেস্টে (৪টা ভিন্ন failure-এই
`redirectUri` verified-ই থাকে কিনা)।

`validateOidcAuthorizeRequestForClient()` (pure অংশ) সরাসরি টেস্ট করা
হয়েছে; `validateOidcAuthorizeRequest()` (DB-touching wrapper) — 2e-d-এর
নিজের নোটের একই কারণে (client_id/redirect_uri presence check + delegate,
৫-৬ লাইন, দুটো অংশই আলাদাভাবে ভেরিফাইড) হাতে ট্রেস করে verify করা হয়েছে,
রান করা হয়নি।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-authorize-request.ts` | **নতুন ফাইল** — 3a-a..3a-g |
| `artifacts/api-server/src/routes/oidc-authorize.ts` | **নতুন ফাইল** — `GET /oidc/authorize`, validation-only |
| `artifacts/api-server/src/app.ts` | নতুন router import + bare-origin mount (well-known routers-এর পরে) |
| `scripts/src/test-oidc-authorize-request-validation.ts` | **নতুন ফাইল** — 3a-h |
| `scripts/package.json` | নতুন script: `oidc:test-authorize-request-validation` |

## যা টেস্ট করা হয়েছে
- **`check-all.ts --syntax-only`** — পুরো workspace-এর ৬টা module, ৮৪৪টা
  ফাইল (৩টা নতুনসহ), সব ক্লিন — ০টা issue।
- **`test-oidc-authorize-request-validation.ts` সত্যিকারের রান করা হয়েছে**
  — `@workspace/db`/`pino`-এর জন্য সাময়িক in-memory stub বসিয়ে (2e-এর
  টেস্টিং-এর সময় যেভাবে করা হয়েছিল ঠিক সেভাবেই — module resolution satisfy
  করার জন্যই, deliverable-এ কিছু যোগ হয়নি, টেস্ট শেষে stub মুছে ফেলা হয়েছে)
  — **২৬টা assertion pass**।
- `validateOidcAuthorizeRequest()` (DB-touching wrapper) এবং
  `routes/oidc-authorize.ts`-এর route wiring/response-shaping লজিক — লাইভ
  DATABASE_URL বা একটা রানিং HTTP সার্ভার ছাড়া রান করার উপায় ছিল না এই
  sandbox-এ, তাই হাতে ট্রেস করে verify করা হয়েছে।

## যা করা হয়নি (out of scope, ইচ্ছাকৃতভাবে)
- **`lib/oidc-discovery.ts`-এ `authorization_endpoint` যোগ করা হয়নি।**
  1E-d-এর নিজের কমেন্ট বলে "do not advertise endpoints that do not exist
  yet" — এখন endpoint-টা exists করে, তাই এটা যোগ করার একটা যুক্তিসঙ্গত
  পরের ধাপ, কিন্তু roadmap-এর 3a-a..3a-h task list-এ discovery ফাইল ছোঁয়ার
  কোনো আইটেম নেই — তাই এই সাব-ফেজের diff-টা 3a যা চেয়েছে ঠিক তার মধ্যেই
  রাখা হলো। পরের কোনো (মাইক্রো-)সাব-ফেজের জন্য নোট করে রাখা হলো।
- Phase 3b-এর কিছুই (session detection, login redirect, code generation/
  persistence/callback) — roadmap-এর hard execution boundary অনুযায়ী।
- PKCE **verifier** checking (`code_verifier`, token endpoint-এ) — Phase 3d।

## Phase 3a সম্পূর্ণ — SEASON 2-তে অবস্থান
Season 2 (Phase 3 — Authorization Code + PKCE)-এর পাঁচটা সাব-ফেজের প্রথমটা
(3a) এখন সম্পূর্ণ। বাকি চারটা: **3b — Login & Authorization Code**, 3c —
Token Endpoint, 3d — PKCE Enforcement, 3e — Refresh Token Baseline।

## পরের ধাপ (Phase 3b)
**3b — Login & Authorization Code**, শুরু `3b-a — Existing Session
Detection` দিয়ে: request already validated (এই ফেজের কাজ), এখন দেখতে হবে
ব্যবহারকারী already authenticated কিনা (existing `user_sessions`/cookie
মেকানিজম দিয়ে), না হলে central login-এ redirect (3b-b), authorization
context নিরাপদে preserve করা (3b-c), তারপর code generation/persistence/
callback (3b-d..3b-g)। `routes/oidc-authorize.ts`-এর success ব্রাঞ্চ
(এখন `200 { ok: true, ... }`)-টাই সেই জায়গা যেটা 3b replace করবে।
