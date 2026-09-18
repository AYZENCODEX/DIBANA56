# OIDC Roadmap — Season 5, Phase 10a: Introspection Endpoint (RFC 7662-স্কোপড-ডাউন)

## যা আগে থেকেই ছিল
- `lib/oidc-token-client-auth.ts` (Phase 3c-b) — `client_id`/`client_secret`
  POST-body client authentication, `/oidc/token`-এর সাথে শেয়ার করা।
- `lib/oidc-access-token-verification.ts` (Phase 4c-a/4c-b/4c-c) —
  `verifyOidcAccessToken()`: signature/issuer/expiry/kid ভেরিফাই করে,
  `sub`/`scope`/`aud` বের করে দেয়। `exp`/`iat` আগে কখনো এক্সপোর্ট হতো না
  (`GET /oidc/userinfo`, `GET /oidc/resource/*` — এই দুই existing caller-এর
  কারো দরকার হয়নি)।
- `lib/oidc-refresh-tokens.ts` (Phase 3e-a/3e-b/3e-d) —
  `lookupRefreshToken()` (hash দিয়ে non-consuming lookup) +
  `isRefreshTokenExpired()` (pure expiry check)। `revoked_at` কলাম
  migration 082-এ ছিল, কিন্তু কোনো কোড কখনো এটা লিখতো না বা পড়তো না।
- Roadmap-এর নিজের 7d/9d/9c section — এবং `lib/oidc-client-admin.ts`/
  `lib/oidc-user-consents.ts`-এর নিজেদের header — একই ভাষায় তিনবার নাম
  ধরে বলে রেখেছিল: token revocation ছাড়া consent-revoke/suspend/delete
  কসমেটিক থেকে যায়। Phase 10 (10a-10e) সেই gap বন্ধ করার শুরু — 10a তার
  প্রথম sub-phase, introspect (read-only), revoke (10b, mutating) না।

## যেটা যোগ করা হলো

| ফাইল | পরিবর্তন |
|---|---|
| `lib/oidc-introspection-request.ts` | **নতুন** — `parseOidcIntrospectionRequest()`, pure/DB-free। `RawOidcIntrospectionRequest` (`token`, `tokenTypeHint`, `clientId`, `clientSecret`) — RFC 7662 §2.1-এর body scoped-down। `firstBodyValue()` `oidc-token-request.ts`-এর নিজের copy, শেয়ার করা হয়নি (এই codebase-এর established "প্রতিটা parsing file নিজের ছোট helper রাখে" precedent) |
| `lib/oidc-access-token-verification.ts` | **আপডেট (additive)** — `VerifiedOidcAccessToken`-এ `exp`/`iat` (unix seconds) যোগ। VERIFICATION লজিকের একটা লাইনও বদলায়নি — `decoded.exp`/`decoded.iat` আগে থেকেই present ছিল, শুধু discard করা হতো। দুই existing caller (`routes/oidc-userinfo.ts`, `routes/oidc-resource.ts`) অপরিবর্তিত থাকে — দুটোই শুধু নিজেদের দরকারি field destructure করে |
| `lib/oidc-token-introspection.ts` | **নতুন** — `introspectOidcToken(token, tokenTypeHint, requestingClientId)`: `introspectAsAccessToken()` (verifyOidcAccessToken পুনর্ব্যবহার) আর `introspectAsRefreshToken()` (lookupRefreshToken + isRefreshTokenExpired পুনর্ব্যবহার) — কোনো নতুন verification/storage লজিক না, শুধু দুটো existing primitive-এর উপর একটা classifier। `token_type_hint` শুধু try-order ঠিক করে, hard filter না (RFC 7662-এর নিজের ভাষা অনুযায়ী) |
| `routes/oidc-introspect.ts` | **নতুন** — `POST /oidc/introspect`: parse → `token` missing হলে `invalid_request` → client auth (`authenticateOidcTokenClient()` পুনর্ব্যবহার) fail হলে `invalid_client` → `introspectOidcToken()` কল করে ফলাফল যা-ই হোক (`active: true` বা `active: false`) `200`-এ রিটার্ন। বেয়ার-অরিজিন, `authLimiter`, ঠিক `/oidc/token`-এর মতোই |
| `app.ts` | `import oidcIntrospectRouter` + `app.use(oidcIntrospectRouter)` — একই বেয়ার-অরিজিন মাউন্টিং সিকোয়েন্স, `oidcRegisterRouter`-এর পরে, `/api`-এর আগে |

### নিরাপত্তা: শুধু নিজের টোকেন introspect করা যায়

RFC 7662 নিজে এটা mandate করে না (§2.1 শুধু বলে caller-কে "authorized"
হতে হবে, "authorized" মানে কী সেটা deployment-এর সিদ্ধান্ত)। এই
codebase-এ "resource server" বলে client থেকে আলাদা কোনো concept নেই —
প্রতিটা caller ঠিক `/oidc/token`-এর মতোই client_secret দিয়ে authenticate
করে। তাই: authenticate করা client-এর নিজের `client_id` টোকেনের নিজস্ব
`client_id`/`aud`-এর সাথে না মিললে response `{ active: false }` — অন্য
কোনো client-এর টোকেন সম্পর্কে কোনো তথ্য (scope, exp, user) কখনো leak হয়
না। এটা `lib/oidc-token-client-auth.ts`-এর নিজের "invalid_client
oracle-না-বানানো" discipline-এরই সম্প্রসারণ — এখানে যা leak হতে পারতো
সেটা একটা boolean না, একজন real user-এর session activity।

