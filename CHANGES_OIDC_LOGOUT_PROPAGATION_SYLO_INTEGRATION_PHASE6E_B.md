# OIDC Roadmap — Season 3, Phase 6e-b: Sylo Integration

Phase 6e-a-এর নিজের কথায়: *"6e-b supplies both the real `deliver` and the
real per-client target resolution once `oidc_clients.backchannel_logout_uri`
exists."* এই পাস ঠিক সেটাই করেছে, প্লাস roadmap-এর নিজের task list-এ থাকা
receiving-side (Sylo-পাশের) endpoint।

## যা যোগ/পরিবর্তন করা হলো

| ফাইল | পরিবর্তন |
|---|---|
| `migrations/085_ayzen_oidc_clients_backchannel_logout_uri.sql` | **নতুন** — `oidc_clients.backchannel_logout_uri` (nullable TEXT, fail-closed default) |
| `migrations/086_ayzen_user_sessions_origin_client.sql` | **নতুন** — `user_sessions.origin_client_id` (nullable TEXT + partial index) |
| `lib/db/src/schema/oidc-clients.ts` | Drizzle schema-তে `backchannelLogoutUri` কলাম যোগ (migration 085-এর মিরর) |
| `artifacts/api-server/src/lib/oidc-clients.ts` | `OidcClient`/`OidcClientDbRow`-এ `backchannelLogoutUri` ফিল্ড; নতুন `listBackchannelLogoutTargets()` |
| `artifacts/api-server/src/lib/oidc-logout-propagation.ts` | **আপডেট** — 6e-a-এর উপর appended: `resolveBackchannelLogoutTargets()`, real `deliverBackchannelLogoutOverHttp` (§2.5 POST), `dispatchBackchannelLogoutForUser()` |
| `artifacts/api-server/src/lib/oidc-backchannel-logout-receive.ts` | **নতুন** — receiving-side verifier, `handleInboundBackchannelLogout()` |
| `artifacts/api-server/src/routes/oidc-backchannel-logout.ts` | **নতুন** — `POST /oidc/backchannel-logout`, Sylo-র নিজের receiving endpoint |
| `artifacts/api-server/src/lib/sessions.ts` | `originClientId` ফিল্ড (`createSession()`/`UserSession`), নতুন `revokeSessionsByUserAndOriginClient()` |
| `artifacts/api-server/src/routes/auth.ts` | `POST /auth/session-exchange`-এ ঐচ্ছিক `client_id` ভ্যালিডেশন + ট্যাগিং; `POST /auth/logout`, `revokeSession`, `revokeAllSessionsExcept`-এর প্রতিটা সফল revoke-এর পর `void dispatchBackchannelLogoutForUser(...)` |
| `artifacts/api-server/src/routes/oidc-logout.ts` | RP-initiated logout-এর নিজস্ব session revoke-এর পরেও `void dispatchBackchannelLogoutForUser(...)` |
| `artifacts/api-server/src/app.ts` | নতুন `oidcBackchannelLogoutRouter` মাউন্ট (bare origin, `/oidc/*`-দের পাশে) |
| `artifacts/ayzen/src/lib/sylo-oidc-session-exchange.ts` | request body-তে `client_id: "sylo"` যোগ |
| `scripts/src/seed-oidc-clients.ts` | Sylo-র জন্য real `backchannelLogoutUri` seed করা (বাকি চারটা `null`-ই থাকে) |
| `scripts/src/test-oidc-backchannel-logout-receive.ts` | **নতুন** — receiving-side verifier-এর pure-verification টেস্ট |
| `scripts/src/test-oidc-clients.ts`, `test-oidc-scope-validation.ts`, `test-oidc-client-request-validation.ts`, `test-oidc-logout-request.ts`, `test-oidc-client-validation.ts`, `test-oidc-authorize-request-validation.ts`, `test-oidc-phase2-exit.ts` | fixture-এ নতুন required ফিল্ড (`backchannelLogoutUri`) যোগ করে TypeScript shape ঠিক রাখা হলো |

## ডিজাইন — কেন এই শেপ

- **`backchannel_logout_uri` আলাদা কলাম** (JSONB না, plain TEXT) — এটা
  ক্লায়েন্ট প্রতি ঠিক একটামাত্র URI, কোনো list না। migration 084-এর মতোই
  `redirect_uris`/`post_logout_redirect_uris`-এর থেকে independent — একটা
  server-to-server event delivery target, ব্রাউজার redirect না।
- **`origin_client_id` (migration 086) userId-না, session-scoped ট্যাগ** —
  `createSession()`-এ লেখা হয় একবারই, কখনো mutate হয় না। `null` মানে
  "সাধারণ Central login বা AYZEN Astra extension exchange", কোনো OIDC
  client-এর জন্য না। শুধু `POST /auth/session-exchange`-এ recognized
  `client_id` থাকলেই non-null হয়।
