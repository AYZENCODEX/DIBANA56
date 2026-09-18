# OIDC Roadmap — Season 1, Phase 1E-d: OIDC Configuration Object

## যা আগে থেকেই ছিল
- `lib/jwt-keys.ts` — key MATERIAL (signing/verification/rotation/JWKS)
  সম্পূর্ণ implement করা, কিন্তু provider METADATA (issuer পরিচয়, supported
  capability, endpoint URL) — এটা সম্পূর্ণ আলাদা concern, কোথাও define করা
  ছিল না।
- `lib/finance-invoice.ts`-এ ইতিমধ্যেই একটা established pattern —
  `process.env.APP_URL ?? "https://ayzen.replit.app"` — app-এর base origin
  resolve করার জন্য।

## যেটা যোগ করা হলো (Phase 1E-d)

### নতুন ফাইল — `lib/oidc-discovery.ts` (pure, no I/O)
`lib/jwt-keys.ts` থেকে ইচ্ছাকৃতভাবে আলাদা ফাইল — key material বনাম provider
metadata আলাদা concern, আর Phase 3/4 যত এগোবে metadata আরও বড় হবে।

- **`resolveIssuer()`** — issuer origin resolve করে। `AYZEN_OIDC_ISSUER`
  (নতুন, dedicated override) সেট থাকলে সেটাই; নাহলে existing `APP_URL`
  pattern-এ fallback (`lib/finance-invoice.ts`-এর সাথে সামঞ্জস্যপূর্ণ, নতুন
  env var mandatory করা হয়নি)। Trailing slash strip করা হয়।
- **`OidcDiscoveryMetadata`** ইন্টারফেস — `issuer`, `jwks_uri`,
  `response_types_supported`, `scopes_supported`,
  `id_token_signing_alg_values_supported` — রোডম্যাপের 1E-d task list-এর
  ঠিক এই পাঁচটা জিনিসই।
- **`buildOidcDiscoveryMetadata(issuer)`** — pure builder, issuer parameter
  হিসেবে নেয় (env সরাসরি না পড়ে) — 1E-b-এর `buildJwks(keys)`-এর মতোই
  discipline, env setup/teardown ছাড়া unit-testable।
- **`getOidcDiscoveryMetadata()`** — সুবিধার জন্য wrapper: env থেকে issuer
  resolve করে builder কল করে। 1E-e-এর (এখনো তৈরি হয়নি) endpoint এটাই কল
  করবে।

### যা এখনো নেই — ইচ্ছাকৃতভাবে
রোডম্যাপের স্পষ্ট নির্দেশ: *"Do not advertise endpoints that do not exist
yet।"* তাই বাদ দেওয়া হয়েছে (placeholder/খালি string হিসেবেও না):
- `authorization_endpoint` / `token_endpoint` / `userinfo_endpoint` —
  এগুলোর কোনোটাই এখনো নেই (Phase 3/4)।
- `token_endpoint_auth_methods_supported`, `grant_types_supported`,
  `claims_supported` — এগুলো একটা token/userinfo endpoint-এর existence
  presuppose করে, যেটা এখনো নেই।

`jwks_uri` **আছে** — কারণ সেই endpoint এই একই রানে (1E-c) সত্যিই তৈরি হয়েছে।
`jwks_uri` issuer থেকে **derive** করা (`${issuer}/.well-known/jwks.json`),
স্বতন্ত্রভাবে configure করা না — তাই দুটো কখনো drift করতে পারে না, আর 1E-e-এর
পরের acceptance criterion ("issuer and endpoint URLs are consistent")
automatically satisfied থাকে।

### কেন `scopes_supported = ["openid"]`, `response_types_supported = ["code"]`
- `"openid"` — spec অনুযায়ী mandatory, আর এখন পর্যন্ত এটাই একমাত্র scope
  যেটা কোনো existing code path honor করতে পারে (token/userinfo endpoint
  এখনো নেই)। `profile`/`email` ইত্যাদি Phase 2 (client `allowed_scopes`)
  আর Phase 4 (userinfo claims)-এর কাজ।
