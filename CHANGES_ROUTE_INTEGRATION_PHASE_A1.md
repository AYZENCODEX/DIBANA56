# Route Integration Roadmap — Season A, Phase A1: OIDC Access Token Acceptance

## যা আগে থেকেই ছিল
- `lib/auth-utils.ts`-এর `getUserFromToken()` — main app-এর প্রতিটা `requireAuth`/
  `requireAdmin`/`requireRoles`/`requireDev` কলের একমাত্র entry point — শুধু
  ৪টা token type চিনত: AYZEN API key, নিজের সাইন করা session JWT
  (`verifyAuthToken()`), Supabase/external JWT, আর legacy unsigned base64।
- OIDC provider-এর নিজস্ব access token verification (`verifyOidcAccessToken()`,
  Phase 4c-a) আর revocation denylist (`isAccessTokenRevoked()`, Phase 10b/10c)
  আগে থেকেই সম্পূর্ণ বানানো ছিল — কিন্তু শুধু `lib/oidc-scope-enforcement.ts`
  আর `routes/oidc-userinfo.ts`-এর মতো OIDC-নিজস্ব জায়গায় use হতো। AYZEN-এর
  নিজের business API (`/api/*`) কখনো OIDC access token নিয়ে চিনত না।

## যেটা যোগ করা হলো (Phase A1)
`getUserFromToken()`-এ session-token চেকের পরে, Supabase-চেকের আগে একটা নতুন
ধাপ (1.5) যোগ করা হলো: OIDC access token verify + revocation check, একদম
`routes/oidc-resource.ts`-এর `requireOidcScope()` যেভাবে করে সেই একই primitive
ব্যবহার করে — নতুন কিছু বানানো হয়নি।

**Discriminator ঠিক করার সিদ্ধান্ত:** session token আর OIDC access token
দুটোই একই active RSA keypair দিয়ে সাইন হয় (`getActiveKeypair()`) — তাই আলাদা
করার signal `kid` না, **payload shape**। `verifyAuthToken()` (session path)
`extractPayload()`-এ `userId`(number)+`role`(string) না পেলে null রিটার্ন
করে — যেটা ঠিক OIDC token-এর shape (`sub`(string)+`scope`+`aud`)। তাই একটা
OIDC token session-step-এ এমনিতেই "না মেলা" হয়ে পরের ধাপে পড়ে; সেই ধাপে
`verifyOidcAccessToken()` নিজেই discriminator — RS256 + OIDC-shaped claims
দুটোই না মিললে সেটা ok:false রিটার্ন করে, তাই কোনো token ভুল করে OIDC
হিসেবে classify হওয়ার সুযোগ নেই।

