# OIDC Roadmap — Season 1, Phase 1E-c: `/.well-known/jwks.json`

## যা আগে থেকেই ছিল
- `getVerificationKeys()`/`resolveVerificationKeys()` (1D-a/1D-b, `lib/jwt-keys.ts`)
  — active + retiring verification key resolve করে, sync, cached।
- `buildJwks(keys)` (1E-b) — সেই key-গুলোকে `{ keys: [...] }` JWKS shape-এ
  বানায়।
- এই দুটো জোড়া দেওয়ার কোনো HTTP endpoint ছিল না।

## যেটা যোগ করা হলো (Phase 1E-c)

### নতুন ফাইল — `routes/well-known-jwks.ts`
- **`jwksHandler(req, res)`** — `resolveVerificationKeys()` (1D-b, sync,
  hot-path-safe) → `buildJwks()` (1E-b) চেইন করে, `Cache-Control` আর
  content-type সেট করে JSON রেসপন্স পাঠায়। হ্যান্ডলার লজিক router wiring
  থেকে আলাদা করে `export` করা হয়েছে যাতে টেস্ট real HTTP server ছাড়াই এটাকে
  সরাসরি কল করতে পারে।
- **`GET /.well-known/jwks.json`** — উপরের হ্যান্ডলার রেজিস্টার করে।

### Content-type
`application/json` — কোনো JWK-নির্দিষ্ট media type না (RFC 7517 এটা
mandate করে না), কিন্তু Google/Microsoft/Okta/Auth0 সবাই বাস্তবে এটাই
ব্যবহার করে, আর `res.json()`-এর ডিফল্টও এটাই — তাই explicit করে রাখা হয়েছে
যাতে সিদ্ধান্তটা ডকুমেন্টেড থাকে, incidental না।

### Cache-Control: rotation-compatible
`public, max-age=300` (৫ মিনিট) — যথেষ্ট ছোট যাতে কোনো HTTP-caching
client/CDN 1D-d-এর rotation ৭ দিনের token lifetime + grace-period retention
window (1D-e)-এর মধ্যেই দেখে ফেলে; `no-store` না, কারণ এই endpoint প্রতিটা
relying party নিয়মিত poll করবে এই আশাতেই বানানো, আর
`resolveVerificationKeys()` নিজেই already একটা in-memory cache (1D-b) — তার
উপর কয়েক মিনিটের HTTP caching শুধু round trip বাঁচায়।

### Mounting — `/api` prefix-এর বাইরে
`app.ts`-এ **`router`** (routes/index.ts-এর সব sub-router, যেগুলো `/api`
prefix-এ mount হয়) থেকে আলাদাভাবে, root-এ সরাসরি `app.use(wellKnownJwksRouter)`
করা হয়েছে — কারণ OIDC/RFC 8414 well-known endpoint client-রা issuer-এর bare
origin-এর সাপেক্ষে resolve করে (`https://<issuer>/.well-known/jwks.json`),
কোনো API path prefix-এর নিচে না। `globalLimiter`/`apiKeyScopeGate`-এর পিছনেও
রাখা হয়নি — একটা token-verify করার JWKS endpoint সংজ্ঞা অনুযায়ীই public।
Production-এর static/SPA catch-all block-এর আগে mount করা হয়েছে, তাই সেই
wildcard এটাকে গিলে ফেলবে না।

## টেস্ট — `scripts/src/test-jwks-endpoint.ts`
`jwksHandler()`-কে একটা minimal req/res double দিয়ে সরাসরি কল করে (দেখুন
নিচের sandbox নোট) — রোডম্যাপের 1E-c "Done when" criteria-র প্রতিটা চেক করা
হয়েছে:
1. ভ্যালিড JWKS shape (`{ keys: [...] }`)।
2. প্রতিটা published key-এর `kid` আছে, সঠিক RS256 JWK ফিল্ড আছে।
3. কোথাও কোনো private key material নেই (`d`/`p`/`q`)।
4. content type `application/json`।
5. `Cache-Control` সেট করা, ছোট (rotation-compatible), `no-store` না।
6. verification-key cache load হওয়ার আগেও (1D-b-এর pre-cache-load window)
   হ্যান্ডলার থ্রো করে না।

**সব ৬টা assertion পাশ করেছে** — `npx tsx scripts/src/test-jwks-endpoint.ts`।

## Sandbox নোট
আগের ফেজগুলোর মতোই — `@workspace/db`/`pino`-এর sandbox stub আগে থেকেই
ছিল; এই ফেজে নতুন করে **`node_modules/express`**-এর একটা stub-ও লাগলো
(`Router()`/`.get()`/`.use()`-এর একটা minimal shape, যেটা শুধু call
রেকর্ড করে — কোনো আসল HTTP routing করে না), কারণ `routes/well-known-jwks.ts`
মডিউল-লেভেলে `express` থেকে `Router` import করে, আর এই অফলাইন sandbox-এ
আসল `express` প্যাকেজ install করা নেই (নেটওয়ার্ক নেই — `npm view express`
চালিয়ে 403 কনফার্ম করা হয়েছে)। এগুলো `package.json`-এ নেই, শুধু import
resolution সম্ভব করার জন্য — বাস্তব dev/production পরিবেশে (`pnpm install`
করা) এগুলোর দরকার নেই। `jwksHandler` router wiring থেকে আলাদা করে export
করা হয়েছে ঠিক এই কারণেই — টেস্ট real Express server ছাড়াই হ্যান্ডলারের
নিজস্ব লজিক (কী resolve হয়, কী header সেট হয়, কী body যায়) direct call করে
verify করতে পারে।

`tsc --noEmit --strict` (isolated config, jwt-keys.ts + oidc-discovery.ts +
well-known-jwks.ts + এই ফেজের টেস্ট) দিয়ে চেক করা হয়েছে — নতুন কোডে কোনো
error নেই, শুধু প্রত্যাশিত `@types/node`/`@types/express` না থাকার noise।

## জানা limitation
- এই টেস্ট আসল HTTP server/Express routing engine (path matching, middleware
  chain, content negotiation ইত্যাদি) exercise করে না — শুধু `jwksHandler()`
  ফাংশনের নিজের লজিক, সরাসরি কল করে। আসল `pnpm dev` চালিয়ে
  `curl http://localhost:8080/.well-known/jwks.json` দিয়ে real end-to-end
  sanity check staging-এ deploy-এর আগে ভালো — আগের ফেজগুলোর মতোই (real DB
  wiring), এটাও এখনো sandbox-এ integration-test করা যায়নি।

## পরের সাব-ফেজ
1E-d (এই একই রানে, আলাদা CHANGES ফাইলে ডকুমেন্টেড) → 1E-e
(`/.well-known/openid-configuration` endpoint, এই রানে শুরু করা হয়নি)।