- `"code"` — Authorization Code + PKCE (Phase 3)-ই একমাত্র flow এই রোডম্যাপ
  কখনো support করার প্ল্যান করে; implicit/hybrid পুরোপুরি out of scope,
  শুধু "এখনো না" না।
- `id_token_signing_alg_values_supported = ["RS256"]` — Phase 1a/1b-এর
  signing switch। `HS256` শুধু internal migration-grace mechanism
  (`ALLOW_LEGACY_HS256_TOKENS`) — কোনো OIDC client-কে কখনো এটা expect/accept
  করতে বলা হয় না।

## টেস্ট — `scripts/src/test-oidc-discovery-metadata.ts`
Pure, DB-free, env-free (builder issuer কে parameter হিসেবে নেয়;
`resolveIssuer()` আলাদাভাবে টেস্ট করা হয়েছে, env var save/restore সহ):

**`buildOidcDiscoveryMetadata()`** (১০টা assertion):
issuer অবিকৃত থাকে; trailing slash(es) strip হয়; `jwks_uri` issuer থেকে
derive হয় (independently set করা যায় না); trailing-slash issuer-এও
`jwks_uri` সঠিকভাবে join হয় (doubled slash নেই); বিভিন্ন issuer-এর জন্য
issuer/jwks_uri সবসময় একই origin শেয়ার করে; `response_types_supported`
ঠিক `["code"]`; `scopes_supported` ঠিক `["openid"]`;
`id_token_signing_alg_values_supported` ঠিক `["RS256"]` (`HS256` নেই);
authorization/token/userinfo endpoint ফিল্ড নেই; রিটার্ন করা array-গুলো
প্রতি কলে fresh copy (shared mutable state না)।

**`resolveIssuer()`** (৪টা assertion): `AYZEN_OIDC_ISSUER` সেট থাকলে
`APP_URL`-এর উপর জেতে; `AYZEN_OIDC_ISSUER` unset হলে `APP_URL`-এ fallback;
দুটোই unset হলে hardcoded default-এ fallback; blank/whitespace-only
`AYZEN_OIDC_ISSUER` unset হিসেবেই treat হয়।

**সব ১৪টা assertion পাশ করেছে** — `npx tsx
scripts/src/test-oidc-discovery-metadata.ts`।

## Sandbox নোট
এই ফাইল কোনো `@workspace/db`/`pino`/`express` import করে না — শুধু
`node:assert`। `tsc --noEmit --strict` (isolated config) দিয়ে চেক করা
হয়েছে — নতুন কোডে কোনো error নেই।

## Phase 1E-c + 1E-d সম্পূর্ণ
- 1E-c: JWKS endpoint কাজ করছে, valid JWKS রিটার্ন করে, প্রতিটা key-এর
  `kid` আছে (৬টা assertion)।
- 1E-d: discovery metadata object বানানো হয়েছে, issuer/jwks_uri সবসময়
  consistent, শুধু আজকের existing endpoint/capability advertise করে
  (১৪টা assertion)।

## পরের সাব-ফেজ
**1E-e — `/.well-known/openid-configuration`** — HTTP endpoint যোগ করা,
যেটা `getOidcDiscoveryMetadata()` (এই ফেজ) serve করবে। এই রানে শুরু করা
হয়নি — রোডম্যাপ অনুযায়ী পরের ধাপ। তারপর **1E-f — Discovery Integration
Tests** (JWKS format, `kid` presence, private-key exclusion, discovery
issuer, JWKS URI, supported algorithm metadata, rotation visibility —
1E-a/b/c/d-এর টেস্টগুলো ইতিমধ্যেই এর বেশিরভাগ কভার করে ফেলেছে, কিন্তু 1E-f
আনুষ্ঠানিকভাবে "Phase 1e DONE only after tests pass" ঘোষণা করার সাব-ফেজ)।
