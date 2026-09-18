# OIDC Roadmap — Season 1, Phase 1E-e: `/.well-known/openid-configuration`

## যা আগে থেকেই ছিল
- `getOidcDiscoveryMetadata()` (1E-d, `lib/oidc-discovery.ts`) — issuer env
  থেকে resolve করে `{ issuer, jwks_uri, response_types_supported,
  scopes_supported, id_token_signing_alg_values_supported }` document বানায়,
  কিন্তু এটা serve করার কোনো HTTP endpoint ছিল না।
- `routes/well-known-jwks.ts` (1E-c) — root-এ, `/api` prefix-এর বাইরে, একই
  ধরনের well-known endpoint mount করার প্যাটার্ন আগে থেকেই established।

## যেটা যোগ করা হলো (Phase 1E-e)

### নতুন ফাইল — `routes/well-known-openid-configuration.ts`
- **`openidConfigurationHandler(req, res)`** — `getOidcDiscoveryMetadata()`
  (1E-d) কল করে, `Cache-Control` আর content-type সেট করে JSON রেসপন্স পাঠায়।
  1E-c-এর `jwksHandler`-এর ঠিক একই শেপ — হ্যান্ডলার লজিক router wiring থেকে
  আলাদা করে `export` করা, যাতে টেস্ট real HTTP server ছাড়াই সরাসরি কল করতে
  পারে।
- **`GET /.well-known/openid-configuration`** — উপরের হ্যান্ডলার রেজিস্টার
  করে।

### Content-type
`application/json` — OIDC Discovery 1.0 §3 অনুযায়ী এটাই mandatory।

### Cache-Control: JWKS-এর চেয়ে দীর্ঘ
`public, max-age=3600` (১ ঘণ্টা) — JWKS-এর ৫ মিনিটের বিপরীতে, কারণ discovery
metadata (issuer, scopes, response types, algs) শুধু একটা code deploy-এ
বদলায়; key rotation (1D-d)-এর মতো কোনো rotation-visibility deadline এখানে
নেই যেটা ছোট TTL দাবি করে। তবুও `no-store`/immutable না — OIDC spec অনুযায়ী
relying party-রা এটাও periodically poll করবে ধরে নেওয়া হয়।

### Mounting — `well-known-jwks.ts`-এর পাশে, একই জায়গায়
`app.ts`-এ `wellKnownJwksRouter`-এর ঠিক পরে `app.use(wellKnownOpenidConfigurationRouter)`
— একই কারণে: root-এ, `/api` prefix-এর বাইরে, `apiKeyScopeGate`-এর পিছনে না
(RFC 8414 well-known endpoint client-রা issuer-এর bare origin-এর সাপেক্ষে
resolve করে), আর production-এর static/SPA catch-all-এর আগে।

### Consistency — automatically satisfied, নতুন কোড লাগেনি
`jwks_uri` ইতিমধ্যেই (1E-d থেকে) issuer থেকে derive করা, independently
configure করা না — তাই "issuer and endpoint URLs are consistent" acceptance
criterion এই সাব-ফেজে কোনো নতুন লজিক ছাড়াই satisfied থাকে; টেস্টে শুধু এটা
handler-এর মধ্য দিয়ে end-to-end ভেরিফাই করা হয়েছে।

## টেস্ট — `scripts/src/test-openid-configuration-endpoint.ts`
`openidConfigurationHandler()`-কে minimal req/res double দিয়ে সরাসরি কল
করে — 1E-e-এর "Done when" criteria-র প্রতিটা চেক করা হয়েছে:
1. Standard OIDC discovery client parse করতে পারবে এমন শেপ (`issuer`,
   `jwks_uri`, তিনটা `_supported` array)।
2. `issuer`/`jwks_uri` consistent — `jwks_uri` ঠিক
   `${issuer}/.well-known/jwks.json`, custom issuer env দিয়ে ভেরিফাই করা।
