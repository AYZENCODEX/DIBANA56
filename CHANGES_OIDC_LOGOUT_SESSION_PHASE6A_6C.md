# OIDC Roadmap — Season 3, Phase 6a..6c: Logout + Session Tie-In

## যা আগে থেকেই ছিল
- `POST /auth/logout` (`routes/auth.ts`) — cookie clear + `revokeSessionByJti()`।
- `user_sessions` টেবিল, `lib/sessions.ts`-এর সব CRUD/revoke helper (Account SSO Sessions ফিচার)।
- OIDC-এর authorize/token/userinfo/discovery এন্ডপয়েন্ট (Season 1–2, Phase 5c-5e পর্যন্ত)।
- `oidc_clients.redirect_uris` — শুধু Authorization Code callback allow-list।
- কিন্তু OIDC-এর নিজের `end_session_endpoint` ছিল না — কোনো ক্লায়েন্ট (Sylo ইত্যাদি)
  RP-Initiated Logout দিয়ে সেন্ট্রাল সেশন সাইন-আউট করতে পারত না।

## যেটা যোগ করা হলো

### Phase 6a — RP-Initiated Logout Request
| ফাইল | পরিবর্তন |
|---|---|
| `migrations/084_ayzen_oidc_post_logout_redirect_uris.sql` | **নতুন** — `oidc_clients.post_logout_redirect_uris` (JSONB, `redirect_uris`-এর থেকে আলাদা registered list) |
| `lib/db/src/schema/oidc-clients.ts` | migration 084-এর সাথে মিলিয়ে Drizzle schema-তে `postLogoutRedirectUris` কলাম + `insertOidcClientSchema`-তে zod validation |
| `artifacts/api-server/src/lib/oidc-clients.ts` | `OidcClient`/`OidcClientDbRow`-এ `postLogoutRedirectUris` যোগ (mapper সহ) |
| `artifacts/api-server/src/lib/oidc-client-validation.ts` | `validateOidcPostLogoutRedirectUri()` — `validateOidcRedirectUri()`-এর মতোই exact-match, কিন্তু আলাদা result type (`invalid_post_logout_redirect_uri`) |
| `artifacts/api-server/src/lib/oidc-id-token.ts` | `verifyIdTokenHint()` (6a-b) — এই provider-এর নিজের ইস্যু করা ID token-কে RS256 verify করে, `sub`/`aud` রিটার্ন করে (expiry ignore করে, কারণ hint লাইভ ক্রেডেনশিয়াল না) |
| `artifacts/api-server/src/lib/oidc-discovery.ts` | discovery metadata-তে `end_session_endpoint` যোগ |
| `artifacts/api-server/src/lib/oidc-logout-request.ts` | **নতুন** — `parseOidcLogoutRequest()` (pure) + `validateOidcLogoutRequest()` (client resolution + post_logout_redirect_uri চেক) |
| `scripts/src/seed-oidc-clients.ts`, `test-seed-oidc-clients.ts` | পাঁচটা first-party client-এর জন্য `postLogoutRedirectUris` seed (`https://<id>.ayzen.tech/`) |

