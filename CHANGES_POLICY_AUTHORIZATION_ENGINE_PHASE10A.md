# AYZEN Policy & Authorization Mega Engine — Phase 10, sub-phase 10A: Risk-Aware Authorization ("decides what to do with risk" half)

## স্কোপ

Roadmap Phase 10 নিজেই দুটো ভিন্ন কাজে ভাগ করে দেয়: "Risk Engine =
calculates risk; Policy Engine = decides what to do with risk"। ঠিক
Phase 09-এর মতো (9A = vocabulary+gate, 9B = real data wiring), 10A এখানে
শুধু **decides** অংশটা কভার করে — `Subject.riskLevel` (Phase 05-এই
ডিফাইন করা, "Deliberately left for the Risk Engine (Phase 10) to
populate", আজও কোথাও populate হয়নি) থেকে একটা decision বের করার rule।
**calculates** অংশ — IP anomaly/velocity/device-signal থেকে আসল
`riskLevel` বসানো — ইচ্ছাকৃতভাবে 10A-তে নেই, পরের সাব-ফেজের কাজ (roadmap
Rule 16)।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/policy/decision-reasons.ts` (**পরিবর্তিত**) | `HIGH_RISK_DENIED` নতুন reason code যোগ হলো — HIGH risk-এর কারণে deny হওয়া, বাকি সব `*_DENIED` কোডের থেকে distinct রাখার জন্য। |
| `lib/policy/risk/risk-rule.ts` (**নতুন**) | `createRiskRule()` — এই ইঞ্জিনের ৮ম আসল `PolicyRule`। `riskLevel` অনুযায়ী LOW/unset→abstain, MEDIUM→STEP_UP, HIGH→DENY। `assurance-rule.ts`-এর মতোই কখনো ALLOW করে না। |
| `lib/policy/risk/index.ts` (**নতুন**) | Barrel — কোনো DB provider বাদ দেওয়ার দরকার নেই (10A কোনো DB পড়ে না)। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./risk` যোগ হলো টপ-লেভেল barrel-এ। |
| `scripts/src/test-policy-risk.ts` (**নতুন**) | ১২টা DB-free টেস্ট — প্রতিটা `riskLevel` branch, "কখনো ALLOW না" গ্যারান্টি, real RBAC allow-এর বিরুদ্ধে composition (LOW/MEDIUM/HIGH তিনটাই), আর client-supplied risk-level স্পুফিং প্রতিরোধ। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **HIGH risk `DENY` করে, শুধু `STEP_UP` না — এটাই assurance rule-এর থেকে
  একমাত্র পার্থক্য।** `assurance-rule.ts` কখনো ALLOW/DENY কিছুই করে না,
  শুধু STEP_UP/abstain। কিন্তু roadmap নিজেই স্পষ্ট করে বলে "HIGH → DENY" —
  এই asymmetry ইচ্ছাকৃত: একটা risky signal (known-bad IP, impossible-
  travel pattern) স্ট্রংগার authentication দিয়ে "ঠিক" হয়ে যায় না, কারণ
  সমস্যাটা credential-এর strength নিয়ে না, request-এর context নিয়ে।
- **`riskLevel` unset বা `"low"` — দুটোই সমান আচরণ (abstain), HIGH ধরে
  নেওয়া হয় না।** কোনো risk-engine এখনো রান করেনি মানে "কোনো risk objection
  নেই এখনো" — একটা missing signal-কে fail-closed করে সবচেয়ে কড়া outcome
  (deny) দেওয়া roadmap কোথাও চায়নি; এই ইঞ্জিনের বাকি সব abstain-capable
  rule (RBAC/ownership/ReBAC/ABAC/assurance) একই নিয়ম মানে — absent input
  মানে "no opinion", "deny" না।
- **"Client নিজের risk level বেছে নিতে পারবে না" — এটা একটা runtime চেক
  দিয়ে না, construction দিয়ে guaranteed।** `createRiskRule()` শুধুই
  `request.subject.riskLevel` পড়ে — server-side তৈরি `Subject`-এর একটা
  ফিল্ড। `request.context.extra`-এর মতো কোনো caller-controllable জায়গা
  থেকে risk level পড়ার কোনো কোড পাথই নেই — একটা টেস্ট (`client cannot
  smuggle a risk level via context.extra`) সরাসরি এটা pin করে: `context.
  extra`-তে `"low"` claim করা সত্ত্বেও `subject.riskLevel = "high"`
  থাকলে DENY-ই হয়।
- **`createRiskRule()` কখনো per-action override নেয় না — একটা flat,
  global mapping, roadmap-এর literal ৩-লাইন বর্ণনার সাথে হুবহু মিল।**
  Assurance rule-এর মতো per-action `actions` pattern list এখানে
  ইচ্ছাকৃতভাবে যোগ করা হয়নি — roadmap কোথাও action-নির্ভর risk-tolerance
  চায় না, আর এখন যোগ করলে সেটা scope creep হতো (Rule 16)। প্রয়োজন হলে
  ভবিষ্যতে একটা সাব-ফেজ হিসেবে যোগ করা যাবে।
- **`HIGH_RISK_DENIED` একটা distinct reason code, `EXPLICIT_DENY` পুনর্ব্যবহার
  না।** ঠিক `RESOURCE_LOCKED`/`RESOURCE_GRANT_DENIED`/`ATTRIBUTE_POLICY_DENIED`-এর
  একই যুক্তি — audit log-এ "risk-ই ব্লক করেছে" বনাম অন্য কোনো rule-এর deny,
  `policyId` না দেখেই আলাদা করা যায়।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-risk.ts`** — **১২/১২ পাস**।
- **রিগ্রেশন — Phase 1A থেকে 9B পর্যন্ত সবকয়টা suite আবার রান করা হয়েছে**
  (১৪টা suite) — **সবগুলো পাস, কোনো রিগ্রেশন নেই।** `decision-reasons.ts`-এ
  নতুন একটা union member + description যোগ হয়েছে (existing কোনো entry
  বদলায়নি), `lib/policy/index.ts`-এ একটা নতুন `export *`।
- **Dynamic-code-execution audit:** `lib/policy/risk/`-এ কোনো
  `eval`/`new Function`/`vm.Script` নেই।

## Security tests কভার করা হয়েছে

- **Client cannot influence its own risk level:** `context.extra`-এর
  মাধ্যমে risk স্পুফ করার সরাসরি প্রচেষ্টা — ব্যর্থ হয়, server-side
  `subject.riskLevel`-ই একমাত্র উৎস।
- **HIGH risk DENY একটা আসল RBAC allow-কে short-circuit করে** — role
  permission থাকা সত্ত্বেও DENY-ই জেতে।
- **MEDIUM risk STEP_UP করে, ALLOW না** — একই RBAC allow-এর বিরুদ্ধে,
  DENY-এর চেয়ে হালকা কিন্তু তবুও ALLOW-কে থামায়।
- **Never manufactures an ALLOW:** LOW risk-এ, কোনো অন্য grant-path rule
  register না থাকলে ফলাফল `NO_MATCHING_POLICY`, `ALLOW` না।

## Regression status
কোনো রিগ্রেশন নেই।

## Migration status
সম্পূর্ণ additive, dormant। কোনো route/middleware wire করা হয়নি।
`Subject.riskLevel` এখনো কোথাও populate হয় না (Phase 10-এর "calculates"
অংশ, পরের সাব-ফেজ)।

## Next phase
Phase 10B (প্রস্তাবিত) — আসল risk calculation: `login-security.ts`-এর
বিদ্যমান `isAnomalousIp()`/login-history সিগন্যাল থেকে
`Subject.riskLevel` populate করার একটা PIP adapter (ঠিক 9B যেভাবে
`verificationLevel` populate করেছিল real KYC/email ডেটা দিয়ে) — audit
gate পার হওয়ার পর Phase 11 (Temporary/Expiring Access)।
