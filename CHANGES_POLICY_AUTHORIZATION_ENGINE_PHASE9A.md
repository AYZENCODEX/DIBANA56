# AYZEN Policy & Authorization Mega Engine — Phase 09, sub-phase 9A: Authentication Assurance (vocabulary + level computation + gate rule)

## স্কোপ কেন 9A/9B/9C-এ ভাগ করা হলো

Phase 09-এর roadmap সেকশন একসাথে তিনটা ভিন্ন কাজ দাবি করে: (ক) ৬-লেভেল
vocabulary + একটা Subject/Context থেকে লেভেল বের করার নিয়ম, (খ) সেই
লেভেল দিয়ে sensitive action-কে গেট করার একটা আসল `PolicyRule`, (গ) আসল
Passkey/MFA/session-freshness ডেটা দিয়ে `Subject.assuranceMethods` /
`Subject.verificationLevel` / `PolicyContext.authenticationFreshnessSeconds`
populate করার PIP ওয়্যারিং। Phase 01 (1A/1B/1C) আর Phase 03 (3A/3B/3C)
একই কারণে সাব-ফেজে ভাগ হয়েছিল — প্রতিটা অংশ independently রিভিউ-যোগ্য আর
টেস্টযোগ্য একটা ইউনিট। এই পাসে **9A** কভার করা হলো: (ক) আর (খ) — vocabulary,
pure computation, আর গেট rule, একসাথে (ঠিক যেভাবে Phase 3A ownership
resolver+rule দুটোই একসাথে দিয়েছিল)। (গ) — real Passkey/MFA/session ডেটার
সাথে ওয়্যারিং — ইচ্ছাকৃতভাবে **9A-তে নেই** (roadmap Rule 16), পরের সাব-ফেজের
কাজ।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/policy/assurance/types.ts` (**নতুন**) | `ASSURANCE_LEVEL_ORDER` — roadmap-এর ৬টা লেভেল (`L0`...`L5`), দুর্বলতম-প্রথম। `ASSURANCE_RANK` (derived), `ASSURANCE_LEVEL_LABELS`, `assertValidAssuranceLevel()` — ঠিক `precedence-tiers.ts`-এর (Phase 08) একই প্যাটার্ন। |
| `lib/policy/assurance/assurance-level.ts` (**নতুন**) | `computeAssuranceLevel(subject, context)` — pure, deterministic ফাংশন। `assuranceMethods`/`verificationLevel` থেকে একটা base level (L1-L4) বের করে, তারপর `authenticationFreshnessSeconds` (৫ মিনিট window-এর ভিতরে হলে) দিয়ে সেটাকে L5-এ upgrade করে কিনা দেখে। `assuranceLevelMeetsMinimum(level, minimum)` হেল্পারও এখানে। |
| `lib/policy/assurance/assurance-rule.ts` (**নতুন**) | `createAssuranceRule(requirements)` — এই ইঞ্জিনের ৭ম আসল `PolicyRule`। শুধু STEP_UP অথবা abstain করে — কখনো ALLOW করে না (এটা একটা গেট, grant path না)। একাধিক matching requirement থাকলে সবচেয়ে কড়াটা (strictest) দিয়ে চেক করে। Action matching RBAC-এর `permissionMatches()` গ্রামার পুনর্ব্যবহার করে। |
| `lib/policy/assurance/index.ts` (**নতুন**) | Barrel — কোনো Drizzle provider বাদ দেওয়ার দরকার নেই, কারণ 9A কোনো persistence যোগ করেনি (ঠিক Phase 05 ABAC-এর মতো)। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./assurance` যোগ হলো টপ-লেভেল barrel-এ। |
| `scripts/src/test-policy-assurance.ts` (**নতুন**) | ২৯টা DB-free টেস্ট — vocabulary shape, `computeAssuranceLevel()`-এর প্রতিটা path (L0-L5, freshness window-এর boundary সহ), আর `createAssuranceRule()`-এর গেট বিহেভিয়ার (satisfied→abstain, unmet→STEP_UP, strictest-wins, "কখনো ALLOW করে না" আসল RBAC allow-এর বিরুদ্ধে composition দিয়ে যাচাই)। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **`createAssuranceRule()` কখনো `ALLOW` রিটার্ন করে না — শুধু `STEP_UP`
  অথবা abstain।** এই ইঞ্জিনের বাকি সব rule (RBAC/ownership/explicit-grant/
  org-access/ReBAC/ABAC) কোনো না কোনোভাবে ALLOW দিতে পারে — assurance rule
  ইচ্ছাকৃতভাবে পারে না। Roadmap নিজেই এটাকে একটা REQUIREMENT হিসেবে
  ফ্রেম করে ("Sensitive operations can require minimum assurance"), একটা
  স্বতন্ত্র grant path না — ঠিক যেমন Phase 10-এর risk engine সম্পর্কে
  roadmap বলে "Risk Engine = calculates risk; Policy Engine = decides
  what to do with risk", এখানেও assurance মেটা মানে "অনুমতি আছে" না,
  শুধু "একটা বাধা সরে গেছে"। এই নিয়মটা নিজে থেকে সত্যি হয় না — একটা টেস্ট
  সরাসরি pin করে (`assurance rule never manufactures an ALLOW on its
  own`): assurance requirement মিট করা সত্ত্বেও, কোনো RBAC rule
  register না থাকলে ফলাফল এখনো default-deny, ALLOW না।
