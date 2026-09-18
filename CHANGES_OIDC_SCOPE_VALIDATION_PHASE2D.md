# OIDC Roadmap — Season 1, Phase 2D-a..2D-e: Scope Validation

## যা আগে থেকেই ছিল
- Phase 2B: পাঁচটা first-party client-ই `allowedScopes: ["openid", "profile",
  "email"]` নিয়ে seed হয়েছে।
- Phase 2C: `oidc-client-validation.ts`-এ `client_id` আর `redirect_uri`
  validation হয়ে গেছে, কিন্তু `scope` প্যারামিটার নিয়ে কোনো চেক ছিল না —
  পার্স করা, ভ্যালিড কিনা যাচাই করা, কোনোটাই না।
- `lib/oidc-discovery.ts`-এর `SCOPES_SUPPORTED` এখনো `["openid"]`-ই আছে,
  তার নিজের কমেন্টেই লেখা `"profile"`/`"email"` যোগ করাটা "Phase 2's job" —
  ঠিক এই ফেজেই সেটা হলো, কিন্তু discovery.ts-এর constant-টা touch করা
  হয়নি (কারণ সেটা route/discovery-document output, এই ফেজের কাজ শুধু
  client-registry-ভিত্তিক scope permission check করা)।

## যেটা যোগ করা হলো (Phase 2D-a..2D-e)

### `artifacts/api-server/src/lib/oidc-scope-validation.ts` (নতুন ফাইল)

**2D-a — Scope Parser**
`parseScopeString(rawScope)` — OIDC Core 1.0 §3.1.2.1 অনুযায়ী space-
delimited scope স্ট্রিং-কে normalize করে একটা clean, ordered,
de-duplicated অ্যারেতে পার্স করে:
- `undefined`/`null`/খালি/শুধু-whitespace ইনপুট → `[]` (error না)।
- একাধিক whitespace collapse হয়ে যায়।
- ডুপ্লিকেট টোকেন একবারই থাকে, প্রথম যেখানে পাওয়া গেছে সেই position-এ।

**`KNOWN_OIDC_SCOPES`** — এই provider যে scope value-গুলোর মানে বোঝে তার
fixed vocabulary: `["openid", "profile", "email"]` (ঠিক যেগুলো Phase 2B
সব client-এর জন্যই seed করেছে)। এটা `oidc-discovery.ts`-এর
`SCOPES_SUPPORTED`-এর থেকে **ইচ্ছাকৃতভাবে আলাদা** constant — দুটো
মিলিয়ে ফেলা বা এক জায়গা থেকে আরেক জায়গা derive করা future scope, এই
ফেজের কাজ না।

**2D-b/2D-c — Allowed-Scope Check / Unknown Scope Handling**
`validateOidcScopes(client, rawScope)` — পার্স করা প্রতিটা scope টোকেনের
জন্য পরপর দুইটা চেক (request-এর ক্রম অনুযায়ী প্রথম যেটা fail করে সেটাতেই
থেমে যায়, Phase 2C-এর `validateOidcRedirectUri`-এর মতো fail-fast):
1. `KNOWN_OIDC_SCOPES`-এর মধ্যে আছে কিনা — না থাকলে `unknown_scope`।
   (client-এর নিজের `allowedScopes`-এ থাকলেও না — একটা client-এর registry
   row কখনো global known-scope vocabulary-কে বড় করতে পারবে না, শুধু ছোট
   করতে পারে।)
2. `client.allowedScopes`-এর মধ্যে আছে কিনা — না থাকলে `disallowed_scope`।

**2D-d — Scope Error Contract**
```text
{ ok: true, scopes }
  |
{ ok: false, error: "invalid_scope", reason: "unknown_scope" | "disallowed_scope", scope }
```
roadmap-এর global error model-এ scope-এর জন্য একটাই public OAuth কোড আছে
(`invalid_scope`) — সেটাই `error` ফিল্ডে থাকে। কিন্তু "unknown" বনাম
"disallowed" আলাদাভাবে জানা দরকার (2D-e-এর টেস্ট ম্যাট্রিক্সেও দুটো আলাদা
কেস হিসেবে চাওয়া হয়েছে, এবং ডিবাগিং/লগিং-এর জন্যও কাজে লাগে) — তাই একটা
internal-only `reason` ফিল্ড যোগ করা হলো, ঠিক Phase 2C-তে `invalid_client`-
এর জন্য যেই প্যাটার্ন ব্যবহার হয়েছিল সেটাই।