**Verification method ঠিক করার সিদ্ধান্ত:** `POST /oidc/introspect` (Phase
10a) call না করে সরাসরি `verifyOidcAccessToken()` (local JWKS/kid-based,
DB-ছাড়া pure crypto check) + `isAccessTokenRevoked()` (একটাই DB read, denylist
টেবিল migration 094)। Introspection endpoint বানানো হয়েছিল বাইরের resource
server-দের জন্য যাদের এই codebase-এর DB-তে সরাসরি access নেই — `auth-utils.ts`
নিজেই সেই DB-র সাথে connected, তাই নিজেকে HTTP round-trip করে জিজ্ঞেস করাটা
একই চেক-এর জন্য শুধু বাড়তি latency যোগ করত।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/auth-utils.ts` | `getUserFromToken()`-এ নতুন ধাপ 1.5 (OIDC access token verify + revocation check + user lookup); return type-এ `authType: "oidc"` আর ঐচ্ছিক `oidcClientId` যোগ; দুটো নতুন import (`verifyOidcAccessToken`, `hashOidcAccessToken`/`isAccessTokenRevoked`) |
| `artifacts/api-server/src/middlewares/auth.ts` | `AuthUser` interface-এ `authType` union-এ `"oidc"` যোগ, নতুন ঐচ্ছিক `oidcClientId` field, `scopes` field-এর doc comment আপডেট (এখন API-key scope আর OIDC scope — দুই ভিন্ন vocabulary — দুটোই এই একই field দিয়ে যায় সেটা স্পষ্ট করা হয়েছে) |

**কোনো route file touch করা হয়নি** — এই ফেজের সুনির্দিষ্ট লক্ষ্যই ছিল তাই।
`requireAuth`/`requireAdmin`/`requireRoles`/`requireDev` (middlewares/auth.ts)
আর `apiKeyScopeGate` (middlewares/api-key-scope.ts) — এদের signature/behavior
অপরিবর্তিত; `getUserFromToken()` এখন আরেকটা token type-ও চেনে, এটুকুই।
`apiKeyScopeGate` OIDC token-এ কোনো প্রভাব ফেলে না — `looksLikeApiKey()` OIDC
JWT-তে false দেয়, তাই সেই middleware সাথে সাথে `next()` কল করে skip করে দেয়,
আগের মতোই।

## এখনো যা যোগ হয়নি (ইচ্ছাকৃতভাবে, পরের ফেজ)
- **Phase A2 (RBAC-PEP shim)** — `requireAuth`/`requireRoles` ইত্যাদির ভেতরের
  hand-rolled role-check এখনো `PolicyEngine`/`requirePolicy()`-এর মধ্য দিয়ে
  যায় না। এই ফেজের পরেও একটা OIDC token দিয়ে authenticated request পুরনো
  `if (user.role !== roles.includes...)` চেক-এই আটকা পড়ে — শুধু এখন সেই চেক
  `authType: "oidc"` সহ একটা সঠিক `req.user` পায়, যা আগে ছিল না।
- **Phase A3 (telemetry hookup)** — এই নতুন auth path-এর কোনো decision এখনো
  `onDecision` audit hook/telemetry console-এ দেখা যাবে না, কারণ PDP নিজেই
  এখনো এই route-গুলোতে বসেনি (সেটা A2-এর কাজ)।
- OIDC scope (`oidcResult.token.scopes`) এখন `req.user.scopes`-এ বসে আছে,
  কিন্তু legacy route-গুলোর কেউ এখনো সেটা পড়ে না — শুধু data carried, enforced
  না। Route-level scope enforcement Season B/C-এর কাজ।

## Rollout
কোনো নতুন env var লাগেনি — যা আগে থেকে ছিল (`AYZEN_JWT_PRIVATE_KEY` ইত্যাদি,
Phase 1A) তাই যথেষ্ট, কারণ OIDC token verify একই keypair infra ব্যবহার করে।
কোনো migration নেই — revocation টেবিল (094) আর `oidc_clients`/access-token
issuance আগে থেকেই আছে। এই deploy backward-compatible: আগের কোনো token
(session/apikey/legacy) এর behavior একবিন্দুও বদলায়নি, শুধু একটা নতুন `else`
পথ যোগ হয়েছে যেটা আগে কখনো match করত না এমন token-এর জন্য।

## যা টেস্ট করা হয়েছে
- দুটো edited ফাইলের bracket/brace balance চেক করা হয়েছে।
- `verifyOidcAccessToken`/`hashOidcAccessToken`/`isAccessTokenRevoked` —
  তিনটা import-ই তাদের নিজ নিজ ফাইলে সত্যিই exported কিনা grep করে confirm
  করা হয়েছে; কোনো circular import নেই (`oidc-access-token-verification.ts`,
  `oidc-token-revocation.ts` — কোনোটাই `auth-utils.ts` import করে না)।
- `tsc --noEmit --skipLibCheck` দিয়ে দুটো ফাইল চেক করা হয়েছে (node_modules
  ইনস্টল না থাকায় শুধু missing-module noise এসেছে, `auth-utils.ts` বা
  `auth.ts`-এর জন্য কোনো actual syntax/type error আসেনি)।
- `apiKeyScopeGate` (middlewares/api-key-scope.ts) আবার পড়ে দেখা হয়েছে —
  এই ফেজের পরিবর্তনে সেটার behavior অক্ষুণ্ণ, কোনো edit লাগেনি।
