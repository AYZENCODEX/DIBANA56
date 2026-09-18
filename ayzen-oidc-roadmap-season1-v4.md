# AYZEN Central Account — OIDC Provider Roadmap

## Modularization rule (v4)

প্রতিটা **Season-এ ঠিক ২টা Phase** থাকবে। প্রতিটা Phase এখন **a/b/c/d/e —
৫টা sub-phase**-এ ভাগ করা (আগে a/b/c, ৩টা ছিল) — যাতে একেকটা sub-phase আরও
ছোট, রিভিউযোগ্য, এবং একেকটা আলাদা PR/deploy হিসেবে ধরা যায়। কোনো Phase-এর
মূল স্কোপ বদলায়নি — বড় sub-phase-গুলোকে আরও ছোট, স্বাধীনভাবে-shippable
টুকরোয় ভেঙে দেওয়া হয়েছে।

Total scope অপরিবর্তিত: Phase 1–6, Season 1–3-এ ভাগ করা (Phase 1+2 → Season
1, Phase 3+4 → Season 2, Phase 5+6 → Season 3)। Phase 6-এর পরের future scope
Season 4/5 নামে, একই "নাম মাত্র, detail না" নিয়মে।

---

### এখন যা আছে (ভিত্তি, কিন্তু OIDC না)
- Login করলে একটা **HMAC-signed JWT** (`HS256`, shared secret) ইস্যু হয়, সাথে
  `user_sessions` টেবিলে রিভোকেবল session row (`sid` claim দিয়ে bind করা)।
- `*.ayzen.tech` জুড়ে একটা shared **httpOnly cookie** থাকে — তাই Sylo-তে গেলে
  re-login লাগে না।
- এটা আসলে **shared-secret cookie hack**, standard OIDC না:
  - কোনো `.well-known/openid-configuration` বা JWKS endpoint নেই
  - Token HMAC-signed — মানে verify করতে চাইলে *একই secret* লাগবে (asymmetric
    trust boundary নেই)
  - কোনো client registry নেই — সব app "trusted" ধরে নেওয়া হয়, `client_id` /
    `redirect_uri` / scope concept নেই
  - Authorization Code flow, PKCE, `id_token` বনাম `access_token` আলাদা করা,
    consent — কিছুই নেই
  - এখন পর্যন্ত কাজ করে কারণ সব app **একই codebase-এর route** (Sylo host-based
    routing দিয়ে আলাদা দেখায়, কিন্তু deploy একটাই)

তাই real OIDC provider মানে "central account = Identity Provider", আর
Sylo/Ryft/Wisp/Verve/Zynth (এবং future third-party) — এরা প্রত্যেকে **আলাদা
OIDC client**, cookie-hack এর বদলে standard flow দিয়ে login করবে।

**লক্ষ্য (Season 1–3):** spec-compliant কিন্তু ছোট scope-এর OIDC provider —
শুধু AYZEN-এর নিজের sub-apps (first-party clients) এর জন্য। Public
third-party developer platform, consent-UI, dynamic client registration —
এগুলো এখনই না (Season 4/5, নাম মাত্র)।

---

## Season 1 — Phase 1 + Phase 2

**Season 1-এর scope:** সাইনিং ভিত্তি ঠিক করা (RS256 + rotation + discovery)
আর "কে app" সেটা জানার জন্য client registry বানানো। এখনো কোনো actual
authorize/token flow নেই — এই দুটো Phase পুরোপুরি foundation।

### Phase 1 — Crypto Foundation

- **Phase 1a — RSA keypair infra** ✅ **DONE**
  - `lib/jwt-keys.ts`: active RSA keypair resolve (env var থেকে, `kid` সহ),
    dev-এ ephemeral fallback, prod-এ env var না থাকলে fail-fast
  - `scripts/src/generate-jwt-keypair.ts`: নতুন keypair generate করার script

- **Phase 1b — Sign/verify RS256 switch** ✅ **DONE**
  - `lib/jwt.ts`: sign/verify RS256-এ পরিবর্তন
  - `ALLOW_LEGACY_HS256_TOKENS` গ্রেস-পিরিয়ড টগল (পুরনো HS256 টোকেন সাময়িক গ্রহণ)
  - **এখনো নেই এই sub-phase-এ:** rotation, একাধিক retained public key, JWKS/
    discovery endpoint — এগুলো নিচে 1c/1d/1e

- **Phase 1c — Multi-key storage/schema** ✅ **DONE**
  - একাধিক retained public key রাখার storage/schema (`kid` দিয়ে indexed) —
    পুরনো key immediately বাদ না দিয়ে overlap window রাখা, যাতে rotation-এর
    সময় in-flight টোকেন invalid না হয়ে যায়