- **L5 ("fresh high-assurance authentication") একটা আলাদা, স্ট্রংগার
  method না — একটা RECENCY modifier যেকোনো base level-এর উপর বসতে
  পারে।** `Subject.assuranceMethods`-এর নিজস্ব doc comment (Phase 05-এ
  লেখা) স্পষ্ট করে যে `authenticationFreshnessSeconds` মানে "সেশন পুরনো
  হতে পারে কিন্তু সবশেষ strong-auth মুহূর্ত সাম্প্রতিক (যেমন একটা step-up
  এইমাত্র শেষ হলো)" — তাই `computeAssuranceLevel()` freshness-কে
  `assuranceMethods`-এর সাথে cross-check করে না, শুধু window-এর ভিতরে
  আছে কিনা দেখে, আর থাকলে সরাসরি L5 রিটার্ন করে, base level যাই হোক না
  কেন। Freshness window ৫ মিনিট (`ASSURANCE_FRESHNESS_WINDOW_SECONDS`) —
  একটা মাল্টি-রিকোয়েস্ট sensitive workflow-এ প্রতি রিকোয়েস্টে re-prompt
  এড়াতে যথেষ্ট বড়, কিন্তু "এক ঘণ্টা আগে step-up করেছিলাম" আর "fresh" গণ্য
  না হওয়ার জন্য যথেষ্ট ছোট।
- **`verificationLevel` parse করা হয় না, শুধু presence-check করা হয়।**
  এই ফিল্ড এখনো কোনো স্কিমা দিয়ে backed না (দেখুন `../types.ts`-এর নিজস্ব
  কমেন্ট — "Nothing sets it yet")। একটা নির্দিষ্ট enum/numeric স্কেল
  ধরে নেওয়ার বদলে, `UNVERIFIED_MARKERS`-এর একটা ছোট, conservative সেট
  (`"unverified"`, `"none"`, `"pending_verification"`, `0`) বাদ দিয়ে
  বাকি সবকিছুকে "L2-এর জন্য যথেষ্ট verified" ধরা হয়েছে — একটা real
  verification-level টেবিল আসলে এই ফাংশনটা রিফাইন করবে, কিন্তু ইন্টারফেস
  (`computeAssuranceLevel`) বদলাবে না।
