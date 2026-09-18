# OIDC Roadmap — Season 3, Phase 6e-a: Propagation Interface

Phase 6d-এর সিদ্ধান্ত (`CHANGES_OIDC_LOGOUT_PROPAGATION_DECISION_PHASE6D.md`)
অনুযায়ী: **Back-Channel Logout**। এই সাব-ফেজ roadmap-এর নিজের ভাষায় শুধু
*"Create a clean abstraction"* — কোনো real HTTP dispatch, কোনো DB migration,
কোনো route wiring না।

## যা যোগ করা হলো

| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-logout-propagation.ts` | **নতুন** — Logout Token claim builder + RS256 signer (`buildLogoutTokenClaims()`/`issueOidcLogoutToken()`, `lib/oidc-id-token.ts`-এর pure/signed split-এর অভিন্ন প্যাটার্নে), আর propagation dispatch abstraction (`propagateBackchannelLogout()` + injected `OidcBackchannelLogoutDeliverFn`) |
| `scripts/src/test-oidc-logout-propagation.ts` | **নতুন** — claim shape (events/sid/no-nonce), real RS256 sign+verify round-trip, cross-key verification failure, আর fake `deliver()` দিয়ে dispatch orchestration-এর টেস্ট |

## ডিজাইন — কেন এই শেপ

- **`buildLogoutTokenClaims()`/`issueOidcLogoutToken()`** ঠিক
  `buildIdTokenClaims()`/`issueOidcIdToken()`-এর (Phase 4a) মতোই pure/signed
  split, একই active RS256 keypair (`getActiveKeypair()`) আর একই published
  JWKS (Phase 1e) trust chain ব্যবহার করে — নতুন key management বা নতুন
  verification path লাগেনি।
- **`LogoutTokenClaims`** আলাদা টাইপ, `IdTokenClaims` extend করে না — কারণ
  OpenID Back-Channel Logout 1.0 §2.4 অনুযায়ী Logout Token-এ `nonce` কখনোই
  থাকা যাবে না, আর `events`/`sid` ID token-এর অংশ না। এক টাইপ শেয়ার করলে
  ভবিষ্যতে ভুলে দুটোতেই `nonce` যোগ হয়ে যাওয়ার ঝুঁকি থাকত।
- **`sid: string | null`** (optional field না) — `OidcIdTokenBinding.nonce`-এর
  (Phase 4b) মতোই `null`-মানে-omit শেপ, যাতে caller ভুলে field-টা বাদ দিতে
  না পারে। এই provider আজ কোনো `sid` populate করে না (Phase 6d-c-এর নিজস্ব
  mapping-gap নোট — session-exchange প্রতিবার স্বতন্ত্র `jti` বানায়, কোনো
  OIDC `sid`-এর সাথে সম্পর্কিত না), তাই আপাতত সবসময় `null` পাস হবে।
- **`propagateBackchannelLogout(binding, target, deliver, now)`** — `deliver`
  injected, কখনো real `fetch()`-এ default করা হয়নি। কারণ, header-এ যেমন
  লেখা: *"there is no real registered `backchannel_logout_uri` to call
  yet"* — `oidc_clients` টেবিলে এখনো সেই কলাম নেই। এই injection-এর pattern
  Phase 6a-6c-এর `resolveClient` injection ডিজাইন-নোটের (`lib/oidc-logout-request.ts`)
  সরাসরি ধারাবাহিকতা।
- **`OidcBackchannelLogoutDeliveryResult`** একটা closed result type
  (`{ok:true}` বা `{ok:false, reason, detail?}`), exception থ্রো না —
  যাতে 6e-c (Failure Handling) কোনো try/catch যোগ না করেই failure reason-এর
  ওপর branch করতে পারে।

## যা ইচ্ছাকৃতভাবে এখানে নেই (পরবর্তী সাব-ফেজের কাজ)

- `oidc_clients.backchannel_logout_uri` কলাম/migration, ক্লায়েন্ট-ভিত্তিক target
  lookup — **6e-b (Sylo Integration)**।
- Real `deliver()` implementation (HTTP POST, `application/x-www-form-urlencoded`,
  §2.5), retry/backoff, dead-letter — **6e-c (Failure Handling)**।
- `oidc.backchannel_logout.*` observability events — **6e-d (Monitoring)**।
- কোনো route wiring (`routes/oidc-logout.ts`, `routes/auth.ts`, Security page
  revoke handlers এখনো এই ফাইল import করে না) — **6e-b**, শেষ পর্যন্ত
  end-to-end verify হবে **6e-e**-তে।
- Sylo-পাশের receiving endpoint (Logout Token verify করে নিজের local session
  invalidate করা, `sub` থেকে কোন `user_sessions` row মুছবে সেই resolution) —
  **6e-b**।

## টেস্ট

`scripts/src/test-oidc-logout-propagation.ts` কাভার করে:
- `buildLogoutTokenClaims()`: fixed `events` member, `iss`/`sub`/`aud`/`iat`/`exp`
  গণনা, `jti` passthrough, `sid` presence/absence (null → key বাদ), `nonce`
  কখনোই না, deterministic output।
- `issueOidcLogoutToken()`: active keypair দিয়ে real RS256 sign+verify,
  header-এ সঠিক `alg`/`kid`, signed claims বনাম pure builder output
  byte-for-byte মিল, প্রতি কলে ডিফল্ট `jti` আলাদা, ভিন্ন keypair দিয়ে
  verification fail করা।
- `propagateBackchannelLogout()`: injected `deliver()`-কে সঠিক target +
  একটা সত্যিকারের, verifiable Logout Token পাস করা, `deliver()`-এর
  success/failure result অবিকৃতভাবে ফেরত দেওয়া।

**পরিবেশগত সীমাবদ্ধতা (এই পাসে):** এই sandbox-এ network/`pnpm install`
অ্যাক্সেস নেই, তাই `npx tsx scripts/src/test-oidc-logout-propagation.ts`
বাস্তবে চালানো যায়নি এখানে — কোডটা `test-oidc-id-token-hint.ts` (Phase 6a-b)-এর
সাথে হুবহু একই dev-ephemeral-keypair pattern আর একই `jwt.sign`/`jwt.verify`
ব্যবহার অনুসরণ করে, যেটা ইতিমধ্যে এই কোডবেসে কাজ করে প্রমাণিত। বাস্তব dev
পরিবেশে `pnpm install`-এর পর এই কমান্ড চালিয়ে নিশ্চিত করা দরকার —
`test-oidc-clients.ts`-এর duplicate-client_id hand-verification নজিরের মতোই,
এটাকে একটা manual verification step হিসেবে ফ্ল্যাগ করা হলো।

## পরবর্তী সাব-ফেজ

**6e-b — Sylo Integration**: `oidc_clients.backchannel_logout_uri` migration,
central logout/revoke path থেকে dispatch hook, আর Sylo-পাশের receiving
endpoint।