- **`dispatchBackchannelLogoutForUser(userId)` — userId-scoped, sid-scoped
  না** — কারণ Logout Token-এ কখনোই `sid` populate করা হয় না (6e-a-এর নিজস্ব
  ডিজাইন সিদ্ধান্ত), তাই sending side "এই userId-এর জন্য প্রতিটা
  registered client-কে একটা করে ইভেন্ট" ছাড়া বেশি কিছু জানাতে পারে না।
  Receiving side (`origin_client_id`) সেটাকে client-নির্দিষ্ট করে সংকুচিত
  করে।
- **প্রতিটা call site-এ `void dispatchBackchannelLogoutForUser(...)`,
  কখনো `await` না** — এটা fire-and-forget হওয়া *আবশ্যক*: Sylo আউটেজ বা
  DB hiccup কখনোই ইউজারের নিজের successful logout/revoke response ব্লক বা
  ব্যর্থ করতে পারবে না। `dispatchBackchannelLogoutForUser()` নিজেই প্রতিটা
  ব্যর্থতা গিলে নেয় (log করে, কখনো re-throw করে না) — তাই caller-দের নিজেদের
  try/catch দরকার হয় না।
- **`deliverBackchannelLogoutOverHttp` — no retry** — একটা single-attempt
  HTTP POST, ok/not-ok result অবিকৃত ফেরত দেয়। Retry/backoff/dead-letter
  policy ইচ্ছাকৃতভাবে যোগ করা হয়নি — সেটা 6e-c (Failure Handling)-এর
  নিজস্ব scope, এখানে speculate করা হয়নি।
- **Receiving-side verification `verifyIdTokenHint()`-এর অভিন্ন প্যাটার্ন
  অনুসরণ করে** (`resolveVerificationKeys(kid)`, `decodeHeader()`) কিন্তু
  একটা গুরুত্বপূর্ণ পার্থক্যসহ: `exp` **enforce করা হয়** (id_token_hint-এর
  `ignoreExpiration: true`-এর বিপরীতে) — কারণ একটা Logout Token একটা
  live, ২-মিনিট-TTL ইভেন্ট নোটিফিকেশন, কোনো পরে-আবার-পড়া credential না।
- **`aud` অবশ্যই একটা real registered `client_id`-এর সাথে মিলতে হবে** —
  `oidcClientExists()` দিয়ে চেক করা হয় revoke করার *আগে*, যাতে জাল/typo করা
  `aud` কখনো এমন কোনো `client_id`-কে "revoke" করতে না পারে যেটা আসলে কোনো
  real session-কে কখনো ট্যাগ করতেই পারত না।
- **`nonce` claim থাকলে reject** — §2.4-এর নিজস্ব explicit নিষেধাজ্ঞা;
  একটা Logout Token কখনোই authentication-freshness প্রমাণ না।

## যা ইচ্ছাকৃতভাবে এখানে নেই (পরবর্তী সাব-ফেজের কাজ)

- Retry/backoff, dead-letter handling — **6e-c (Failure Handling)**।
- `oidc.backchannel_logout.*`-এর জন্য structured metrics/dashboards/alerting
  (এই পাসে শুধু `logger.info`/`logger.warn` call যোগ হয়েছে, কোনো নতুন
  observability infrastructure না) — **6e-d (Monitoring)**।
- Full end-to-end verification (real login → real revoke → real
  propagated logout → Sylo-side session সত্যিই invalid হওয়া, লাইভ DB-সহ)
  — **6e-e (E2E Logout Verification)**।

## টেস্ট

`scripts/src/test-oidc-backchannel-logout-receive.ts` কাভার করে (pure
verification path, কোনো live DB ছাড়াই): unsupported alg, foreign-keypair
signature failure, expired token, wrong issuer, `nonce` present, missing/
wrong `events` claim, malformed `sub`/`aud`।

**DB-নির্ভর অংশ (`unknown_client` branch, আর সম্পূর্ণ success path-এর
`revokeSessionsByUserAndOriginClient()` call) এই পাসে exercise করা হয়নি** —
`test-oidc-clients.ts`-এর নিজস্ব precedent-এর মতোই, এটা লাইভ dev DB-এর
বিপরীতে হাতে-verify করা দরকার।

**পরিবেশগত সীমাবদ্ধতা (এই পাসে):** এই sandbox-এ network/`pnpm install`
অ্যাক্সেস নেই, তাই কোনো টেস্ট স্ক্রিপ্ট (নতুন বা বিদ্যমান) বাস্তবে চালিয়ে
দেখা যায়নি এখানে। কোডটা 6e-a/6a-b-এর প্রমাণিত dev-ephemeral-keypair প্যাটার্ন
অনুসরণ করে — বাস্তব dev পরিবেশে `pnpm install`-এর পর
`npx tsx scripts/src/test-oidc-backchannel-logout-receive.ts` (এবং
`086`/`085` migration দুটো Supabase SQL Editor-এ যথাক্রমে ক্রমে) চালিয়ে
নিশ্চিত করা দরকার।

## পরবর্তী সাব-ফেজ

**6e-c — Failure Handling**: প্রতিটা delivery attempt ব্যর্থ হলে safe
behavior (retry/backoff নীতি, dead-letter, বা অন্তত repeated-failure
সনাক্তকরণ) সংজ্ঞায়িত করা।