3. এখনো-না-থাকা endpoint (`authorization_endpoint`/`token_endpoint`/
   `userinfo_endpoint`/`grant_types_supported`/`claims_supported`) advertise
   হয় না।
4. `id_token_signing_alg_values_supported` ঠিক `["RS256"]`।
5. `response_types_supported` ঠিক `["code"]`, `scopes_supported` ঠিক
   `["openid"]`।
6. content type `application/json`।
7. `Cache-Control` সেট, `no-store` না, JWKS-এর ৫ মিনিটের চেয়ে দীর্ঘ (>৩০০s)।
8. যেকোনো env state-এ (issuer env সেট/আনসেট) হ্যান্ডলার থ্রো করে না।

**সব ৮টা assertion পাশ করেছে** —
`npx tsx scripts/src/test-openid-configuration-endpoint.ts`।

Regression check হিসেবে 1E-c-এর ৬টা আর 1E-d-এর ১৪টা assertion-ও আবার চালানো
হয়েছে — সব পাশ, কোনো regression নেই।

## Sandbox নোট
আগের ফেজগুলোর মতোই — এই অফলাইন sandbox-এ আসল `express`/`@workspace/db`/`pino`
package install নেই (নেটওয়ার্ক নেই), তাই import resolution-এর জন্য একই
ধরনের minimal stub (`node_modules/express`, `node_modules/@workspace/db`,
`node_modules/pino`) নতুন করে বানানো হয়েছে — এগুলো `package.json`-এ নেই, শুধু
এই রানের টেস্ট/typecheck চালানোর জন্য; বাস্তব dev/production পরিবেশে
(`pnpm install`) এগুলোর দরকার নেই।

`tsc --noEmit --strict` (isolated config: `jwt-keys.ts` + `logger.ts` +
`oidc-discovery.ts` + `well-known-jwks.ts` + `well-known-openid-configuration.ts`
+ এই ফেজের টেস্ট) দিয়ে চেক করা হয়েছে — নতুন কোডে কোনো error নেই, শুধু
প্রত্যাশিত `@types/node`/`@types/express` না থাকার noise (সেটার জন্যও minimal
ambient stub বানিয়ে পুরোপুরি ক্লিন রান কনফার্ম করা হয়েছে)।

## জানা limitation
- আগের ফেজগুলোর মতোই — এই টেস্ট আসল HTTP server/Express routing engine
  exercise করে না, শুধু হ্যান্ডলারের নিজস্ব লজিক সরাসরি কল করে। আসল
  `pnpm dev` চালিয়ে
  `curl http://localhost:8080/.well-known/openid-configuration` দিয়ে
  real end-to-end sanity check staging-এ deploy-এর আগে ভালো।

## Phase 1E-e সম্পূর্ণ
Discovery endpoint কাজ করছে, 1E-d-এর metadata serve করে, issuer/jwks_uri
consistent, এখনো-না-থাকা কোনো endpoint advertise করে না (৮টা assertion,
+ 1E-c/1E-d-এর ২০টা assertion regression-ক্লিন)।

## পরের সাব-ফেজ
**1E-f — Discovery Integration Tests** — রোডম্যাপ অনুযায়ী এখন পর্যন্ত এই সাব-ফেজেই
Phase 1E আনুষ্ঠানিকভাবে "DONE" ঘোষিত হবে। JWKS format, `kid` presence,
private-key exclusion, discovery issuer, JWKS URI, supported algorithm
metadata, rotation visibility — এই সবগুলোর বেশিরভাগ ইতিমধ্যেই 1E-a/b/c/d/e-এর
টেস্টে কভার হয়ে গেছে; 1E-f মূলত এগুলোকে একটা single formal
integration-test suite হিসেবে সংগঠিত করা এবং rotation-visibility
(key rotate হলে JWKS + discovery দুটোতেই সেটা প্রতিফলিত হয় কিনা) নতুন করে
end-to-end ভেরিফাই করা। এই রানে শুরু করা হয়নি।
