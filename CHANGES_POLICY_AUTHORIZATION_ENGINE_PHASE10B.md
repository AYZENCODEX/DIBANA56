# AYZEN Policy & Authorization Mega Engine — Phase 10, sub-phase 10B: Risk calculation (real login-security signal wiring)

## স্কোপ

10A শিপ করেছিল "Policy Engine decides what to do with risk" অংশ
(`createRiskRule()`), কিন্তু `Subject.riskLevel` কোথাও populate হতো না।
10B হলো roadmap-এর "Risk Engine = calculates risk" অংশ — বিদ্যমান
`lib/login-security.ts`-এর real signal পুনর্ব্যবহার করে (roadmap Rule 4:
"Reuse existing ... login-security, risk ... data") — কোনো নতুন
telemetry/টেবিল ছাড়াই।

## দুটো signal, কোথা থেকে এলো

1. **Anomalous IP** — `isAnomalousIp(userId, ip)` (`lib/login-security.ts`,
   Phase-01-এরও আগে থেকে বিদ্যমান) — এই request-এর IP এই account-এর
   recent successful login-এর মধ্যে আগে দেখা গেছে কিনা।
2. **Recent failed-login burst** — একই `login_history` টেবিল থেকে, গত
   ৩০ মিনিটে কতগুলো `status = 'failed'` row আছে এই userId-এর জন্য
   (`idx_login_history_user_status` ইনডেক্স আগে থেকেই আছে, তাই নতুন কোনো
   ইনডেক্স লাগেনি)।

**গুরুত্বপূর্ণ:** `isAnomalousIp()` মূলত লগইন-ফ্লোর জন্য লেখা হয়েছিল, কিন্তু
এর সিগনেচার (`userId, ip`) কোনো লগইন-নির্দিষ্ট state ধরে না — তাই 10B এটা
**প্রতি request-এ** (`PolicyContext.ip`, বর্তমান রিকোয়েস্টের IP) কল করে,
শুধু লগইনের সময় না। এর ফলে একটা session যেটা normal IP থেকে লগইন করেছিল
কিন্তু এখন আচমকা অন্য IP থেকে ব্যবহার হচ্ছে (hijacked cookie/leaked token)
— সেটাও ধরা পড়ে, যা শুধু লগইন-টাইম চেক করলে মিস হয়ে যেত।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/policy/pip/risk-level-adapter.ts` (**নতুন**) | DB-free: `RiskSignal` (`anomalousIp`/`recentFailedLogins`), `RiskLevelProvider` ইন্টারফেস, pure `mapRiskSignalToLevel()` (দুটো signal → LOW/MEDIUM/HIGH), `withRiskLevel(subject, context, provider)`। |
| `lib/policy/pip/login-security-risk-provider.ts` (**নতুন**) | আসল `LoginSecurityRiskProvider` — `lib/login-security.ts`-এর `isAnomalousIp()` আর `login_history`-এর বিরুদ্ধে raw SQL (কারণ `login_history` একটা raw-SQL টেবিল, কোনো Drizzle schema নেই — `login-security.ts`-এর নিজস্ব হেডার অনুযায়ী)। `@workspace/db`/`login-security.ts` — দুটোই import করা একমাত্র ফাইল। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./pip/risk-level-adapter` যোগ হলো। `login-security-risk-provider.ts` ইচ্ছাকৃতভাবে বাদ (9B-এর একই precedent)। |
| `scripts/src/test-policy-risk-level.ts` (**নতুন**) | ১১টা DB-free টেস্ট — mapping-এর প্রতিটা কম্বিনেশন (boundary সহ), `withRiskLevel()`-এর non-mutation/overwrite, আর real `PolicyEngine` + RBAC rule-এর বিরুদ্ধে end-to-end composition। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **দুটো signal একসাথে থাকলেই HIGH, একটা একা থাকলে MEDIUM।** একটা নতুন
  IP মানেই attack না (কেউ নতুন ফোন/ওয়াইফাই থেকে লগইন করতে পারে) — তাই একা
  anomalous IP শুধু STEP_UP (MEDIUM) দাবি করে, outright block না। কিন্তু
  দুটো independent red flag (নতুন IP + সাম্প্রতিক ব্যর্থ লগইনের ঝাঁক)
  একসাথে থাকলে সেটা অনেক বেশি জোরালো প্রমাণ — তখনই HIGH (DENY)।