- **`"password"` কখনো MFA (L3) গণ্য হয় না, যদিও এটা `AssuranceMethod`
  union-এর একটা বৈধ মান।** পাসওয়ার্ড হলো base factor যেটা প্রতিটা
  authenticated session-এরই আছে (Phase 01-এর `Subject` মানেই একটা
  authenticated caller) — সেটাকে একটা "সেকেন্ড ফ্যাক্টর" হিসেবে গোনা
  privilege-escalation-এর একটা সূক্ষ্ম রূপ হতো। শুধু `totp`/`otp`/
  `backup_code` (আসল দ্বিতীয় ফ্যাক্টর) MFA_METHODS-এ আছে; `passkey` তার
  নিজের উচ্চতর tier (L4)-এ চলে যায়, তাই এই সেটে নেই।
- **`createAssuranceRule()` requirement-এর তালিকায় typo হলে registration-
  টাইমেই থ্রো করে, প্রতি-রিকোয়েস্ট-এ চুপচাপ `undefined`-এর বিরুদ্ধে
  compare করে না।** ঠিক `PrecedenceEngine.registerRule()` (Phase 08) যেভাবে
  একটা ভুল tier স্ট্রিং-এ সাথে সাথে থ্রো করে, একই posture এখানে
  `assertValidAssuranceLevel()` দিয়ে — একটা `"L9"`-এর মতো টাইপো production-এ
  নীরবে "সবসময় satisfied" (undefined rank বনাম আসল rank-এর তুলনায়
  `NaN`-জাতীয় আচরণ) হওয়ার বদলে আগেই ধরা পড়ে।
- **একাধিক matching requirement থাকলে সবচেয়ে কড়াটা (strictest) জেতে,
  প্রথমটা না।** একটা broad `"ryft.payment.*"` rule L2-তে আর একটা narrow
  `"ryft.payment.approve"` rule L4-তে — দুটোই যদি রেজিস্টার থাকে, তাহলে
  L2 মেটানো একজন subject-কে L4 requirement বাইপাস করতে দেওয়া হয় না।
  `strictestMatchingRequirement()` পুরো তালিকা স্ক্যান করে সর্বোচ্চ
  `minimumLevel`-টা বের করে, list-order-এর প্রথম ম্যাচ না।
- **`PrecedenceEngine`-এ এই rule কোন tier-এ বসবে তা 9A নিজে ঠিক করে না।**
  Phase 08-এর `PRECEDENCE_ORDER`-এ কোনো "assurance" tier নেই — roadmap-এর
  Phase 08 (precedence) আর Phase 09 (assurance) দুটো স্বতন্ত্র অক্ষ, আর
  কোনোটাই বলে না এরা কীভাবে nest করবে। `precedence-engine.ts`-এর নিজস্ব
  হেডার ABAC-এর জন্য যে সিদ্ধান্ত নিয়েছিল, এখানেও একই — যে কেউ একটা
  নির্দিষ্ট `PrecedenceEngine` instance ওয়্যার করছে, সে ঠিক করবে এই rule
  কোন tier-এ যাবে; flat `PolicyEngine` ব্যবহার করলে এই প্রশ্নই ওঠে না।

## যা ইচ্ছাকৃতভাবে 9A-তে নেই (পরের সাব-ফেজের জন্য)

- **কোনো PIP/adapter পরিবর্তন হয়নি।** `pip/subject-adapter.ts#subjectFromAuthUser()`
  এখনো `assuranceMethods`/`verificationLevel` `undefined` রেখে দেয় (সেই
  ফাইলের নিজস্ব হেডার, এই পাসে অপরিবর্তিত)। আসল Passkey (`lib/passkey.ts`)/
  MFA (`lib/totp.ts`, `lib/otp-store.ts`)/session (`lib/login-security.ts`)
  ডেটা থেকে এই তিনটা ফিল্ড populate করা একটা আলাদা কাজ — 9A-এর "ফিল্ড থাকলে
  লেভেল বের করো" contract-এর সাথে bundled করা হয়নি।
- **কোনো route/middleware `createAssuranceRule()` কল করে না।** Phase 19
  (PEP) পর্যন্ত real wiring ইচ্ছাকৃতভাবে বাকি — এটা Phase 02-08-এর প্রতিটা
  rule-ই যে posture মেনে চলেছে তার ধারাবাহিকতা।
