# OIDC Roadmap — Season 1, Phase 1E-a: RSA-to-JWK Conversion

## যা আগে থেকেই ছিল
- Phase 1D-a-এর `VerificationKey` টাইপ (`lib/jwt-keys.ts`) — `{ kid,
  publicKey (PEM, SPKI), status: "active" | "retiring" }` — ইতিমধ্যেই
  "শুধু public material" গ্যারান্টি করে টাইপ লেভেলে: private key কখনোই এই
  টাইপে ফিট করে না।
- `getVerificationKeys()`/`resolveVerificationKeys()` (1D-a/1D-b) —
  verify-eligible key-গুলোর লিস্ট রিটার্ন করে, কিন্তু PEM ফরম্যাটে — JWKS
  publish করার জন্য দরকার JWK ফরম্যাট, যেটা এখনো ছিল না।
- `package.json`-এ `jose`/`node-jose` জাতীয় কোনো JWK লাইব্রেরি নেই।

## যেটা যোগ করা হলো (Phase 1E-a)

### `lib/jwt-keys.ts`-এ RSA → JWK conversion (pure, no new dependency)
- **`RsaJwk`** ইন্টারফেস — `{ kty: "RSA", use: "sig", alg: "RS256", kid, n,
  e }` — একটা published verification key-এর সম্পূর্ণ shape।
- **`verificationKeyToJwk(key: VerificationKey): RsaJwk`** — Node-এর
  built-in `crypto.createPublicKey(pem).export({ format: "jwk" })` ব্যবহার
  করে (কোনো নতুন npm dependency লাগেনি) — RSA public key-এর জন্য এটা সবসময়
  ঠিক `{ kty: "RSA", n, e }` রিটার্ন করে, আর কিছু না।
  - non-RSA key (যেমন EC) পেলে থ্রো করে — silently coerce করে না।
  - export করা ফলাফল spread না করে narrow করে destructure করা হয়েছে
    (`{ n, e }` শুধু), যাতে ভবিষ্যতে Node-এর কোনো নতুন ফিল্ড অনিচ্ছাকৃতভাবে
    leak না করে।

### কেন "private material কখনো appear করে না" — structural গ্যারান্টি
`verificationKeyToJwk()`-এর একমাত্র ইনপুট `VerificationKey.publicKey`, যেটা
Phase 1D-a থেকেই ডকুমেন্টেড "PEM, SPKI — verification only, never a private
key"। `JwtKeypair.privateKey` এই ফাংশনের কোনো প্যারামিটার, branch, বা
fallback-এ কখনো পৌঁছায় না — private key এই ফাংশনে ঢোকার কোনো পথই নেই।
Defense-in-depth হিসেবে টেস্টে এটাও চেক করা হয়েছে: private key PEM ভুল করে
`publicKey` হিসেবে পাস করলেও (`createPublicKey()`-এর নিজস্ব আচরণের কারণে)
শুধু public অংশটাই derive হয় — private material তাও leak করে না।

## টেস্ট — `scripts/src/test-rsa-to-jwk.ts`
আসল RSA keypair (`node:crypto`-এর `generateKeyPairSync`, কোনো fixture
string না) দিয়ে যাচাই করা হয়েছে:
1. real RSA public key → সঠিক `{ kty, use, alg, kid, n, e }`।
2. আউটপুটে ঠিক ৬টা ফিল্ড, কোনো `d`/`p`/`q` (private exponent/prime) নেই।
3. আলাদা keypair → আলাদা `n` (constant/stub না, আসল conversion)।
4. `kid` অবিকৃতভাবে carry হয়।
5. `status` (active vs retiring) JWK shape বদলায় না — JWKS-এ status ফিল্ড
   নেই।
6. non-RSA (EC) key দিলে থ্রো করে।
7. garbage PEM দিলে থ্রো করে, malformed JWK রিটার্ন করে না।
8. private key PEM ভুল করে `publicKey`-তে পাস করলেও leak হয় না।

**সব ৮টা assertion পাশ করেছে** — `npx tsx scripts/src/test-rsa-to-jwk.ts`,
আসল `tsx` execution-এ (dependency-free `.mjs` কপি না)।

## Sandbox নোট
`lib/jwt-keys.ts` মডিউল-লেভেলে `@workspace/db` (পুল) আর `./logger`
(পিনো) import করে। এই অফলাইন sandbox-এ কোনো `node_modules` install করা
নেই (নেটওয়ার্ক নেই) — তাই 1D-e/1D-f-এর মতোই একই ধরনের লোকাল stub প্যাকেজ
বসানো হয়েছে (`node_modules/@workspace/db`, `node_modules/pino` — শুধু
import resolve করার জন্য, `pool.query()` কল করলে থ্রো করে, `pino()` একটা
no-op logger রিটার্ন করে)। এগুলো `package.json`-এ নেই, repo-committed
dependency-কে touch করেনি — শুধু এই sandbox-এ import resolution সম্ভব করার
জন্য। বাস্তব ডেভ/প্রোডাকশন পরিবেশে (`pnpm install` করা) এগুলোর দরকার নেই।

`tsc --noEmit --strict` (isolated config, শুধু `jwt-keys.ts` +
এই ফেজের টেস্ট দুটো ফাইল) দিয়ে চেক করা হয়েছে — নতুন কোডে (`RsaJwk`,
`verificationKeyToJwk`, `buildJwks`, `Jwks`) কোনো error নেই; যা আছে সব
প্রত্যাশিত `@types/node` না থাকার noise (আগের ফেজগুলোর CHANGES-এও একই নোট
আছে)।

## জানা limitation
- এই টেস্ট `getVerificationKeys()`/DB-চালিত path টাচ করে না — শুধু pure
  `verificationKeyToJwk()` ফাংশন, DB connection ছাড়াই রান করে।

## পরের ধাপ
Phase 1E-b — JWKS Response Builder (`buildJwks()`) — এই একই run-এ একসাথে
implement করা হয়েছে, আলাদা CHANGES ফাইলে
(`CHANGES_JWT_JWKS_BUILDER_PHASE1E_B.md`) ডকুমেন্টেড।
