# OIDC Roadmap — Season 1, Phase 1D-f: Rotation Integration Verification

## যা আগে থেকেই ছিল
Phase 1D-a থেকে 1D-e পর্যন্ত প্রতিটা সাব-ফেজ নিজের নিজের **pure logic**
আলাদাভাবে টেস্ট করেছে (merge, kid lookup, lifecycle rule, rotation plan,
retention plan) — কিন্তু কেউই পুরো chain-টা **একসাথে, একটা বাস্তব
rotation চক্র হিসেবে** চালিয়ে দেখেনি। আর প্রতিটা ফেজের CHANGES-এর "জানা
limitation"-এ বারবার একই কথা এসেছে: আসল RSA sign→verify round-trip (এই
sandbox-এ `jsonwebtoken` প্যাকেজ ইনস্টল করা নেই বলে) কখনো সত্যিকারের crypto
দিয়ে টেস্ট করা যায়নি — শুধু "কোন key resolve হলো" পর্যন্ত logic টেস্ট হয়েছে।

## যেটা যোগ করা হলো (Phase 1D-f)

### `scripts/src/test-rotation-lifecycle.ts` — **নতুন ফাইল**
রোডম্যাপের ৭-পয়েন্ট টেস্ট লিস্টটাই সরাসরি ১৩টা assertion-এ রূপান্তর করা
হয়েছে, **আসল আগের সাব-ফেজগুলোর pure ফাংশন একসাথে wire করে**:
`mergeVerificationKeys()` (1D-a) + `canSign()`/`canVerify()` (1D-c) +
`planRotation()` (1D-d) + `planRetirement()`/`isRetirementSafe()` (1D-e)।

1. **old key signs** — RSA keypair generate, সাইন, নিজের public key দিয়ে
   verify হয়।
2. **new key is introduced** — `planRotation()` আসল rotation approve করে।
3. **new tokens use new kid** — নতুন key দিয়ে সাইন করা token-এর `kid`
   header নতুন kid-ই, আর `mergeVerificationKeys(..., "kid-new")` ঠিক সেই
   key-ই resolve করে।
4. **old tokens verify with old key** — rotation-এর পরও
   `mergeVerificationKeys(..., "kid-old")` পুরনো key resolve করে (status
   `retiring`, `canVerify() === true`), আর সেই key দিয়ে পুরনো token সত্যিই
   verify হয়। **Cross-check**: পুরনো token নতুন key-র public key দিয়ে verify
   *হয় না*, আর উল্টোটাও না — প্রমাণ করে যে key resolution সত্যিই cryptographic
   অর্থে গুরুত্বপূর্ণ, শুধু bookkeeping না।
5. **unknown kid fails** — একটা অজানা kid `mergeVerificationKeys()`-এ দিলে
   খালি array, আর একটা attacker-এর নিজের key দিয়ে সাইন করা forged token
   (দাবি করে অজানা kid-এর) সেই খালি candidate list-এর বিরুদ্ধে verify হয় না।
6. **old key eventually becomes removable** — rotation-এর মুহূর্তে
   `planRetirement()` বলে "না, এখনই না"; ১ দিন পরও "না"; ঠিক
   `RETENTION_PERIOD_MS` পার হলে "হ্যাঁ"।
7. **removed key no longer verifies** — retire হওয়ার পর (সিমুলেটেড: DB read
   থেকে বাদ) `mergeVerificationKeys(..., "kid-old")` খালি array রিটার্ন করে,
   পুরনো token আর verify হয় না — নতুন key-র উপর কোনো প্রভাব পড়ে না সেটাও
   আলাদাভাবে assert করা হয়েছে।

### আসল RSA cryptography, কোনো external dependency ছাড়াই
`jsonwebtoken` এই sandbox-এ ইনস্টল করা নেই, কিন্তু Node-এর built-in
`node:crypto`-ই RS256-এর আসল কাজটা করে — `generateKeyPairSync("rsa", ...)`
দিয়ে RSA keypair, `crypto.sign("RSA-SHA256", ...)`/`crypto.verify(...)` দিয়ে
সাইন/verify। এই ফাইলে একটা ছোট, self-contained RS256-shaped JWT
সাইন/verify হেল্পার লেখা হয়েছে (`header.payload.signature`, base64url,
RSA-SHA256) — ঠিক `jsonwebtoken`-এর RS256 mode আসলে যা করে তাই, শুধু
প্যাকেজ ছাড়া। এটা কোনো production কোড টাচ করে না — শুধু এই টেস্ট ফাইলের
নিজস্ব, test-only সাইন/verify লজিক, যেটা `lib/jwt.ts`-এর
`signAuthToken()`/`tryVerifyRs256()`-এর মতোই shape রাখা হয়েছে (একই ধরনের
header/kid/candidate-loop) যাতে যেটা টেস্ট হচ্ছে সেটা আসল ব্যবহারের প্যাটার্নের
কাছাকাছি থাকে।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `scripts/src/test-rotation-lifecycle.ts` | **নতুন ফাইল** — ১৩টা assertion, আসল RSA crypto + আগের সব সাব-ফেজের pure ফাংশন একসাথে। |
| `scripts/package.json` | নতুন script: `jwt:test-rotation-lifecycle`। |