### `scripts/src/test-oidc-scope-validation.ts` (নতুন ফাইল) — 2D-e

roadmap-এর ঠিক ৪টা ক্যাটেগরি কভার করা হয়েছে, মোট ১৮টা assertion
(`parseScopeString()`-এর normalization-সহ):

| ক্যাটেগরি | কেস |
|---|---|
| valid subset | পুরো allowed set-এর subset রিকোয়েস্ট; শুধু `openid`-ই allowed এমন client; wider set থেকে একটা scope |
| unknown scope | client-এর registry-তে থাকলেও global vocabulary-র বাইরে হলে reject; সম্পূর্ণ বানানো scope |
| disallowed scope | known কিন্তু এই client-এর জন্য allowed না; একেবারে খালি `allowedScopes`; fail-fast অর্ডার (unknown আগে ধরা পড়ে disallowed-এর আগে) |
| empty/default | `undefined`/খালি স্ট্রিং/শুধু-whitespace/খালি `allowedScopes`-এর client — সবগুলোই একটা বৈধ খালি রিকোয়েস্ট হিসেবে pass করে |

`oidc-scope-validation.ts`-এ কোনো `@workspace/db` ইম্পোর্ট নেই (Phase 2C-এর
`validateOidcClientId`-এর মতো DB-নির্ভর কোনো ফাংশন এখানে নেই) — তাই এই
ফেজে এমন কোনো ফাংশন বাদ পড়েনি যেটা টেস্ট করা যায়নি।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/oidc-scope-validation.ts` | **নতুন ফাইল** — 2D-a..2D-d |
| `scripts/src/test-oidc-scope-validation.ts` | **নতুন ফাইল** — 2D-e |
| `scripts/package.json` | নতুন script যোগ: `oidc:test-scope-validation` |

## যা টেস্ট করা হয়েছে
- **`check-all.ts --syntax-only`** (`artifacts/api-server` ও `scripts`
  দুটো module-এই) — নতুন দুটো ফাইলসহ সব ক্লিন।
- **`test-oidc-scope-validation.ts` সত্যিকারের রান করা হয়েছে** —
  `oidc-scope-validation.ts`-এর একমাত্র বহিরাগত ইম্পোর্ট `./logger`
  (pino)-এর জন্য একটা সাময়িক in-memory stub বসিয়ে (module resolution
  satisfy করার জন্যই শুধু, deliverable-এ কিছু যোগ হয়নি, টেস্ট শেষে stub
  মুছে ফেলা হয়েছে) — সবগুলো (১৮টা) assertion আসলেই এক্সিকিউট করে pass
  করানো হয়েছে। এই ফাইলে কোনো DB-নির্ভর ফাংশন নেই বলে Phase 2C-র মতো কোনো
  hand-traced-only অংশ বাকি থাকেনি।

## পরের ধাপ (Phase 2E)
**Unified Client Validation** (2e-a..2e-e): একটামাত্র
`validateClientRequest(client_id, redirect_uri, scope)` তৈরি করা যেটা
Phase 2C-এর `validateOidcClientId`/`validateOidcRedirectUri` আর Phase 2D-এর
`validateOidcScopes` — তিনটাকেই compose করবে; একটা structured result
model (client + validated redirect URI + validated scopes + status/error);
`/oidc/authorize`-কে (Phase 3) এই একটামাত্র ইন্টারফেস consume করার জন্য
প্রস্তুত করা; পূর্ণ integration test matrix; এবং Phase 2 Final Verification
(registry + সব first-party client seeded + redirect validation + scope
validation + unified validator + সব টেস্ট pass — এই সব মিলিয়ে Phase 2
সম্পূর্ণ)।
