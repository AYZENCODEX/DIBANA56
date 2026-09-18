# OIDC Roadmap — Season 3, Phase 6d: Logout Propagation Decision

**এই সাব-ফেজে কোনো কোড পরিবর্তন নেই।** Roadmap-এর নিজের কথায়:
> No broad implementation in this sub-phase.

6d একটা আর্কিটেকচার সিদ্ধান্ত — front-channel না back-channel — যেটা 6e
(Sylo Logout Propagation)-এর implementation শুরু হওয়ার আগে আলাদা করে নেওয়ার
কথা `ayzen-oidc-roadmap-season1-v4.md`-এই বলা ছিল। এই ডকুমেন্ট সেই decision
record।

---

## 6d-a — Requirements: "logout everywhere" মানে কী (এই scope-এ)

**যা এই মুহূর্তে সত্যি (Phase 6a-6c শেষে):**

- `GET /oidc/logout` (`routes/oidc-logout.ts`, Phase 6a-6b) ইতিমধ্যে caller-এর
  **নিজের** browser session (`ayzen_session` cookie-র `sid`) revoke করে —
  ঠিক `POST /auth/logout`-এর মতোই, `revokeSessionByJti()` দিয়ে।
- Security page-এর "Sign out of all other sessions" ইতিমধ্যে আছে
  (`revokeAllSessionsExcept()`, `lib/sessions.ts`) — একজন user নিজে থেকে
  সবগুলো device/session revoke করতে পারে।
- কিন্তু Sylo-র নিজের local session **আলাদা** `user_sessions` row —
  `POST /auth/session-exchange` প্রতিবার একটা নতুন `createSession()` কল করে
  নিজের `jti` বানায় (`sylo-oidc-session-exchange.ts` → `routes/auth.ts`-এর
  session-exchange handler)। অর্থাৎ একজন user-এর কাছে *কমপক্ষে দুটো* স্বতন্ত্র
  `user_sessions` row থাকতে পারে একই মুহূর্তে: main SPA cookie-র session, আর
  Sylo-র OIDC login থেকে পাওয়া session-exchange-এর session। একটা revoke হলে
  অন্যটা **স্বয়ংক্রিয়ভাবে** revoke হয় না — এটাই propagation ছাড়া বর্তমান gap।

**তাহলে "logout everywhere" (এই scope-এ, শুধু Sylo) মানে দাঁড়ায়:**

1. Central Account (main SPA / `POST /auth/logout`)-এ logout করলে, বা
   Security page থেকে কোনো session revoke করলে → Sylo-তে established সেই
   user-এর OIDC-origin session(গুলো)ও দ্রুত invalid হয়ে যাবে।
2. `GET /oidc/logout` (RP-initiated, Sylo থেকে শুরু হওয়া) দিয়ে logout করলে →
   central session-ও (6a-6c-এ যা ইতিমধ্যে হয়) আর Sylo-র own local session-ও
   — দুটোই এক অ্যাকশনে শেষ হবে।
3. "দ্রুত" মানে **পরবর্তী কোনো API call fail হওয়া পর্যন্ত অপেক্ষা** না করে —
   `getUserFromToken()`-এর `isSessionRevoked()` চেক আগে থেকেই আছে বলে
   revoke হওয়ার পরের যেকোনো API call এমনিতেই 401 দেবে (এটা passive
   propagation, ইতিমধ্যে বিদ্যমান)। Requirement হলো এর চেয়ে ভালো: Sylo-র
   own UI নিজে থেকে সাইন-আউট state দেখাক, ব্যবহারকারী পরের ক্লিকে reject
   হওয়ার অপেক্ষায় না থেকে।
4. **এই scope-এ যা লাগবে না:** admin-initiated bulk revoke, consent screen,
   third-party (non-first-party) client notification, refresh-token
   revocation cascade — এসব Season 4/5 future scope (roadmap §10), 6e-এ
   হাত দেওয়া হবে না।

---

## 6d-b — Front-Channel Evaluation

OIDC **Front-Channel Logout 1.0** মডেলে OP প্রতিটা RP-কে একটা
`frontchannel_logout_uri` রেজিস্টার করতে বলে, আর logout ঘটলে OP নিজের
logout-confirmation পেজে (অথবা `end_session_endpoint`-এর response-এ) প্রতিটা
সাইন-ইন-করা RP-এর জন্য একটা hidden `<iframe>` লোড করে, যাতে প্রতিটা RP
নিজের browser-context-এ নিজের cookie/local-state clear করার সুযোগ পায়।

**এই architecture-এ যা সুবিধায় আসে:**
- Third-party cookie সমস্যা এখানে **নেই** — Sylo (`sylo.ayzen.tech`) আর
  Account (`ayzen.tech`) একই eTLD+1 (`*.ayzen.tech`)-এর অধীনে, তাই
  `SameSite=Lax` cookie (যা `lib/session-cookie.ts` আগে থেকেই ব্যবহার করে)
  একটা first-party-ই থাকে, আধুনিক browser-এর third-party-iframe/cookie
  ব্লকিং-এর শিকার হয় না যেভাবে সত্যিকারের cross-site RP-দের হতো।

