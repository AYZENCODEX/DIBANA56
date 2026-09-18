# AYZEN Policy & Authorization Mega Engine — Phase 08: Policy Precedence

## এই পাসে যা করা হলো

আগের সেশনে তৈরি হওয়া Phase 08-এর ৫টা ফাইল (`lib/policy/precedence-tiers.ts`,
`lib/policy/precedence-engine.ts`, রিফ্যাক্টর করা `lib/policy/policy-engine.ts`,
আপডেট করা `lib/policy/index.ts` barrel, আর
`scripts/src/test-policy-precedence.ts`) মূল কোডবেসে ওয়্যার করা হলো এবং
পুরো টেস্ট স্যুট রান করে যাচাই করা হলো — যা এই সেশনে প্রথমবার সত্যিই
রান করে দেখা হলো (আগের সেশনে ফাইলগুলো তৈরি হয়েছিল কিন্তু কোডবেসে বসিয়ে
রান করা হয়নি)।

| ফাইল | কী করে |
|---|---|
| `lib/policy/precedence-tiers.ts` (**নতুন**) | `PRECEDENCE_ORDER` — roadmap-এর ৭টা rule-tier (tier ৮ "default deny" হলো Phase 01-এর নিজস্ব `NO_MATCHING_POLICY` fallback, তাই এখানে তালিকাভুক্ত না)। `PRECEDENCE_RANK`, `PRECEDENCE_TIER_LABELS`, `assertValidPrecedenceTier()`। |
| `lib/policy/precedence-engine.ts` (**নতুন**) | `PrecedenceEngine` — Phase 01-এর `PolicyEngine`-এর থেকে আলাদা, additive ক্লাস। Tier-অনুসারে strict priority walk করে; একটা tier-এ কোনো rule-এর মত থাকলে সেটাই decisive (নিচের tier আর দেখা হয় না), একই tier-এর ভিতরে deny-overrides দিয়ে tiebreak হয়। `onTierEvaluated` diagnostic hook। |
| `lib/policy/policy-engine.ts` (**পরিবর্তিত**) | বিহেভিয়ার অপরিবর্তিত — শুধু `evaluateCore()`-এর প্রথম অংশ (request build + invalid-context/unauthenticated হ্যান্ডলিং) `resolveRequestOrEarlyDecision()` নামে বের করে আনা হয়েছে, যাতে `PrecedenceEngine` একই preamble পুনর্ব্যবহার করতে পারে (byte-for-byte একই আচরণ দুই ইঞ্জিনেই)। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./precedence-tiers` আর `./precedence-engine` যোগ হলো barrel-এ। |
| `scripts/src/test-policy-precedence.ts` (**নতুন, বাগ-ফিক্সড**) | ২৮টা টেস্ট — conflict matrix (৭টা tier-এর প্রতিটা adjacent জোড়া, উভয় দিক থেকে) + composition (আসল Phase 02-06 rule-গুলো documented tier-এ রেজিস্টার করে end-to-end যাচাই)। |

## বাগ পাওয়া গেল এবং ঠিক করা হলো

প্রথমবার রান করে ১টা টেস্ট FAIL করেছিল:

`composition: EXPLICIT_GRANT (explicit deny row) beats ROLE_GRANT (RBAC allow) using the real rules`
→ `POLICY_EVALUATION_ERROR` (আশা করা হয়েছিল `RESOURCE_GRANT_DENIED`)।

**কারণ:** টেস্টের `FakeResourceGrantProvider` ক্লাসে মেথডের নাম ভুল ছিল —
`getGrant(...)` লেখা হয়েছিল, কিন্তু `resource/types.ts`-এর আসল
`ResourceGrantProvider` ইন্টারফেস আর `explicit-grant-rule.ts`
(`provider.getResourceGrant(...)`) — দুটোই `getResourceGrant` নাম আশা করে।
যেহেতু এই sandbox-এ টাইপ-চেক ছাড়াই সরাসরি `tsx` দিয়ে রান হয় (network/
node_modules না থাকায় `tsc --build` চালানো যায়নি — Phase 02-07-এর একই
known limitation), এই নাম-অমিলটা কম্পাইল-টাইমে ধরা পড়েনি — রানটাইমে
`provider.getResourceGrant is not a function` থ্রো হয়ে rule fail-closed
আচরণ অনুযায়ী `POLICY_EVALUATION_ERROR`-এ রেজলভ হয়েছিল (এই অংশটা ইঞ্জিনের
বাগ না — এটা ঠিক সেই fail-closed contract-ই কাজ করেছে যেটা এই ফাইলের
"composition: RESOURCE_DENY beats EXPLICIT_GRANT" টেস্টে ইচ্ছাকৃতভাবে
এক্সারসাইজ করা হয় — শুধু এইখানে ইচ্ছাকৃত ছিল না)।

**ফিক্স:** `scripts/src/test-policy-precedence.ts`-এর
`FakeResourceGrantProvider.getGrant` → `getResourceGrant` রিনেম করা হলো
(এক লাইনের পরিবর্তন, `key()`/`set()` হেল্পার মেথড অপরিবর্তিত)। কোনো
lib/policy/* ফাইল বদলাতে হয়নি — বাগটা শুধু টেস্ট ফিক্সচারে ছিল, ইঞ্জিনে না।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-precedence.ts`** — ফিক্সের পর
  **২৮/২৮ পাস** (conflict matrix + composition, দুই অংশই)।
- **রিগ্রেশন — Phase 1A থেকে Phase 07 পর্যন্ত সবকয়টা suite আবার রান করা
  হয়েছে** (`test-policy-engine`, `test-policy-pip`,
  `test-policy-decision-observer`, `test-policy-rbac`,
  `test-policy-resource`, `test-policy-resource-grants`,
  `test-policy-resource-org-access`, `test-policy-rebac`,
  `test-policy-abac`, `test-policy-dsl`, `test-policy-registry`) —
  **সবগুলো পাস, কোনো রিগ্রেশন নেই।** `resolveRequestOrEarlyDecision()`
  এক্সট্র্যাকশন `PolicyEngine`-এর কোনো আচরণ বদলায়নি, যা এই ১১টা suite-ই
  নিশ্চিত করে।
- **Dynamic-code-execution audit:** `grep -rn "eval(\|new Function(\|require(" lib/policy/`
  — কোনো actual call নেই (শুধু header comment-এ উল্লেখ আছে যে এগুলো ব্যবহার
  করা হয়নি)।
- **`tsc --build` / `check-all.ts --syntax-only` এই sandbox-এ রান করা যায়নি**
  (`typescript` প্যাকেজ/`node_modules` নেই, network বন্ধ) — Phase 02-07-এর
  একই known limitation, নতুন কিছু না।

## Known limitations (অপরিবর্তিত Phase 07 থেকে)

- কোনো route/middleware `PrecedenceEngine` বা `PolicyEngine` কল করে না —
  Phase 19 (PEP) পর্যন্ত ওয়্যারিং ইচ্ছাকৃতভাবে বাকি।
- Tier 1 (EMERGENCY_SECURITY_DENY), Tier 2 (GLOBAL_DENY), Tier 5
  (RISK_RESTRICTION) reserved-ই থাকল — কোনো real rule নেই এখনো (Phase 10
  risk engine, future kill-switch)।

## Regression status
কোনো রিগ্রেশন নেই। Phase 08 সম্পূর্ণ, পরবর্তী কাজের জন্য প্রস্তুত।

## Next phase
Phase 09 — Authentication Assurance (sub-phase 9A দেখুন
`CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE9A.md`-এ)।