### Phase 6b — Session Termination
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/routes/oidc-logout.ts` | **নতুন** — `GET /oidc/logout` (`end_session_endpoint`)। রিকোয়েস্ট validate → নিজের session identify (`getTokenFromReq` + `verifyAuthToken`, কখনো `id_token_hint`-এর `sub` না) → `revokeSessionByJti()` + `clearSessionCookie()` → verified `post_logout_redirect_uri`-তে redirect অথবা `{ message: "Signed out" }` |
| `artifacts/api-server/src/app.ts` | `oidcLogoutRouter` মাউন্ট (bare origin, `authLimiter`, অন্যান্য `/oidc/*` router-এর মতোই) |

### Phase 6c — `user_sessions` Integration

**6c-a (Existing Revoke Logic Audit) + 6c-b (Logout-to-Revoke Binding):**
কোনো নতুন revoke লজিক লেখা হয়নি — ইচ্ছাকৃতভাবে। `routes/oidc-logout.ts` ঠিক সেই দুটো ফাংশনই
কল করে যা `POST /auth/logout` আগে থেকেই কল করত: `lib/sessions.ts`-এর `revokeSessionByJti(decoded.sid)`
আর `lib/session-cookie.ts`-এর `clearSessionCookie()`। Session identify করার লজিকও অভিন্ন
(`getTokenFromReq()` + `verifyAuthToken()` → `decoded.sid` — কখনোই `id_token_hint`-এর `sub` না,
কারণ hint টা প্রমাণ করে "কোন client-এর জন্য login হয়েছিল", "কোন ব্রাউজার এই request পাঠাচ্ছে" তা না)।

**6c-c (Device Session Consistency):** কোড পরিবর্তন লাগেনি, স্ট্রাকচারাল গ্যারান্টি —
দুটো path-ই একই `user_sessions.jti` row আপডেট করে, তাই Security page-এর device
list (`GET /auth/sessions`) আর তার নিজের revoke বাটন (`POST /auth/sessions/:id/revoke`)
কোনো দ্বিতীয়, স্বতন্ত্র "OIDC session" মডেলের সাথে sync রাখার দরকারই নেই — এমন কিছু নেই।

**6c-d (Cross-Path Verification):**
| ফাইল | কাভার করে |
|---|---|
| `scripts/src/test-oidc-logout-session-integration.ts` | **নতুন** — `routes/oidc-logout.ts` আর `routes/auth.ts` একই মডিউল থেকে একই ফাংশন import/call করে কিনা (source-level check, DB-free), + `respondToLogoutFailure()`-এর response shape। DB-dependent অংশ (session revoke হলে সত্যিই Security page-এ আর দেখা যায় না) — live `DATABASE_URL` লাগে বলে manual verification step হিসেবে ডকুমেন্ট করা হয়েছে, `test-oidc-clients.ts`-এর `duplicate client_id` hand-verification precedent অনুসরণ করে। |

### টেস্ট (Phase 6a)
| ফাইল | কাভার করে |
|---|---|
| `scripts/src/test-oidc-logout-request.ts` | `parseOidcLogoutRequest()` + `validateOidcLogoutRequest()` — সব branch (bare request, hint resolution, hint/client_id mismatch, unknown client, post_logout_redirect_uri match/near-match/wrong-list) |
| `scripts/src/test-oidc-id-token-hint.ts` | `verifyIdTokenHint()` — real RS256 round-trip, expired-but-signed hint, wrong key, unknown kid, wrong issuer, HS256 রিজেক্ট, malformed/missing claims |
| `scripts/src/test-oidc-clients.ts` | `postLogoutRedirectUris` মেপিং-এর নতুন assertion যোগ (আগের 2A-d টেস্টের সাথে) |

## ডিজাইন নোট — কেন `resolveClient` injected করা হলো (মূল uploaded ফাইলের থেকে ভিন্ন)
মূল খসড়া `lib/oidc-logout-request.ts` সরাসরি `getOidcClientById` import করে ব্যবহার করত,
আর তার টেস্ট একটা `@workspace/db`-এর `__oidcClientRows` stub-এর উপর নির্ভর করত যেটা এই
কোডবেসে **কোথাও নেই**। ফলে সেই টেস্ট import-এই fail করত। এটা ঠিক করা হয়েছে ফাইলটার নিজের
"inject the effectful boundary" ডিসিপ্লিন প্রয়োগ করেই — `verifyHint`-এর মতো, `resolveClient`ও
এখন injected parameter (required, defaulted না), আর `routes/oidc-logout.ts` আসল
`getOidcClientById` পাস করে। টেস্ট এখন একটা in-memory fake resolver ব্যবহার করে —
কোনো phantom DB stub লাগে না, আর কোডবেসের established DB-free টেস্ট কনভেনশনের সাথেও মেলে।

## এখনো বাকি (Phase 6c-এর বাইরে, পরবর্তী সাব-ফেজ)
- **6d — Logout Propagation Decision:** front-channel বনাম back-channel মূল্যায়ন, একটা মডেল বাছাই। এই পাসে কোনো implementation না।
- **6e — Sylo Logout Propagation:** 6d-এর সিদ্ধান্তের উপর নির্ভরশীল, তাই শুরুই হয়নি।
