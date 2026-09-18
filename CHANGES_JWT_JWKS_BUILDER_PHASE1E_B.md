# OIDC Roadmap — Season 1, Phase 1E-b: JWKS Response Builder

## যা আগে থেকেই ছিল
- Phase 1E-a-এর `verificationKeyToJwk(key): RsaJwk` — একটা `VerificationKey`
  কে JWK-তে convert করে, কিন্তু পুরো JWKS response (`{ keys: [...] }`)
  বানানোর কোনো ফাংশন ছিল না।
- `getVerificationKeys()`/`resolveVerificationKeys()` (1D-a/1D-b) — সবসময়
  active + retiring key-ই রিটার্ন করে, `retired` কখনো না (`VerificationKey`
  টাইপের `status: "active" | "retiring"`-এই আটকানো)।

## যেটা যোগ করা হলো (Phase 1E-b)

### `lib/jwt-keys.ts`-এ JWKS builder (pure, no I/O)
- **`Jwks`** ইন্টারফেস — `{ keys: RsaJwk[] }`।
- **`buildJwks(keys: VerificationKey[]): Jwks`** — প্রতিটা key-কে
  `verificationKeyToJwk()` (1E-a) দিয়ে convert করে; কোনো একটা key convert
  করতে ব্যর্থ হলে (malformed row) সেটাকে log করে skip করে দেয় — বাকি সব
  valid key নিয়ে response তবু বানানো হয়, একটা খারাপ row-এর জন্য পুরো JWKS
  fail করে না।

### "exclude removed keys" — এখানে আলাদা কোনো filter লাগেনি
রোডম্যাপের 1E-b acceptance criteria-র "removed keys বাদ" — এটা `buildJwks()`
নিজে করে না, করার দরকারও নেই: `VerificationKey.status` টাইপ-লেভেলেই
(`JwtKeyStatus = "active" | "retiring"`, Phase 1D-a) `"retired"` ধারণ
করতেই পারে না — `canVerify()`/`fetchDbVerificationKeys()` (1D-a/1D-c) সেই
row-গুলোকে আগেই বাদ দিয়ে দেয়। তাই একটা "retired" key `buildJwks()`-এর
ইনপুট array-তে কখনোই ঢুকতে পারে না — exclusion আগেই এক লেয়ার নিচে ঘটে
গেছে।

### Empty/error case
- খালি input → `{ keys: [] }` — error না, exception না। Verification-key
  cache এখনো load না হলে (1D-b) এটা একটা valid-if-unusual অবস্থা, 1E-c-এর
  endpoint এটাকে special-case ছাড়াই রিটার্ন করতে পারবে।
- একটামাত্র corrupt row থাকলে সেটা skip হয়, বাকি key-গুলো তবু response-এ
  থাকে (উপরে বলা হয়েছে)।

## টেস্ট — `scripts/src/test-jwks-builder.ts`
1D-a-এর `test-verification-keys.ts`-এর মতোই pure, DB-ছাড়া, কিন্তু আসল RSA
keypair দিয়ে (1E-a-এর টেস্টের মতোই):
1. খালি input → `{ keys: [] }`।
2. একই input দুইবার → deterministic (একই order, একই shape)।
3. active key → পুরো RS256 JWK হিসেবে include হয়।
4. retiring key active-এর পাশে include হয় (grace-period visibility)।
5. "retired" key input-এই থাকতে পারে না (compile-time গ্যারান্টি) —
   runtime-এ এটা নিশ্চিত করা হয়েছে যে `buildJwks()` নিজে থেকে আলাদা কোনো
   filter যোগ করে ফলাফলের সাথে দ্বন্দ্ব তৈরি করছে না।
6. built response-এ কোথাও কোনো private material নেই (`d`/`p`/`q`), প্রতিটা
   key-এর ঠিক ৬টা ফিল্ড।
7. একটা malformed key skip হয়, বাকিগুলো response-এ থাকে।
8. একাধিক retained key (multi-rotation history simulate করে) — সবগুলো
   resolve হয়, প্রতিটা `kid` আলাদা।

**সব ৮টা assertion পাশ করেছে** — `npx tsx scripts/src/test-jwks-builder.ts`,
আসল `tsx` execution-এ।

## Sandbox নোট
1E-a-এর মতোই — `@workspace/db`/`pino`-এর জন্য একই লোকাল sandbox stub
ব্যবহার হয়েছে (দেখুন `CHANGES_JWT_RSA_TO_JWK_PHASE1E_A.md`)। `tsc --noEmit
--strict` (isolated config) দিয়ে চেক করা হয়েছে — নতুন কোডে কোনো error
নেই, শুধু প্রত্যাশিত `@types/node` noise।

## জানা limitation
- এই builder pure — কোনো live key source (DB/`getVerificationKeys()`)
  wire করা হয়নি এখনো। সেটা 1E-c-এর কাজ (`/.well-known/jwks.json`
  endpoint), যেটা এই ফেজে ইচ্ছাকৃতভাবে টাচ করা হয়নি।

## Phase 1E-a + 1E-b সম্পূর্ণ
- 1E-a: "generated JWK can represent every retained verification key" ✓,
  "private material never appears" ✓ (৮টা assertion)।
- 1E-b: "response structure is deterministic" ✓, "tests cover active,
  retained and removed keys" ✓ (৮টা assertion)।
- মোট ১৬টা assertion, দুটো আলাদা টেস্ট ফাইলে, দুটোই আসল RSA crypto দিয়ে।

## পরের সাব-ফেজ
**1E-c — `/.well-known/jwks.json`** — HTTP endpoint যোগ করা, যেটা
`getVerificationKeys()` (1D-a) → `buildJwks()` (এই ফেজ) চেইন করে JWKS serve
করবে, সঠিক content-type সহ, cache behavior rotation-compatible রেখে। এই
রানে শুরু করা হয়নি — রোডম্যাপ অনুযায়ী পরের ধাপ।