**যেসব কারণে এই scope-এ অনুপযুক্ত:**
- **শুধু browser উপস্থিত থাকলে কাজ করে।** RP-initiated logout
  (`GET /oidc/logout`, Sylo থেকে শুরু) হলে front-channel চলবে, কিন্তু
  requirement #1 (Central থেকে বা Security page থেকে revoke হলে Sylo-ও
  সাথে সাথে জানুক) — এখানে **কোনো browser navigation-ই ঘটছে না**।
  `POST /auth/logout` বা `revokeAllSessionsExcept()` একটা fetch/API কল,
  কোনো redirect চেইন নেই যেখানে iframe বসানো যায়। Front-channel মূলত
  একমুখী (RP-initiated থেকে অন্য RP-দের দিকে) — এই codebase-এর দ্বিমুখী
  প্রয়োজন (Central → Sylo-ও, Sylo → Central-ও) এতে পুরোপুরি cover হয় না।
- **কোনো delivery guarantee নেই।** Iframe লোড ব্যর্থ হলে (ad-blocker, pop-up
  blocker, ব্যবহারকারী পেজ বন্ধ করে ফেলল, JS error) — OP-এর কাছে জানার কোনো
  উপায় নেই যে RP আসলেই সাইন-আউট হয়েছে কিনা। Retry নেই।
- **নতুন UI দরকার হতো।** AYZEN-এর `end_session_endpoint`
  (`routes/oidc-logout.ts`) আজ direct redirect/JSON response দেয় (6b-d) —
  front-channel করতে হলে একটা মধ্যবর্তী "logout dispatcher" পেজ বানাতে হতো
  যেখানে iframe বসে, যা Season 3-এর ঘোষিত scope-এর বাইরে একটা নতুন surface
  (roadmap §1.3: "Do not redesign unrelated architecture").

**সিদ্ধান্ত-প্রাসঙ্গিক উপসংহার:** Front-channel এই মুহূর্তে requirement #1-কে
কভারই করে না (browser navigation ছাড়া trigger হওয়ার উপায় নেই), তাই একা এটা
এই scope-এর জন্য যথেষ্ট নয়।

---

## 6d-c — Back-Channel Evaluation

OIDC **Back-Channel Logout 1.0** মডেলে OP প্রতিটা RP-কে একটা
`backchannel_logout_uri` রেজিস্টার করতে বলে, আর logout ঘটলে OP সরাসরি
server-to-server একটা signed **Logout Token** (JWT, `events` claim-এ
`http://schemas.openid.net/event/backchannel-logout`) সেই URI-তে POST করে —
browser-এর presence/state-এর ওপর নির্ভর করে না।

**এই architecture-এ যা সুবিধায় আসে:**
- **Browser উপস্থিত থাকা লাগে না।** Central logout, Security-page revoke,
  বা Sylo-initiated RP logout — যেকোনো trigger থেকেই server-side একটা
  direct call/event হিসেবে ছুঁড়ে দেওয়া যায়। এটাই requirement #1 আর #2
  দুটোই এক মডেলে কভার করে।
- **Signing infrastructure আগে থেকেই আছে।** `issueOidcIdToken()`
  (`lib/oidc-id-token.ts`)-এর মতোই একটা Logout Token সেই একই active RS256
  keypair (`lib/jwt-keys.ts`) দিয়ে sign করা যায় — নতুন key management লাগে
  না, verification-এর জন্য RP ইতিমধ্যে প্রকাশিত JWKS-ই (Phase 1e) ব্যবহার
  করতে পারবে।