- **Phase 1d — Rotation trigger + verification lookup** ⬜ বাকি
  - Rotation trigger + policy (ম্যানুয়াল script vs. scheduled) এবং পুরনো key
    কতদিন পর সরানো নিরাপদ তার নিয়ম
  - `getActiveKeypair()`-এর পাশে `getVerificationKeys(kid?)`-জাতীয় ফাংশন, যাতে
    verify-পথ একাধিক active/retiring key চেক করতে পারে

- **Phase 1e — Discovery endpoints** ⬜ বাকি
  - `GET /.well-known/jwks.json` — 1c/1d-তে রাখা সব retained public key
    publish করে (RSA থেকে JWK format-এ কনভার্ট, `kid` সহ)
  - `GET /.well-known/openid-configuration` — issuer, endpoint URL, supported
    algorithms/scopes/response_types ইত্যাদি advertise করে (পরের ফেজের
    endpoint URL-গুলো যোগ হতে হতে এই ফাইল বাড়বে)

*কেন এই order:* 1a/1b ছাড়া সাইন-ইং-ই ভুল ভিত্তিতে হতো। 1c ছাড়া 1d-তে কোনো
key store-ই থাকত না। 1d ছাড়া rotation করলেই সব ইউজার সাথে সাথে লগ-আউট হয়ে
যেত। 1e আসলে 1a–1d-এর output *publish* করে মাত্র — তাই সবার শেষে।

### Phase 2 — Client Registry

- **Phase 2a — `oidc_clients` schema + migration**
  - নতুন `oidc_clients` টেবিল: `client_id`, `client_secret_hash`,
    `redirect_uris[]`, `allowed_scopes[]`, `is_first_party`, timestamps

- **Phase 2b — Seed data**
  - sylo, ryft, wisp, verve, zynth — সবাইকে first-party client হিসেবে আগে
    থেকে রেজিস্টার করে রাখা (migration/seed script দিয়ে, UI দিয়ে না)

- **Phase 2c — `client_id` + `redirect_uri` match validation**
  - দেওয়া `redirect_uri`, রেজিস্টার্ড `redirect_uris[]`-এর সাথে exact-match
    করছে কিনা যাচাই করার shared lib ফাংশন

- **Phase 2d — Scope allow-list validation**
  - Request-করা scope, client-এর `allowed_scopes[]`-এর সাবসেট কিনা যাচাই
    করার shared lib ফাংশন

- **Phase 2e — Unified client-lookup interface**
  - 2c/2d-এর ফাংশনগুলোকে একটা single lib API-তে wrap করা (যেমন
    `validateClientRequest(client_id, redirect_uri, scope)`), যাতে Season
    2-এর `/oidc/authorize` একটাই call দিয়ে পুরো validation করতে পারে। কোনো
    admin CRUD UI না — সেটা Season 4/5।

*কেন এই order:* Authorization flow লেখার আগে জানতে হবে কে "app" (2a/2b),
তারপর আলাদা আলাদা validation rule (2c/2d), সবশেষে সেগুলোকে একটা clean
interface-এ wrap করা (2e) — যাতে Season 2-তে ব্যবহার করা সহজ হয়।

*কেন Phase 1 + 2 একসাথে এক Season-এ:* দুটোই pure foundation — কোনো
end-user-facing flow নেই, দুটোই পরের সব ফেজের precondition। একসাথে ধরলে
"Season 1 শেষে auth ঠিকমতো কাজ করে কিনা" প্রশ্নটাই আসে না — যা স্কোপ-কে
স্পষ্ট রাখে।

### Season 1 শেষে কোথায় দাঁড়াবে
RS256 সাইনিং + key rotation + `/.well-known/*` discovery কাজ করছে, এবং সব
first-party app client registry-তে রেজিস্টার করা আছে। কিন্তু এখনো কোনো app
সত্যিকারের OIDC flow দিয়ে login করছে না — পুরনো cookie-hack-ই একমাত্র চালু
পথ। এটা শুধু ভিত্তি, ব্যবহারকারীর কাছে কোনো পরিবর্তন visible না।

---

## Season 2 — Phase 3 + Phase 4

**Season 2-এর scope:** আসল OIDC standard-compliance টেস্ট — authorize +
token exchange + PKCE, এবং তার উপরে id_token/userinfo/scope enforcement।
এই Season শেষে flow পুরোপুরি কাজ করবে, কিন্তু এখনো কোনো real client (Sylo-ও
না) এটা ব্যবহার করছে না — সেটা Season 3।

### Phase 3 — Authorization Code + PKCE