### `revoked_at` — প্রথমবার পড়া হলো, এখনো কেউ লেখে না

`introspectAsRefreshToken()` `stored.revokedAt !== null` চেক করে —
যদিও এই zip-এ এখনো কোনো কোড `revoked_at` সেট করে না (Phase 10b-এর কাজ)।
Forward-compatible reader — 10b যেদিন থেকে লিখতে শুরু করবে, সেদিন থেকে
10a-এর response আপনা-আপনি সঠিক হয়ে যাবে, কোনো কোড বদলানো ছাড়াই। ঠিক
`validateOidcClientId()`-এর `registration_status` পড়ার precedent, Phase
9 আসার আগেই।

### টেস্ট

| ফাইল | কাভার করে |
|---|---|
| `scripts/src/test-oidc-token-introspection.ts` | `parseOidcIntrospectionRequest()` (সবকয়টা field, missing/empty/array/non-string input) + `introspectOidcToken()`-এর access-token branch **real** run — `issueOidcAccessToken()` দিয়ে সত্যিকারের টোকেন mint করে, নিজের client দিয়ে introspect করলে সঠিক claims (`sub`/`client_id`/`scope`/`token_type`/`exp`/`iat`) ফেরত আসে, hint দিলে/না-দিলে একই ফলাফল, আর ভিন্ন client দিয়ে introspect করলে `{ active: false }` — টোকেনের claims কখনো leak হয় না। DB টাচ হয় না কারণ access-token branch প্রথমেই resolve হয়ে যায় |
| কাভার হয়নি | `introspectAsRefreshToken()`/`lookupRefreshToken()` (লাইভ DB লাগে — `test-oidc-refresh-tokens.ts`-এর নিজের একই precedent), আর `introspectHandler()`-এর client-auth অংশ (`getOidcClientById()` DB read) — `routes/oidc-token.ts`-এর নিজের already-tested শেপের বিপরীতে হাতে-review করা |
| এই sandbox-এ | `pnpm`/`node_modules` install করা যায়নি (workspace monorepo, network-এ npm registry থাকলেও পুরো install চালানো এই পাসে সম্ভব হয়নি) — তাই টেস্ট ফাইল লেখা হয়েছে ঠিক `test-oidc-userinfo.ts`-এর মতো "pure/DB-free অংশ real run হবে" ডিজাইনে, কিন্তু আসলে execute করে verify করা যায়নি এই পাসে। TS-level manual review করা হয়েছে (existing `verifyOidcAccessToken()`/`issueOidcAccessToken()`/`lookupRefreshToken()` সিগনেচারের বিপরীতে টাইপ মিলিয়ে) |

## স্কোপ ডিসিপ্লিন — এই পাসে ইচ্ছাকৃতভাবে যা করা হয়নি
- **`POST /oidc/revoke` নেই।** Phase 10b, আলাদা পাস।
- **`revokeAllTokensForClientAndUser()`/`revokeAllTokensForClient()` (cascade) নেই।** Phase 10c —
  এগুলো ছাড়া 7d (consent revoke) আর 9d (admin suspend) এখনো টোকেন
  invalidate করে না, ঠিক যেমন `CHANGES_OIDC_ADMIN_APPROVAL_AUDIT_PHASE9D_9E.md`
  নিজেই বলে রেখেছিল।
- **Backchannel-logout hook নেই cascade-এর সাথে।** Phase 10d — cascade-ই
  নেই এখনো, তাই hook করার কিছু নেই।
- **`/.well-known/openid-configuration`-এ `introspection_endpoint` যোগ হয়নি।**
  Phase 10e — এই এন্ডপয়েন্ট এখন বাস্তবেই আছে, কিন্তু discovery metadata-তে
  এখনো advertise করা হয়নি; roadmap-এর নিজের যুক্তি অনুযায়ী discovery
  সবসময় সবার শেষে, কারণ এটা শুধু output *publish* করে, নতুন কিছু বানায় না।
- **কোনো নতুন migration নেই।** 10a শুধু existing `oidc_clients`/
  `oidc_refresh_tokens` টেবিল আর access-token JWT পড়ে — কোনো নতুন কলাম/টেবিল
  দরকার হয়নি (`revoked_at` migration 082-এই ছিল, শুধু আগে কেউ পড়তো না)।
- **`token_type_hint`-এর কোনো enum validation নেই parsing layer-এ।** RFC
  7662 §2.1 নিজেই বলে সার্ভার এই parameter ignore করতে পারে — তাই এটা শুধু
  try-order ঠিক করে, অন্য কোনো মান দিলে (বা কিছু না দিলে) দুটো branch-ই
  চেষ্টা করা হয়, error না।

## এখনো বাকি (এই ডকুমেন্টের ঘোষিত scope-এর বাইরে)
- **Phase 10b — Revocation Endpoint** (`POST /oidc/revoke`, RFC 7009): single-token
  immediate invalidation — access token-এর জন্য একটা denylist/store যোগ
  (এই পাসে introspection-এর জন্য যেটা লাগেনি, কারণ read-only), refresh
  token-এর জন্য existing row delete/invalidate।
- **Phase 10c — Cascade Revocation.**
- **Phase 10d — Cascade + Backchannel Logout.**
- **Phase 10e — Discovery Metadata Update.**

একবার 10b-10e শেষ হলে, 7d আর 9d দুটোই এই একই `revokeAllTokensFor*()`
ফাংশন কল করবে — কোনো দ্বিতীয় revocation logic ছাড়াই, ঠিক roadmap নিজে যা
বলেছে।
