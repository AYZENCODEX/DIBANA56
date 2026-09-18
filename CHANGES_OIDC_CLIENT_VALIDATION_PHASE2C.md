# OIDC Roadmap — Season 1, Phase 2C-a..2C-e: Client & Redirect URI Validation

## যা আগে থেকেই ছিল
- Phase 2A-c: `getOidcClientById(clientId)` / `oidcClientExists(clientId)` —
  raw DB lookup, কিন্তু কোনো caller-friendly reject/accept কনট্রাক্ট নেই।
- Phase 2B-a..2B-f: পাঁচটা first-party client (`sylo`/`ryft`/`wisp`/`verve`/
  `zynth`) seed হয়ে গেছে, প্রতিটার ঠিক একটা করে registered
  `redirect_uris` এন্ট্রি (`https://<client_id>.ayzen.tech/oidc/callback`)।
- কিন্তু "unknown client_id রিজেক্ট করা" বা "redirect_uri exact matching"
  — কোনোটাই এখনো কোড হিসেবে ছিল না, শুধু registry data ছিল।

## যেটা যোগ করা হলো (Phase 2C-a..2C-e)

### `artifacts/api-server/src/lib/oidc-client-validation.ts` (নতুন ফাইল)

**2C-a — Client Lookup Validation**
`validateOidcClientId(clientId)` — `getOidcClientById()`-কে wrap করে একটা
structured result রিটার্ন করে:
```text
{ ok: true, client }  |  { ok: false, error: "invalid_client" }
```
`getOidcClientById()` ইতিমধ্যেই "row নেই" আর "DB read fail" — দুটোর জন্যই
`null` রিটার্ন করে (নিজের doc comment-এ এটা বলা আছে) — তাই এখানে দুটো কেসই
একই `invalid_client` রেজাল্টে ম্যাপ হয়। এটা ইচ্ছাকৃত: একটা transient DB
ব্যর্থতা কখনোই "client বৈধ" হিসেবে fall-through করা উচিত না।

**2C-b/2C-c — Redirect URI Exact Matching / Reject Near-Matches**
`validateOidcRedirectUri(client, redirectUri)` — pure function (কোনো DB
কল নেই, তাই সরাসরি ইউনিট-টেস্টযোগ্য)। `client.redirectUris` অ্যারের
বিপরীতে **exact string equality** চেক করে — কোনো normalization (ট্রেইলিং
স্ল্যাশ ট্রিম, কেস-ফোল্ডিং, query re-order) ছাড়াই, যাতে roadmap-এর 2C-c
পয়েন্ট অনুযায়ী path/scheme/host/query — সব ধরনের near-match রিজেক্ট হয়।

**2C-d — Validation Error Contract**
দুটো চেকের জন্যই একই প্যাটার্নের `{ ok, ... }` union type — client
lookup-এর জন্য `"invalid_client"`, redirect-uri-এর জন্য `"invalid_redirect_uri"`
(দুটো আলাদা error value, একটা না)।

**কেন `invalid_redirect_uri`-কে roadmap-এর global error model-এর
`invalid_request`-এ মার্জ করা হলো না:** roadmap-এর section 4-এর error
কোডগুলো (`invalid_client`, `invalid_request` ইত্যাদি) Phase 3-তে client-এর
`redirect_uri`-তে user-agent-কে redirect করে `?error=...` অ্যাপেন্ড করে
পাঠানোর জন্য — কিন্তু সার্ভার যদি `redirect_uri`-টাই যাচাই করতে না পারে,
তাহলে সেখানে redirect করাই একটা open-redirect security hole (RFC 6749
section 4.1.2.1)। তাই `invalid_redirect_uri`-কে ইচ্ছাকৃতভাবে আলাদা রাখা
হয়েছে — Phase 3 এটাকে (redirect না করে) সরাসরি একটা error page হিসেবে
রেন্ডার করবে, `invalid_client`-এর মতো একই redirect পাইপলাইনে না পাঠিয়ে।

### `scripts/src/test-oidc-client-validation.ts` (নতুন ফাইল) — 2C-e

`validateOidcRedirectUri()`-এর উপর ১৩টা assertion, positive + negative
দুটোই:

| কেস | ফলাফল |
|---|---|
| single registered URI-এর সাথে exact match | pass |
| একাধিক registered URI-এর মধ্যে থেকে সঠিকটা match | pass |
| path ভিন্নতা (extra/missing segment) | reject |
| trailing slash ভিন্নতা | reject |
| scheme ভিন্নতা (http vs https) | reject |
| host ভিন্নতা (সম্পূর্ণ আলাদা হোস্ট) | reject |
| host ভিন্নতা (subdomain-confusable superstring, যেমন `sylo.ayzen.tech.evil.com`) | reject |
| host ভিন্নতা (sibling first-party client, `ryft` বনাম `sylo`) | reject |
| query string যোগ হওয়া / ভিন্ন value | reject |
| খালি স্ট্রিং | reject |
| client-এর কোনো registered redirect_uri-ই না থাকা | reject |

`validateOidcClientId()` এখানে টেস্ট করা হয়নি — কারণ সেটা
`getOidcClientById()` কল করে, যার জন্য লাইভ `@workspace/db` pool দরকার।
এই সীমাবদ্ধতা Phase 2A-d ("duplicate client_id") এবং Phase 2B-f-এও
(এই পরিবেশে node_modules/DATABASE_URL কোনোটাই নেই) নোট করা হয়েছিল। এর
বদলে ফাংশনটার ৫ লাইনের implementation হাতে ট্রেস করে verify করা হয়েছে।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-client-validation.ts` | **নতুন ফাইল** — 2C-a..2C-d |
| `scripts/src/test-oidc-client-validation.ts` | **নতুন ফাইল** — 2C-e |
| `scripts/package.json` | নতুন script যোগ: `oidc:test-client-validation` |

## যা টেস্ট করা হয়েছে
- **`check-all.ts --syntax-only`** (`artifacts/api-server` ও `scripts`
  দুটো module-এই) — নতুন দুটো ফাইলসহ সবকিছু ক্লিন, কোনো parse error নেই।
- **`test-oidc-client-validation.ts` সত্যিকারের রান করা হয়েছে** —
  আগের ফেজগুলোর থেকে ভিন্ন: `@workspace/db`/`pino`-এর জন্য এই সেশনে
  সাময়িক in-memory stub বসিয়ে (শুধু module resolution satisfy করার জন্য,
  deliverable-এ কিছু যোগ হয়নি, টেস্ট শেষে stub মুছে ফেলা হয়েছে)
  `validateOidcRedirectUri()`-এর সবগুলো (১৩টা) assertion আসলেই এক্সিকিউট
  করে pass করানো হয়েছে — শুধু হাতে-trace না।
- `validateOidcClientId()` — উপরে বলা কারণেই রান করা যায়নি, হাতে ট্রেস
  করে verify করা হয়েছে।

## পরের ধাপ (Phase 2D)
**Scope Validation** (2d-a..2d-e): requested scope normalize করা (scope
parser), client-এর `allowedScopes`-এর বিপরীতে check করা, unknown scope
reject করা, একটা consistent scope error contract, এবং টেস্ট — এই ফাইলের
`validateOidcClientId()`/`validateOidcRedirectUri()`-এর ঠিক পাশাপাশি বসবে,
যাতে Phase 2E-a-এর `validateClientRequest(client_id, redirect_uri, scope)`
তিনটাকেই কম্পোজ করতে পারে।
