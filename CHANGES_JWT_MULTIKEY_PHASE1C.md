# OIDC Roadmap — Season 1, Phase 1C: Multi-key storage/schema

## যা আগে থেকেই ছিল
- `lib/jwt-keys.ts`-এর `getActiveKeypair()` env var (`AYZEN_JWT_PRIVATE_KEY` /
  `AYZEN_JWT_PUBLIC_KEY` / `AYZEN_JWT_KID`) থেকে **একটামাত্র** active RSA
  keypair resolve করত। এর বাইরে কোনো key-এর কোনো durable রেকর্ড ছিল না।
- এতে rotation করলেই সমস্যা: env var-এর `kid` বদলালে সাথে সাথে পুরনো `kid`
  দিয়ে সাইন-করা সব টোকেন unverifiable হয়ে যেত — 7 দিনের স্বাভাবিক expiry
  পর্যন্ত অপেক্ষা করার বদলে সবাই সাথে সাথে লগ-আউট।

## যেটা যোগ করা হলো (Phase 1C)
শুধু **storage/schema** — নতুন `jwt_signing_keys` টেবিল, `kid` দিয়ে indexed,
প্রতিটা retained PUBLIC key-র জন্য একটা row। Private key এখানে কখনোই থাকে
না (আগের মতোই একটামাত্র active env var) — এই টেবিল শুধু *verify* করার জন্য
যা দরকার তা রাখে, *sign* করার জন্য না।

`status` কলাম দিয়ে overlap window মডেল করা হয়েছে:
- `active` — এখন যেটা দিয়ে নতুন টোকেন সাইন হচ্ছে (একসময়ে exactly ১টা, DB-level
  partial unique index দিয়ে enforced)
- `retiring` — নতুন করে সাইন করছে না, কিন্তু verify-এর জন্য এখনো valid
- `retired` — verify-এর জন্যও আর valid না, শুধু audit history হিসেবে রাখা

### এই ফেজে যা **নেই** (ইচ্ছাকৃতভাবে — Phase 1D/1E-এর কাজ)
- কোনো rotation trigger বা policy নেই ("retiring" কতদিন থাকবে সেই সিদ্ধান্ত)
- `getVerificationKeys(kid?)`-জাতীয় কোনো ফাংশন নেই
- `lib/jwt-keys.ts` / `lib/jwt.ts`-এ **কোনো পরিবর্তন হয়নি** — `getActiveKeypair()`
  আগের মতোই env-var-only; এই টেবিলে এখনো কোনো app code read/write করে না
- `/.well-known/jwks.json` (Phase 1E) — এই টেবিল থেকে publish করবে, কিন্তু
  সেটা এখনো লেখা হয়নি

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `migrations/078_ayzen_oidc_jwt_signing_keys.sql` | **নতুন migration** — `jwt_signing_keys` টেবিল তৈরি: `kid` (unique), `public_key` (PEM), `algorithm`, `status` + state-consistency CHECK constraints, single-active partial unique index, delete-guard trigger (encryption_keys/vault_backup_audit_log-এর মতো append-only discipline) |
| `lib/db/src/schema/jwt-signing-keys.ts` | **নতুন ফাইল** — উপরের টেবিলের drizzle mirror + `InsertJwtSigningKey`/`JwtSigningKeyRow` টাইপ |
| `lib/db/src/schema/index.ts` | নতুন schema export যোগ |

## যা টেস্ট করা হয়েছে
- নতুন/edited ফাইলের bracket/paren balance চেক করা হয়েছে।
- Migration SQL-এর logic হাতে ভেরিফাই করা হয়েছে: partial unique index
  idiom (`ON t ((true)) WHERE status = 'active'`), state-consistency CHECK-
  গুলোর truth table (active⇔retiring_at NULL, retired⇔retired_at NOT NULL)।
- এই পরিবেশে `node_modules` ইনস্টল করা নেই (network off), তাই `drizzle-kit
  push` বা `tsc` দিয়ে সরাসরি compile/push যাচাই করা যায়নি — migration আগের
  067/073-এর pattern হুবহু অনুসরণ করে লেখা হয়েছে (যেগুলো ইতিমধ্যে
  production-এ apply করা)।
- `lib/jwt-keys.ts`, `lib/jwt.ts` — এই ফেজে touch করা হয়নি, তাই ওগুলোর
  আগের behavior/টেস্ট অপরিবর্তিত থাকার কথা।

## পরের ধাপ (Phase 1D)
- Rotation trigger + policy ঠিক করা (ম্যানুয়াল script vs. scheduled, "retiring"
  কতদিন থাকবে)
- `getVerificationKeys(kid?)` লেখা, যাতে verify-পথ `jwt_signing_keys`-এর
  active+retiring row-গুলো চেক করতে পারে
- বুটে/rotation-এ এই টেবিলে actual write path (আগে শুধু schema ছিল, এখন
  data)