- **Risk Engine ইন্টিগ্রেশন নেই।** `Subject.riskLevel` এই মডিউলের কোথাও
  পড়া হয়নি — Phase 10-এর স্বতন্ত্র concern।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-assurance.ts`** — **২৯/২৯ পাস**।
- **রিগ্রেশন — Phase 1A থেকে Phase 08 পর্যন্ত সবকয়টা suite আবার রান করা
  হয়েছে** (`test-policy-engine`, `test-policy-pip`,
  `test-policy-decision-observer`, `test-policy-rbac`,
  `test-policy-resource`, `test-policy-resource-grants`,
  `test-policy-resource-org-access`, `test-policy-rebac`,
  `test-policy-abac`, `test-policy-dsl`, `test-policy-registry`,
  `test-policy-precedence`) — **সবগুলো পাস, কোনো রিগ্রেশন নেই।**
  `lib/policy/index.ts`-এ শুধু একটা নতুন `export *` যোগ হয়েছে, বিদ্যমান
  কোনো ফাইল পরিবর্তন হয়নি।
- **Dynamic-code-execution audit:** `grep -rn "eval(\|new Function(\|vm\.Script" lib/policy/assurance/`
  — কোনো ফলাফল নেই।
- **`tsc --build` এই sandbox-এ রান করা যায়নি** (network/`node_modules`
  নেই) — Phase 02-08-এর একই known limitation।

## Security tests কভার করা হয়েছে

- **Never manufactures an ALLOW:** সরাসরি টেস্ট করা হয়েছে যে requirement
  মিট করা সত্ত্বেও, RBAC/ownership/ইত্যাদি অন্য কোনো grant-path rule
  register না থাকলে ফলাফল `NO_MATCHING_POLICY` (default deny), `ALLOW`
  না — এই rule নিজে কখনো access তৈরি করে না।
- **STEP_UP short-circuits একটা আসল RBAC ALLOW-কে।** একজন subject যার
  role RBAC-এর মাধ্যমে `ryft.payment.approve` permission রাখে, কিন্তু
  assurance requirement (L3) মেটায় না — তার ফলাফল `STEP_UP`, `ALLOW` না,
  প্রমাণ করে assurance gate deny-overrides-এর মতো higher-priority।
- **Strictest-requirement bypass attempt:** একটা looser (L2) requirement
  মিট করে একটা stricter (L4) requirement বাইপাস করার চেষ্টা টেস্ট করা
  হয়েছে — bypass হয় না, STEP_UP-ই থাকে।
- **Boundary — freshness window:** ঠিক window-এর সীমায় (৩০০ সেকেন্ড) আর
  এক সেকেন্ড পরে — দুটো আলাদা টেস্ট, নিশ্চিত করে boundary off-by-one নেই।
- **Malformed input fails closed:** নেগেটিভ `authenticationFreshnessSeconds`
  (একটা malformed/impossible ইনপুট) ignore হয়, base level-এ fall back
  করে — crash বা ভুলভাবে L5 দেয় না।
- **Fail-loud registration:** একটা অচেনা `minimumLevel` স্ট্রিং
  (`"L9"`) দিয়ে `createAssuranceRule()` কল করলে সাথে সাথেই থ্রো করে,
  পরে চুপচাপ ভুল আচরণ করে না।

## Regression status
কোনো রিগ্রেশন নেই।

## Migration status
কোনো route/middleware ওয়্যার করা হয়নি — শুধু নতুন, dormant `lib/policy/assurance/*`
মডিউল। বিদ্যমান কোনো ফাইল বাদে `lib/policy/index.ts`-এ এক লাইনের barrel
addition — বাকি সব additive।

## Next phase
Phase 9B (প্রস্তাবিত) — real Passkey/MFA/session-freshness ডেটা দিয়ে
`Subject.assuranceMethods`/`Subject.verificationLevel`/
`PolicyContext.authenticationFreshnessSeconds` populate করার PIP adapter,
তারপর Phase 10 (Risk-Aware Authorization)।