- **Phase 3a — Authorize request validation**
  - `GET /oidc/authorize`-এ `client_id`, `redirect_uri`, `scope`, `state`,
    `nonce`, `code_challenge`/`code_challenge_method` validate করা
    (Phase 2e-এর unified lookup ব্যবহার করে)

- **Phase 3b — Login-redirect + code issuance**
  - ইউজার আগে থেকে লগ-ইন না থাকলে central login-এ পাঠানো; সফল হলে
    short-lived authorization code issue করে `redirect_uri`-তে ফেরত

- **Phase 3c — Token endpoint: code exchange**
  - `POST /oidc/token` — authorization code lookup, single-use enforcement
    (একবার ব্যবহার হলে code invalidate)

- **Phase 3d — PKCE verifier enforcement**
  - Token endpoint-এ PKCE `code_verifier` ভেরিফাই বাধ্যতামূলক করা (3c-এর
    code exchange সফল হওয়ার আগের শেষ চেক)

- **Phase 3e — Refresh token issuance**
  - Token response-এ `refresh_token` যোগ; storage/expiry নিয়ম ঠিক করা
    (rotation/introspection/revocation endpoint এখনই না — Season 4/5-এ পূর্ণ
    scope)

*কেন এই order:* 3a ছাড়া কোনো ভুল request-ই ধরা যেত না; 3b ছাড়া কোড ইস্যুই হয়
না। 3c/3d আলাদা করা কারণ "code মিলছে কিনা" আর "PKCE মিলছে কিনা" — দুটো আলাদা
আলাদা ফেইলিউর-মোড, আলাদা টেস্ট করা দরকার। 3e আলাদা কারণ refresh-এর নিজস্ব
storage/lifecycle আছে যেটা বেসিক exchange flow ছাড়াও টেস্ট করা যায়।

### Phase 4 — ID Token + UserInfo

- **Phase 4a — `id_token` core claims**
  - `sub`, `iss`, `aud`, `exp`, `iat` — Phase 3c-এর token endpoint-এ এই claim
    structure বসানো (এখন পর্যন্ত ওখানে placeholder payload থাকতে পারে)

- **Phase 4b — `nonce` binding**
  - Phase 3a-তে পাওয়া `nonce`, id_token-এ সঠিকভাবে carry-forward ও bind করা
    (replay-protection-এর অংশ)

- **Phase 4c — `GET /oidc/userinfo`**
  - `access_token` দিয়ে call, granted scope অনুযায়ী profile/email claim রিটার্ন

- **Phase 4d — Scope-enforcement middleware**
  - Scope-চেক middleware ডিজাইন/লেখা (যা `access_token`-এর granted scope
    অনুযায়ী route-লেভেল অ্যাক্সেস আটকাবে)

- **Phase 4e — Middleware rollout**
  - 4d-এর middleware বাকি API route-গুলোতে (যেগুলো `access_token` accept
    করবে) বসানো — যাতে একটা সীমিত-scope token দিয়ে সবকিছু করা না যায়

*কেন এই order:* যেকোনো standard OIDC client library (Sylo-সহ) 4a/4b/4c আশা
করবে। 4d/4e আলাদা করা কারণ "middleware বানানো" আর "সব route-এ বসানো" — দুটো
আলাদা মাপের কাজ; 4e ছাড়া scope concept-টা কাগজে-কলমেই থেকে যেত, বাস্তবে
enforce হতো না।

*কেন Phase 3 + 4 একসাথে এক Season-এ:* Phase 4 আসলে Phase 3c-এর token
endpoint-এরই ভেতরের/পাশের কাজ (placeholder payload-কে real claim দিয়ে
replace করা, তার উপর userinfo বসানো) — দুটো আলাদা Season-এ রাখলে মাঝখানে এক
Season পুরোটা "token আছে কিন্তু claim ভুল" অবস্থায় আটকে থাকত।

### Season 2 শেষে কোথায় দাঁড়াবে
Authorize → PKCE-secured code exchange → সঠিক claim-সহ `id_token` →
`/oidc/userinfo` → scope-enforced resource route — পুরো standard OIDC flow
end-to-end কাজ করছে এবং টেস্ট করা যাচ্ছে। কিন্তু এখনো কোনো production app
(Sylo-ও না) এই flow ব্যবহার করছে না — এখনো internal/testable অবস্থা।

---

## Season 3 — Phase 5 + Phase 6

**Season 3-এর scope:** প্রথম real client (Sylo) দিয়ে flow প্রমাণ করা, আর
logout/session-কে নতুন flow-এর সাথে সিঙ্ক করা। এই Season শেষেই আসল
user-facing পরিবর্তন আসে।

### Phase 5 — Pilot Migration: Sylo

