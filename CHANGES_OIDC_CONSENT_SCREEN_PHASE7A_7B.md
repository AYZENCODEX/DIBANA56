# OIDC Roadmap — Season 4, Phase 7a..7b: Consent Screen (Data Model + UI)

## যা আগে থেকেই ছিল
- `oidc_clients.is_first_party` (migration 079) — Season 1-3-এ যত client ছিল (Sylo/Ryft/Wisp/Verve/Zynth,
  সবগুলো `is_first_party = true`), সবই AYZEN-এর নিজের অ্যাপ, তাই `/oidc/authorize`-এ কখনো
  "user কি এই client-কে বিশ্বাস করে" — এই প্রশ্নটা তোলার দরকারই পড়েনি।
- `routes/oidc-authorize.ts`-এর নিজের session/login round-trip (3b-b/3b-c) — `?return_to=/oidc/authorize?...`
  দিয়ে `/login`-এ পাঠানো, login শেষে সেই exact URL-এ ফিরে আসা। এই একই "URL-ই preserved transaction"
  প্যাটার্নটা 7b পুরোপুরি reuse করেছে, নতুন কোনো server-side transaction store বানায়নি।
- `validateOidcAuthorizeRequest()` (3a, `lib/oidc-authorize-request.ts`) — client/redirect_uri/scope/
  response_type/state/nonce/PKCE, সব একসাথে validate করে। 7b এই একই ফাংশনটা আবার re-run করে,
  নতুন কোনো validation লজিক লেখেনি।
- `KNOWN_OIDC_SCOPES` (`lib/oidc-scope-validation.ts`, 2D) — `openid`/`profile`/`email`।

## যেটা যোগ করা হলো

### Phase 7a — Consent Data Model
| ফাইল | পরিবর্তন |
|---|---|
| `migrations/088_ayzen_oidc_user_consents.sql` | **নতুন** — `oidc_user_consents` টেবিল: `user_id`, `client_id`, `granted_scopes` (JSONB), `granted_at`, `revoked_at` (nullable, soft-revoke)। `(user_id, client_id)`-এ UNIQUE index — একটা জোড়ার জন্য একটাই active row, নতুন/বড় scope চাইলে UPDATE হয়, নতুন row না। `revoked_at IS NULL`-এর উপর একটা partial index (7d-এর "active consent list" read-এর জন্য, কিন্তু এই পাসে কোনো কোড সেটা পড়ে না) |
| `artifacts/api-server/src/lib/oidc-user-consents.ts` | **নতুন** — `getActiveConsent(userId, clientId)` (read, `revoked_at IS NULL`) + `grantConsent(userId, clientId, scopes)` (`INSERT ... ON CONFLICT (user_id, client_id) DO UPDATE`, `revoked_at` বরাবর NULL-এ রিসেট হয়)। No FK to `oidc_clients` — `oidc_authorization_codes`/`oidc_refresh_tokens`-এর একই precedent। |