- **Retry/observability সহজ।** এটা একটা সাধারণ outbound HTTP call (বা,
  Sylo যেহেতু আসলে *একই codebase-এর একই Express app*-এ চলে — দেখুন
  `subdomain-app.ts`-এর নিজের হেডার: "This is intentionally NOT a separate
  build/deploy" — তাই বাস্তবে এটা এমনকি network hop নাও হতে পারে), section 5-এর
  observability event list-এ যোগ করা `oidc.backchannel_logout.*` ধরনের ইভেন্ট
  দিয়ে সহজেই ট্র্যাক করা যায়, ব্যর্থ হলে retry policy বসানো যায় — front-channel-এর
  "iframe লোড হলো কিনা কে জানে" সমস্যাটা নেই।
- **ভবিষ্যতের জন্য সঠিক দিকে বাড়ে।** Ryft/Wisp/Verve/Zynth (future scope,
  §10) আসল, স্বাধীনভাবে deploy-করা RP হলেও এই মডেল বদলাতে হবে না — শুধু
  প্রতিটার নিজের `backchannel_logout_uri` রেজিস্টার করলেই চলবে,
  `oidc_clients` টেবিলের schema-ভিত্তিক client registry (Phase 2)-এর সাথে
  স্বাভাবিকভাবেই মেলে।

**যা মাথায় রাখতে হবে (6e-এর জন্য সীমাবদ্ধতা, এখনই সমাধান না):**
- Logout Token-এর `sub`/`sid` কোন `user_sessions.jti`-এর সাথে মেলে তা
  resolve করার জন্য একটা mapping দরকার — কারণ session-exchange প্রতিটা
  Sylo login-এ **নতুন** `jti` বানায় (উপরে 6d-a দ্রষ্টব্য), OIDC-এর নিজস্ব
  ধারণার `sid` (`authorization_code`/`id_token`-এ যেটা bound) থেকে ভিন্ন।
  এটা 6e-scoped কাজ, 6d-তে সমাধান করা হচ্ছে না।
- `oidc_clients` টেবিলে এখনো কোনো `backchannel_logout_uri` কলাম নেই
  (migration 084 শুধু `post_logout_redirect_uris` যোগ করেছে, Phase 6a) —
  6e-এ নতুন migration লাগবে।

**সিদ্ধান্ত-প্রাসঙ্গিক উপসংহার:** Back-channel উভয় trigger direction-ই কভার
করে, বিদ্যমান RS256/JWKS infrastructure পুনঃব্যবহার করে, আর কোনো নতুন
browser-facing UI ছাড়াই কাজ করে।

---

## 6d-d — Decision Record

> **এই scope-এ (Season 3, শুধু Sylo) logout propagation
> Back-Channel Logout মডেলে হবে, Front-Channel নয়।**

**যুক্তি, সংক্ষেপে:**

| মানদণ্ড | Front-channel | Back-channel |
|---|---|---|
| Central/Security-page-triggered revoke কভার করে? | ❌ (কোনো browser navigation নেই) | ✅ (server-to-server) |
| RP-initiated (`/oidc/logout`) revoke কভার করে? | ✅ | ✅ |
| Delivery guarantee / retry সম্ভব? | ❌ | ✅ |
| বিদ্যমান infra পুনঃব্যবহার (RS256 sign, JWKS verify)? | আংশিক | ✅ (`oidc-id-token.ts`-এর ধাঁচ সরাসরি প্রযোজ্য) |
| নতুন browser-facing surface (iframe dispatcher) লাগে? | ✅ (হ্যাঁ, লাগবে) | ❌ |
| Third-party cookie ঝুঁকি | নেই এই case-এ (একই eTLD+1) | প্রযোজ্য না |
| ভবিষ্যতে সত্যিকারের external RP (Ryft ইত্যাদি)-এর জন্য টেকে? | সীমিত | ✅ |

Requirement #1 (non-browser-triggered revoke propagation) একাই front-channel-কে
বাতিল করে দেয় — এটা কোনো optimization-এর প্রশ্ন না, কভারেজের প্রশ্ন। তাই এই
সিদ্ধান্তে trade-off বিশ্লেষণের দরকার পড়েনি একটামাত্র বিকল্প টিকে থাকার কারণে।

**এই সিদ্ধান্তের আওতায় যা 6e-তে বানানো হবে (preview, implementation না):**
- `oidc_clients.backchannel_logout_uri` কলাম (নতুন migration)।
- Logout Token builder — `issueOidcIdToken()`-এর pure/signed split-এর
  একই প্যাটার্নে।
- Central `revokeSessionByJti()` / `revokeAllSessionsExcept()` /
  `routes/oidc-logout.ts`-এর logout path থেকে Sylo-র
  `backchannel_logout_uri`-তে dispatch করার hook।
- Sylo-পাশের receiving endpoint যেটা Logout Token verify করে নিজের local
  session (session-exchange-origin token) invalid করে।
- Failure handling + monitoring (roadmap §9-এর ম্যাপে এগুলো এখনো
  আলাদাভাবে তালিকাভুক্ত হয়নি — 6e নিজেই সেগুলোকে atomic sub-task হিসেবে
  ভেঙে নেবে, roadmap-এর §1.2 discipline অনুযায়ী)।

---

## সারাংশ

| Sub-phase | অবস্থা |
|---|---|
| 6d-a Requirements | সম্পন্ন — উপরে |
| 6d-b Front-Channel Evaluation | সম্পন্ন — বাতিল |
| 6d-c Back-Channel Evaluation | সম্পন্ন — গৃহীত |
| 6d-d Decision Record | সম্পন্ন — Back-Channel Logout |

**কোনো ফাইল পরিবর্তিত হয়নি, কোনো টেস্ট যোগ হয়নি** — roadmap-এর নিজস্ব শর্ত
অনুযায়ী ("No broad implementation in this sub-phase")। পরবর্তী সাব-ফেজ:
**6e-a — Propagation Interface** (Sylo Logout Propagation-এর প্রথম atomic
ধাপ: clean abstraction তৈরি, এখনো কোনো real dispatch/receiving endpoint না)।