- **Phase 5a — OIDC client library install**
  - Sylo-র ফ্রন্টএন্ডে standard OIDC client library বসানো ও কনফিগার করা
    (issuer, client_id, redirect_uri ইত্যাদি Phase 2b-এর seed data অনুযায়ী)

- **Phase 5b — Login redirect wiring**
  - Sylo-র login button/flow-কে Phase 3a/3b-এর authorize-redirect দিয়ে
    replace করা

- **Phase 5c — Feature-flagged dual-run**
  - Sylo-র জন্য পুরনো cookie-hack path আর নতুন OIDC path — দুটোই সাময়িক চালু
    রেখে (feature flag) verify করা

- **Phase 5d — Cutover**
  - Verification শেষে cookie-hack বন্ধ করা শুধু Sylo-র জন্য, OIDC path-ই
    একমাত্র active path

- **Phase 5e — Monitoring/rollback**
  - Error rate, login-failure monitoring; সমস্যা হলে দ্রুত 5c-এর flag দিয়ে
    পুরনো path-এ ফিরে যাওয়ার ব্যবস্থা

*কেন এই order:* Sylo আগে থেকেই subdomain-split, তাই প্রথম real client বানানো
সহজ। 5a/5b লেখার কাজ, 5c/5d সেটাকে নিরাপদে চালু করার কাজ, 5e হলো সেই পুরো
প্রক্রিয়ার সেফটি-নেট — বাকি সব app ভাঙার আগে একটা app দিয়ে প্রমাণ করে নেওয়া।

### Phase 6 — Logout + Session Tie-in

- **Phase 6a — `end_session_endpoint` param handling**
  - RP-initiated logout spec অনুযায়ী `id_token_hint`,
    `post_logout_redirect_uri` ইত্যাদি validate করা

- **Phase 6b — Session termination logic**
  - 6a-এর endpoint-এ actual session/token invalidation বসানো (current
    client-এর জন্য)

- **Phase 6c — Tie into `user_sessions` revoke**
  - পুরনো Security page-এর "sign out of device" — সেই revoke logic নতুন
    logout endpoint-এর সাথে যুক্ত করা, যাতে দুই জায়গা থেকেই sync থাকে

- **Phase 6d — Propagation model decision**
  - Cross-client logout front-channel না back-channel দিয়ে হবে — এই
    সিদ্ধান্ত এই sub-phase-এ (পূর্ণ multi-client rollout Season 4/5-এর সাথে
    ওভারল্যাপ করতে পারে)

- **Phase 6e — Sylo-scoped propagation implementation**
  - 6d-এর সিদ্ধান্ত অনুযায়ী Sylo-জুড়ে logout propagate করার implementation
    (ভবিষ্যতে বাকি app যোগ হওয়ার জন্য readiness রেখে)

*কেন এই order:* পুরনো session revoke নতুন flow-এও কাজ করা must; 6a/6b ছাড়া
6c-এর মানে নেই। 6d একটা আর্কিটেকচার সিদ্ধান্ত, তাই implementation (6e)-এর
আগে আলাদা করে রাখা হয়েছে।

*কেন Phase 5 + 6 একসাথে এক Season-এ:* Sylo cutover (Phase 5) হয়ে গেলে
logout/session tie-in (Phase 6) ছাড়া Sylo-তে "sign out of device" ভেঙে
থাকবে — তাই লগইন migrate করে লগআউট বাকি রেখে Season শেষ করা যায় না, দুটো
মিলেই একটা সম্পূর্ণ user-facing unit।

### Season 3 শেষে কোথায় দাঁড়াবে
Sylo সম্পূর্ণভাবে standard OIDC দিয়ে login/logout করছে, key rotation-সহ,
PKCE-secured, আর old cookie-hack path Sylo-র জন্য বন্ধ। বাকি app-গুলো
(Ryft/Wisp/Verve/Zynth) এখনো পুরনো cookie-hack-এ আছে — সেগুলোর migration এই
roadmap-এর বাইরে/পরের কাজ, কারণ মূল লক্ষ্য ছিল Sylo দিয়ে flow প্রমাণ করা।

---

## Season 4/5 (শুধু নাম, detail নয় — scope যাতে না বাড়ে)

দুই-ফেজ-প্রতি-Season এবং পাঁচ-sub-phase-প্রতি-Phase নিয়ম অনুযায়ী ভবিষ্যতে
এটাও ভাগ হতে পারে, কিন্তু এখনই বিস্তারিত করা হচ্ছে না ইচ্ছাকৃতভাবে:

- Consent screen + third-party client onboarding
- Refresh-token rotation + introspection/revocation endpoints
- Admin UI for client management