### Phase 7b — Consent UI (backend + frontend)
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-consent-scope-copy.ts` | **নতুন** — `describeConsentScopes(scopes)`, pure। `openid`/`profile`/`email`-এর জন্য fixed label+description mapping; অচেনা scope-এর জন্য generic fallback কপি (কখনো hit হওয়ার কথা না, কারণ `validateOidcScopes()` তার আগেই reject করে দেয়)। |
| `artifacts/api-server/src/routes/oidc-consent.ts` | **নতুন** — `GET /oidc/consent/info`, `POST /oidc/consent/allow`, `POST /oidc/consent/deny`। তিনটাই একটা `returnTo=/oidc/authorize?...` value নেয়, `parseReturnTo()` দিয়ে আবার `RawOidcAuthorizeRequest`-এ ভাঙে, `validateOidcAuthorizeRequest()` দিয়ে পুরো request re-validate করে, আর client `is_first_party` হলে `consent_not_required` দিয়ে reject করে (belt-and-suspenders — 7c-এর routing-ই আসল গেট, কিন্তু এই তিনটা route independently reachable বলে নিজেরাও চেক করে)। Allow → `grantConsent()` কল করে সেশনের `userId`-এর বিপরীতে, `resumeUrl` (একই `returnTo`) রিটার্ন করে। Deny → verified `redirectUri`-তে RFC 6749 §4.1.2.1-এর `access_denied` + `state` echo করে redirect URL বানায়, কিছুই persist করে না। সব রুট `requireAuth` + `authLimiter`। |
| `artifacts/api-server/src/app.ts` | `oidcConsentRouter` মাউন্ট — bare origin, `/api` নয়, অন্যান্য `/oidc/*` router-এর মতোই |
| `artifacts/ayzen/src/lib/oidc-consent-api.ts` | **নতুন** — `getOidcConsentInfo()` / `allowOidcConsent()` / `denyOidcConsent()`, bearer-token authed fetch wrapper (`lib/passkey-api.ts`-এর একই shape) |
| `artifacts/ayzen/src/pages/oidc-consent.tsx` | **নতুন** — `/oidc/consent` পেজ। Sign-in না থাকলে `/login?return_to=<নিজের URL>`-এ bounce করে; থাকলে `GET .../info` কল করে client name + per-scope কপি দেখায়; Allow/Deny বাটন `window.location.href`-এ full navigation করে (both target server routes, SPA route না) |
| `artifacts/ayzen/src/App.tsx` | `/oidc/consent` route যোগ — `/login`/`/oidc/callback`-এর মতোই standalone, `ProtectedRoute`/`AppLayout`-এর বাইরে |
| `artifacts/ayzen/src/pages/login.tsx` | `oidcReturnTo`-এর allow-list `/oidc/authorize`-এর পাশাপাশি `/oidc/consent`-ও accept করে এখন — consent পেজের নিজের auth-bounce এই একই allow-list ব্যবহার করে |

### টেস্ট
| ফাইল | কাভার করে |
|---|---|
| `scripts/src/test-oidc-consent.ts` | `describeConsentScopes()` (known scope, request-order preservation, unknown-scope fallback, empty list) + `parseReturnTo()` (well-formed parse, `/oidc/authorize` prefix-বহির্ভূত value reject — including একটা absolute URL যার path অংশ `/oidc/authorize` দিয়ে শুরু কিন্তু পুরো string না, non-string input, bare query-string-বিহীন path) |
| `getActiveConsent()` / `grantConsent()` | live `DATABASE_URL` লাগে বলে এই পাসে script-এ কাভার করা হয়নি — `persistAuthorizationCode()`/`persistRefreshToken()`-এর একই precedent (manual/integration verification) |

## স্কোপ ডিসিপ্লিন — এই পাসে ইচ্ছাকৃতভাবে যা করা হয়নি
- **`/oidc/authorize`-এর নিজের ফ্লো-তে কোনো হুক নেই।** এই পাসের কোনো কোড কাউকে `/oidc/consent`-এ
  redirect করে না — সেটা explicitly 7c-এর কাজ ("routes/oidc-authorize.ts-এর existing flow-এ hook করা")।
  আজকের অবস্থায় এই তিনটা route + পেজ পুরোপুরি কাজ করে কিন্তু শুধু সরাসরি URL দিয়ে reach করা যায়
  (manual testing) — ঠিক যেমন 3b-এর আগে `lib/oidc-authorization-codes.ts` পুরোপুরি তৈরি ছিল কিন্তু
  কোনো route সেটা কল করত না।
- **Allow-এর পরে কোনো code issuance নেই এখানে।** `grantConsent()` সেভ করে `resumeUrl` (মূল
  `/oidc/authorize?...`) রিটার্ন করে দেয় — আসল code issuance বরাবরের মতোই `oidc-authorize.ts`-এর
  নিজের কাজ, যেটা আজ consent-এর ব্যাপারে কিছুই জানে না (তাই আজকে সেখানে ফিরে গেলে normal flow-ই চলে,
  ঠিক প্রথমবারের মতোই — 7c এসে এটাকেই "consent থাকলে স্ক্রিন স্কিপ করো" বানাবে)।
- **কোনো scope-superset তুলনা নেই।** 7e-এর নিজের টেক্সট এই pure ফাংশনটাকে নাম ধরে দাবি করে — এই পাসে
  Allow সবসময় ঠিক সেই scope-গুলোই গ্রান্ট করে যা এই নির্দিষ্ট request-এ চাওয়া হয়েছে, কম-বেশি না।
- **কোনো revoke নেই।** `oidc_user_consents.revoked_at`-এ এই পাসের কোনো কোড লেখে না — সেটা 7d
  (consent row soft-revoke + token revocation + backchannel logout)।
- **কোনো "list active consents" নেই।** Security page-এর Connected Apps সেকশন 7d-এর কাজ; সেই read
  path speculatively এখানে বানানো হয়নি।
- **`oidc_clients`-এ কোনো `client_name` কলাম যোগ করা হয়নি।** 7a-এর নিজের কলাম-লিস্টে এটা নেই।
  Consent স্ক্রিনে client-এর নাম হিসেবে আপাতত raw `client_id` দেখানো হয় (`clientDisplayName`
  ফিল্ডে) — সৎ placeholder, লুকানো bug না। `scripts/src/seed-oidc-clients.ts`-এর `label` ফিল্ড
  DB-তে কখনো লেখা হয় না বলে সেটাও ব্যবহারযোগ্য না। আসল সমাধান 8a-এর dynamic registration-এর
  `client_name` — যেটা তখন `oidc_clients`-এ একটা কলাম হিসেবে persist করতে হবে (এই roadmap নিজেও
  সেই কলাম কবে/কীভাবে যোগ হবে তা 7a/7b-তে specify করেনি; 8a implement করার সময় এই ফাঁকটা বন্ধ
  করতে হবে)।

## এখনো বাকি (এই পাসের বাইরে)
- **7c — Authorize-Flow Integration:** `routes/oidc-authorize.ts`-এ hook করা — non-first-party client
  আর কোনো active consent না থাকলে `/oidc/consent`-এ পাঠানো; consent থাকলে স্ক্রিন স্কিপ করে সরাসরি
  code issuance।
- **7d — Consent Revocation:** Security page-এ Connected Apps লিস্ট (7a-এর টেবিল থেকে), revoke বাটন,
  soft-revoke + refresh token revocation + backchannel logout।
- **7e — Scope Change Re-Prompt:** ইতিমধ্যে-granted scope-এর superset চেক (pure function), নতুন
  scope চাইলে re-prompt, শুধু নতুন scope-গুলো হাইলাইট করা কনসেন্ট স্ক্রিনে।