`lib/jwt-keys.ts`, `lib/jwt.ts`, `rotate-jwt-signing-key.ts`,
`retire-jwt-signing-keys.ts` — টাচ করা হয়নি এই ফেজে; শুধু import করে ব্যবহার
করা হয়েছে।

## যা টেস্ট করা হয়েছে
- **আসল `tsx` দিয়ে সরাসরি চালানো, আসল RSA crypto সহ (পাশ)** —
  `npx tsx scripts/src/test-rotation-lifecycle.ts` — ১৩টা assertion-ই পাশ
  করেছে, প্রতিটাই আসল `generateKeyPairSync`/`crypto.sign`/`crypto.verify`
  ব্যবহার করে (কোনো mock/stub crypto না)। এটাই আগের প্রতিটা ফেজের CHANGES-এ
  চিহ্নিত "known limitation" (real crypto round-trip টেস্ট করা যায়নি) বন্ধ
  করে — এই একটা ফাইলেই।
- Runtime-এ resolve করার জন্য 1D-e-এর মতোই একই লোকাল sandbox stub
  (`node_modules/@workspace/db`, `node_modules/pino` — শুধু import
  resolve করার জন্য) ব্যবহার করা হয়েছে; `planRotation` import করার সময়
  `rotate-jwt-signing-key.ts`-এর module-level `main()` (pre-existing,
  1D-d-এরই — guard করা নেই যে module import vs. সরাসরি চালানো) side-effect
  হিসেবে চলে ও `pool.query()` stub-এ থ্রো করে — এটা প্রত্যাশিত এবং
  `test-rotate-jwt-signing-key.ts` (1D-d)-এও ঠিক একই আচরণ, এই ফেজের কোনো
  পরিবর্তনের ফল না; **সব ১৩টা assertion তার আগেই পাশ করে ফেলে**, এই
  side-effect error টেস্টের ফলাফলকে প্রভাবিত করে না।
- `tsc --noEmit --strict` (isolated config) দিয়ে চেক করা হয়েছে — শুধু
  প্রত্যাশিত noise (`@types/node` না থাকা), কোনো actual syntax/logic error
  নেই।

## জানা limitation
- এই টেস্ট `lib/jwt.ts`-এর আসল `signAuthToken()`/`verifyAuthToken()` ফাংশন
  সরাসরি কল করে না (সেগুলোর জন্য `jsonwebtoken` প্যাকেজ লাগে, যেটা এই
  sandbox-এ নেই) — বরং একই shape-এর একটা self-contained RS256 helper
  ব্যবহার করে যেটা এই টেস্ট ফাইলেই সংজ্ঞায়িত। কোন key candidate resolve হয়
  (মূল জিনিস যেটা 1D-a/1D-b/1D-c/1D-d/1D-e ঠিক করে) সেটা আসল ফাংশন থেকেই
  আসে; শুধু "সেই candidate দিয়ে signature verify হয় কিনা" অংশটা টেস্ট-লোকাল
  crypto দিয়ে করা হয়েছে।
- আসল DB-চালিত rotation চক্র (rotate script চালানো → বাস্তব প্রসেস restart →
  নতুন লগইন → retire script চালানো retention window পার হওয়ার পর) — এখনো
  এই sandbox-এ integration-test করা যায়নি (কোনো DB connection নেই)।
  Staging-এ deploy-এর আগে এই পূর্ণ চক্রটা একবার ম্যানুয়ালি sanity-check করা
  ভালো — এখন থেকে সব individual পদক্ষেপ (rotate, retire, উভয় verify পাথ)
  আলাদাভাবে টেস্ট করা আছে, শুধু বাস্তব DB-এর সাথে wiring-টা বাকি।

## Phase 1d সম্পূর্ণ
রোডম্যাপ অনুযায়ী: **"Phase 1d DONE only after all tests pass."** — 1D-a
থেকে 1D-f পর্যন্ত প্রতিটা সাব-ফেজের টেস্ট (মোট ৪৭টা assertion, 1D-a-এর ৬টা
+ 1D-b-এর ৭টা + 1D-c-এর ১০টা + 1D-d-এর ৫টা + 1D-e-এর ১১টা + 1D-f-এর ১৩টা
নিজের নিজের ফাইলে) পাশ করেছে — 1D-e/1D-f-এর ২৪টা এই ফেজে **আসল `tsx`
execution**-এ (dependency-free `.mjs` কপি না) verify করা হয়েছে। **পরের
ধাপ: Phase 1e — OIDC Discovery & JWKS** (RSA-to-JWK conversion,
`/.well-known/jwks.json`, `/.well-known/openid-configuration`)।