- **`recentFailedLogins` threshold = 3, ৩০ মিনিট lookback।** সাধারণ
  মানুষের ভুল টাইপ (২-৩ বার) থেকে উপরে, কিন্তু `vault-pin-guard.ts`-এর
  নিজস্ব ৫-অ্যাটেম্পট Vault-specific lockout-এর চেয়ে আগেই একটা sustained
  guessing attempt ধরে ফেলে — দুটো lockout mechanism স্বাধীনভাবে কাজ করে,
  একটা অন্যটার replacement না।
- **`ip` না থাকলে anomalous-IP অংশ fail-closed হয় "not anomalous"-এ,
  থ্রো করে না।** Failed-login-burst অংশ তবুও চলে (এটা `ip`-এর উপর নির্ভর
  করে না) — তাই IP অনুপস্থিত থাকলেও পুরো signal শূন্য হয়ে যায় না।
- **প্রতি-লগইন না, প্রতি-request চেক — deliberate নতুন ক্যাপাবিলিটি,**
  উপরে বিস্তারিত।
- **"Client নিজের risk level বেছে নিতে পারবে না" — 10A-এর একই guarantee,
  এখানেও construction দিয়ে ধরে রাখা।** `withRiskLevel()` শুধু
  `context.ip` (transport layer থেকে server-resolved) আর provider-এর DB
  read পড়ে — কোনো caller-supplied risk-level parameter নেই।
- **`login_history` raw SQL-এ কেন, নতুন Drizzle schema বানানো হয়নি কেন।**
  `lib/login-security.ts`-এর নিজস্ব হেডার অনুযায়ী এই টেবিলটা ইচ্ছাকৃতভাবে
  raw-SQL convention মানে — 10B সেই সিদ্ধান্তকে সম্মান করেছে, একটা প্যারালাল
  Drizzle schema বানিয়ে দুই জায়গায় একই টেবিলের দুই ভিন্ন representation
  তৈরি করেনি।

## যা ইচ্ছাকৃতভাবে 10B-তে নেই

- **কোনো route/middleware `withRiskLevel()` বা `LoginSecurityRiskProvider`
  কল করে না** — Phase 19 (PEP) পর্যন্ত real wiring বাকি।
- **কোনো নতুন schema/migration নেই** — শুধু বিদ্যমান `login_history` পড়া
  হয়েছে, কোনো কলাম/টেবিল যোগ হয়নি।
- **Device-fingerprint/geo-velocity-এর মতো আরও richer risk signal নেই** —
  roadmap নিজেই বলে "reuse existing" signal; একটা নতুন telemetry পাইপলাইন
  বানানো Phase 10-এর scope-এর বাইরে (Rule 16)।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-risk-level.ts`** — **১১/১১ পাস**।
- **রিগ্রেশন — Phase 1A থেকে 10A পর্যন্ত সবকয়টা suite আবার রান করা হয়েছে**
  (১৫টা suite) — **সবগুলো পাস, কোনো রিগ্রেশন নেই।**
- **Dynamic-code-execution audit:** নতুন দুটো ফাইলে কোনো `eval`/
  `new Function`/`vm.Script` নেই।
- **SQL injection audit:** raw SQL query-তে user input শুধু parameterized
  (`$1`, `$2`) — কোনো string interpolation দিয়ে ভ্যালু বসানো হয়নি (lookback
  minutes-ও প্যারামিটারাইজড, যদিও এটা একটা fixed constant, ইনজেকশনের
  ঝুঁকি নেই)।
- **`LoginSecurityRiskProvider` real DB-এর বিরুদ্ধে রান করা হয়নি** (network
  নেই এই sandbox-এ) — Phase 02-09B-এর প্রতিটা DB-backed provider-এর একই
  known limitation।

## Security tests কভার করা হয়েছে

- **Threshold boundary:** ঠিক থ্রেশহোল্ডে আর এক নিচে — দুটো আলাদা টেস্ট।
- **Two-signal escalation:** দুটো signal একসাথে HIGH দেয়, কিন্তু একটা একা
  শুধু MEDIUM — সরাসরি pin করা।
- **No merge-based bypass:** stale pre-set `riskLevel` provider-এর real
  সিগন্যালকে override করতে পারে না।
- **End-to-end:** clean signal-এ RBAC allow যায়; HIGH signal-এ সেই একই
  allow DENY-তে থামে।

## Regression status
কোনো রিগ্রেশন নেই।

## Migration status
সম্পূর্ণ additive, dormant। কোনো route/middleware/schema পরিবর্তন হয়নি।

## Next phase
Phase 10-এর audit gate (roadmap: "Phase 10: Identity + Risk Audit") →
Phase 11 (Temporary/Expiring Access)।
