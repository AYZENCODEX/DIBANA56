# AYZEN Policy & Authorization Mega Engine — Phase 09, sub-phase 9B: Verification-level PIP adapter (real, capability-only data)

## কেন `verificationLevel`-এই থামা হলো, `assuranceMethods` না

ইউজারকে সরাসরি জিজ্ঞেস করা হয়েছিল 9B কীভাবে এগোবে, কারণ কোডবেস ঘেঁটে
পাওয়া গেছে যে `Subject.assuranceMethods`-এর জন্য দরকার "এই সেশনে আসলে কোন
method ব্যবহার হয়েছিল" (usage), কিন্তু বিদ্যমান টেবিল
(`users.two_fa_enabled`, `passkey_credentials`, `user_backup_codes`) শুধু
বলে "account-এ কী সেটআপ আছে" (capability) — আর `createSession()`
(sessions.ts) কোনো method/login_history লিংক রাখে না। Capability দিয়ে
`assuranceMethods` populate করলে একটা password-only লগইনও 2FA-enabled
account-এর ক্ষেত্রে ভুলভাবে "MFA satisfied" (L3) দেখাতো — এটা একটা আসল
security regression হতো, শুধু অসম্পূর্ণ ফিচার না।

ইউজার নিশ্চিত করলেন: **শুধু `verificationLevel`-এর জন্য capability-based
provider বানাও, `assuranceMethods` না** — যেহেতু `verificationLevel`
roadmap-এই ডিফাইন করা "account-এর overall verification standing" (KYC-এর
কাছাকাছি), সেশন-ব্যবহার না, তাই capability/account-state দিয়ে populate
করা সিমেন্টিক্যালি নিরাপদ।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/policy/pip/verification-level-adapter.ts` (**নতুন**) | DB-free: `AccountVerificationStanding` (তিনটা ফিল্ড: `emailVerified`/`kycVerified`/`kycLevel`), `VerificationLevelProvider` ইন্টারফেস, `VerificationLevelLabel` (`"unverified"`/`"email_verified"`/`"identity_verified"` — `../types.ts`-এর নিজস্ব doc-comment-এ উদাহরণ দেওয়া ঠিক এই তিনটাই), pure `mapAccountStandingToVerificationLevel()`, আর `withVerificationLevel(subject, provider)` — একটা নতুন `Subject` রিটার্ন করে (আসলটা mutate করে না)। |
| `lib/policy/pip/drizzle-verification-level-provider.ts` (**নতুন**) | আসল `@workspace/db`-backed `DrizzleVerificationLevelProvider` — `users.emailVerified`/`kycVerified`/`kycLevel` পড়ে (`SELECT *` না, ঠিক এই তিনটা কলাম)। `lib/policy/pip/*`-এর একমাত্র ফাইল যেটা `@workspace/db` import করে। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./pip/verification-level-adapter` যোগ হলো barrel-এ। `drizzle-verification-level-provider.ts` ইচ্ছাকৃতভাবে বাদ (RBAC/Resource/ReBAC/Registry-এর একই precedent — সরাসরি import করতে হবে যেখানে আসলে লাগবে)। |
| `scripts/src/test-policy-verification-level.ts` (**নতুন**) | ১৪টা DB-free টেস্ট — mapping-এর প্রতিটা boundary (email vs KYC precedence, unknown user, kycLevel/kycVerified divergence), `withVerificationLevel()`-এর non-mutation/overwrite বিহেভিয়ার, আর 9A-এর `computeAssuranceLevel()`/`createAssuranceRule()`-এর সাথে end-to-end composition (একটা real `PolicyEngine` + RBAC rule-এর বিরুদ্ধে)। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **`kycVerified` KYC-level-এর উপর priority — email verification-এর
  উপর না override, শুধু outrank।** `mapAccountStandingToVerificationLevel()`
  প্রথমে KYC চেক করে কারণ একটা approved KYC submission সবসময় account
  signup-এর পরে ঘটে, তাই সেটা email-verification-এর চেয়ে কম নয় কখনোই —
  `emailVerified` ইগনোর করা হয় না, শুধু KYC থাকলে সেটাই জেতে।
- **`kycLevel >= 1` একা (এমনকি `kycVerified` false থাকলেও) এখনো
  `"identity_verified"` রিটার্ন করে।** আজকের `routes/users.ts`-এর
  `/admin/kyc/:userId/approve` সবসময় `kycVerified: true` আর `kycLevel: 1`
  একসাথে সেট করে, কিন্তু এই ফাংশন সেই invariant-এর উপর নির্ভর করে না —
  ভবিষ্যতে অন্য কোনো path যদি শুধু level সেট করে, সেটাও honored হবে।
- **`withVerificationLevel()` কখনো merge করে না, সবসময় overwrite করে।**
  একটা টেস্ট (`always overwrites a pre-set verificationLevel`) সরাসরি এটা
  pin করে — একটা caller-supplied stale মান থাকলেও, provider-এর real
  standing-ই সবসময় জেতে।
- **Provider-এ user না পাওয়া গেলে থ্রো না করে `unverified`-এ fail-closed
  হয়।** এটা এই ইঞ্জিনের বাকি সব provider-এর ("unknown key contributes
  nothing" — `RbacProvider.getRole()`, `ResourceGrantProvider.getResourceGrant()`)
  একই posture — যদিও practice-এ policy-engine.ts আগেই unauthenticated
  ফিল্টার করে, তাই এই branch defensive-only।
- **`DrizzleVerificationLevelProvider` `usersTable`-এর ঠিক তিনটা কলাম
  পড়ে, পুরো row না।** `users` টেবিলে অনেক sensitive কলাম আছে (username,
  hashes, ইত্যাদি) — এই provider শুধু `emailVerified`/`kycVerified`/
  `kycLevel` select করে, যাতে ভবিষ্যতে `users` টেবিল বড় হলেও (বা কোনো
  sensitive ফিল্ড যোগ হলে) এই ফাইলের scope নিজে থেকে না বাড়ে।

## যা ইচ্ছাকৃতভাবে 9B-তে নেই

- **`assuranceMethods` এখনো পপুলেট হয়নি** — কারণের বিস্তারিত উপরে এবং
  `verification-level-adapter.ts`-এর নিজস্ব হেডারে। সঠিকভাবে করতে হলে
  schema change (session-এ login method রেকর্ড করা) বা
  `auth.ts`/`passkey.ts`/`vault-reauth.ts`-এ route-level পরিবর্তন লাগবে —
  একটা পরের সাব-ফেজের কাজ, ইউজারের সাথে আলাদাভাবে confirm করা হবে।
- **`authenticationFreshnessSeconds` এখনো পপুলেট হয়নি** — vault-reauth
  ভেরিফাই সফল হলেও কোনো persistent timestamp কোথাও লেখা হয় না আজকে
  (`vault-pin-guard.ts`/`routes/vault-reauth.ts` চেক করা হয়েছে) — এটাও
  schema+route পরিবর্তন লাগবে।
- **কোনো route/middleware `withVerificationLevel()` বা
  `DrizzleVerificationLevelProvider` কল করে না।** Phase 19 (PEP) পর্যন্ত
  real wiring বাকি — বিদ্যমান কোনো auth flow অপরিবর্তিত।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-verification-level.ts`** — **১৪/১৪ পাস**।
- **রিগ্রেশন — Phase 1A থেকে 9A পর্যন্ত সবকয়টা suite আবার রান করা হয়েছে**
  (১৩টা suite) — **সবগুলো পাস, কোনো রিগ্রেশন নেই।** `lib/policy/index.ts`-এ
  শুধু একটা নতুন `export *` যোগ হয়েছে।
- **Dynamic-code-execution audit:** নতুন দুটো ফাইলে কোনো `eval`/
  `new Function`/`vm.Script` নেই।
- **`DrizzleVerificationLevelProvider` real DB-এর বিরুদ্ধে রান করা হয়নি**
  (network/DB নেই এই sandbox-এ) — Phase 02-07-এর প্রতিটা Drizzle
  provider-এর একই known limitation।

## Security tests কভার করা হয়েছে

- **Capability-vs-usage boundary সরাসরি pin করা:** `identity_verified
  alone still does not reach L3` টেস্ট নিশ্চিত করে KYC standing কখনো MFA
  (L3)-এর substitute হয়ে যায় না — দুটো স্বতন্ত্র axis (identity standing
  বনাম session-এর assurance method) মিশে যায় না।
- **Fail-closed on unknown user:** provider-এ কিছু না থাকলে `unverified`
  (সবচেয়ে দুর্বল), কখনো silently কিছু জোরালো ধরে নেয় না।
- **No merge-based bypass:** একটা stale/caller-supplied `verificationLevel`
  provider-এর real standing-কে override করতে পারে না — সরাসরি টেস্ট করা।
- **End-to-end composition:** একটা real `PolicyEngine` + RBAC rule-এর
  বিরুদ্ধে দুটো দিকই দেখানো হয়েছে — verified subject-এর জন্য ALLOW যায়,
  unverified subject-এর জন্য RBAC allow থাকা সত্ত্বেও STEP_UP-এ থামে।

## Regression status
কোনো রিগ্রেশন নেই।

## Migration status
সম্পূর্ণ additive, dormant। কোনো route/middleware/schema পরিবর্তন হয়নি।

## Next phase
`assuranceMethods` আর `authenticationFreshnessSeconds`-এর জন্য real wiring
(schema/route পরিবর্তন লাগবে, ইউজারের সাথে scope confirm করে) — অথবা
সরাসরি Phase 10 (Risk-Aware Authorization)।
