# AYZEN Policy & Authorization Mega Engine — Phase 05: ABAC

## এই পাসে যা তৈরি হলো

Roadmap-এর Phase 05 লাইন-বাই-লাইন কভার করা হয়েছে: subject attributes
(user/role/organization/account state/verification level/risk level),
resource attributes (owner/organization/classification/state/sensitivity),
environment attributes (time/IP/device trust/session age/authentication
freshness), আর roadmap-এ নাম-করা প্রতিটা operator (equals/notEquals/
greaterThan/lessThan/AND/OR/NOT/IN/EXISTS/time comparisons) — কিন্তু Phase 06
(Policy DSL, স্ট্রিং গ্রামার/parser)-এর বা Phase 07 (Policy Registry/PAP,
persisted/versioned policies)-এর কোনো কিছুই না (Rule 16)।

| ফাইল | কী করে |
|---|---|
| `lib/policy/types.ts` (**পরিবর্তিত**) | `Subject`-এ তিনটা নতুন optional field: `accountState`, `verificationLevel`, `riskLevel` (শেষটা ইচ্ছাকৃতভাবে ফাঁকা রাখা হয়েছে Phase 10-এর Risk Engine populate করার জন্য)। `ResourceRef`-এ `sensitivity`। `PolicyContext`-এ `deviceTrust`, `sessionAgeSeconds`, `authenticationFreshnessSeconds`। সবগুলোই Phase 1A-এর `organizationId`/`assuranceMethods`-এর ঠিক একই posture-এ — additive, optional, কিছুই এখনো populate করে না। |
| `lib/policy/policy-context.ts` (**পরিবর্তিত**) | `CreatePolicyContextInput`/`createPolicyContext()`-এ উপরের তিনটা নতুন environment field যোগ হলো, নাহলে সেগুলো `PolicyContext`-এ কখনো পৌঁছাতোই না (এই বাগটা টেস্ট রান করেই ধরা পড়েছে — নিচে "যাচাই" সেকশন দেখুন)। |
| `lib/policy/decision-reasons.ts` (**পরিবর্তিত**) | নতুন reason code `ATTRIBUTE_POLICY_DENIED` — `RESOURCE_GRANT_DENIED`-এর সমান্তরাল, যাতে audit log-এ ABAC-এর deny আলাদা করে চেনা যায়। |
| `lib/policy/abac/types.ts` (**নতুন**) | `AttributeValue`, `AttributeBag` (subject/resource/environment + action-এর flat, read-only view), `AttributeOperator` (roadmap-এর পুরো তালিকা + `before`/`after` time-comparison alias), `AbacCondition` (comparison/and/or/not — বাউন্ডেড, non-executable tree, কখনো `eval()` না), `AbacPolicyDefinition`। |
| `lib/policy/abac/attribute-resolver.ts` (**নতুন**) | `resolveAttributes()` — `Subject`/`ResourceRef`/`PolicyContext` থেকে `AttributeBag` বানায়, কোনো DB/IO ছাড়াই (PIP adapter-দের মতোই শুধু reshape করে)। `getAttribute()` — dot-path lookup (`"subject.role"`, `"resource.sensitivity"`, `"environment.deviceTrust"`, বা bare `"action"`), অচেনা/malformed path-এ কখনো throw করে না, `undefined` রিটার্ন করে। |
| `lib/policy/abac/operators.ts` (**নতুন**) | প্রতিটা operator-এর pure ইমপ্লিমেন্টেশন — fail-closed (incomparable value/missing attribute/malformed `in` right-hand-side সবকিছুতেই `false`, কখনো throw না)। `resource.id`-এর জন্য number↔numeric-string equivalence (নিচে দেখুন)। |
| `lib/policy/abac/condition-evaluator.ts` (**নতুন**) | `evaluateAbacCondition()` — recursive AND/OR/NOT walk, empty-AND (vacuously true) আর empty-OR (vacuously false)-এর জন্য ডকুমেন্টেড, টেস্ট করা boundary semantics-সহ। |
| `lib/policy/abac/abac-rule.ts` (**নতুন**) | `createAbacRule()` — engine-এর ষষ্ঠ real `PolicyRule`। `explicit-grant-rule.ts`-এর মতোই two-sided (allow-ও-deny-ও রিটার্ন করতে পারে), আর একই deny-overrides combining নিজের policy-list-এর ভিতরেও প্রয়োগ করে (একটা matching deny সবসময় জেতে, list-এ তার position যা-ই হোক)। Action matching RBAC-এর নিজস্ব `permissionMatches()` গ্রামার পুনরায় ব্যবহার করে — নতুন কোনো matching concept আবিষ্কার করেনি। |
| `lib/policy/abac/index.ts` (**নতুন**) | Barrel — এই phase-এ কোনো Drizzle provider বাদ দেওয়ার নেই (নতুন কোনো DB টেবিল লাগেনি একদম, নিচে দেখুন)। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./abac` যোগ হলো টপ-লেভেল ব্যারেলে। |
| `scripts/src/test-policy-abac.ts` (**নতুন**) | ২৮টা DB-free টেস্ট। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **কোনো নতুন DB টেবিল/provider লাগেনি।** roadmap-এর Phase 05-এ যে
  attribute-গুলোর কথা বলা আছে (subject/resource/environment), তার প্রতিটার
  জন্য ইতিমধ্যেই একটা caller-supplied field আছে `Subject`/`ResourceRef`/
  `PolicyContext`-এ (Phase 1A-এর মূল ফিল্ডগুলো + এই পাসে যোগ হওয়া নতুন
  optional ফিল্ডগুলো) — তাই 3A/3C-এর মতোই এই ফেজ শূন্য নতুন schema, শূন্য নতুন
  provider interface দিয়ে implement করা গেছে। কিছুই এখনো এই নতুন ফিল্ডগুলো
  বাস্তবে populate করে না (riskLevel ইচ্ছাকৃতভাবে Phase 10-এর জন্য ফাঁকা)।
- **`AbacCondition` কেন Phase 06-এর DSL-কে প্রি-এম্পট করে না।** condition
  tree-টা প্লেইন, TypeScript-validated অবজেক্ট literal হিসেবে বানানো হয় —
  কোনো string গ্রামার নেই, কোনো parser নেই। Phase 06-এর কাজ হবে একটা টেক্সট
  DSL parse করে এই একই shape-টা বানানো; Phase 05 শুধু সেই shape-টা consume
  করার evaluator বানিয়েছে। এইভাবে roadmap-এর "never use eval()" রিকোয়ারমেন্ট
  by construction satisfied — কোনো convention-এর ওপর নির্ভর করে না।
- **`createAbacRule()` কেন two-sided (explicit-grant-rule.ts-এর মতো)।**
  ownership/organization-access/rebac-rule সবগুলোই one-sided (শুধু ALLOW বা
  abstain) কারণ তারা শুধু একটা নতুন grant path যোগ করে। কিন্তু একটা attribute
  condition যেমন "resource.sensitivity == high AND NOT
  subject.verificationLevel == identity_verified" একটা ইচ্ছাকৃত restriction,
  শুধু "কোনো grant পাওয়া গেল না" নয় — তাই এইটা explicit DENY রিটার্ন করতে
  পারা দরকার, আর সেই DENY-কে policy-list-এর ভিতরেই deny-overrides মেনে
  জিততে হবে (list-এ ordering-independent), ঠিক যেভাবে engine-টা নিজে top
  level-এ করে।
- **`resource.id`-এর জন্য number↔numeric-string equivalence — টেস্ট রান করেই
  আবিষ্কার হওয়া একটা real design gap।** `ResourceRef.id` টাইপ `string |
  number` (রুট params স্ট্রিং, DB primary key প্রায়ই number) — অন্য সব
  resource-identity-consuming রুল (`explicit-grant-rule.ts`, `rebac-rule.ts`)
  আগে থেকেই `String(resourceId)` দিয়ে এইটা normalize করে। `valuesEqual()`-এ
  এই একই normalization যোগ করা না হলে `{ attribute: "resource.id", operator:
  "equals", value: "42" }`-এর মতো একটা পুরোপুরি স্বাভাবিক condition
  resource.id সংখ্যা হিসেবে থাকলে silently fail করতো। ফিক্সটা ইচ্ছাকৃতভাবে
  narrow (`isPlainNumericString()` — কোনো whitespace/exponent/leading-zero
  কনফিউশন গ্রহণ করে না) যাতে দুটো ভিন্ন-অর্থবহ স্ট্রিং কখনো ভুলবশত মিলে না
  যায়, আর exact-match-only নীতিটা এখনো বজায় থাকে ("0042" এখনো "42"-এর সাথে
  মেলে না — শুধু 42 (number) আর "42" (string) সমার্থক)।
- **`createPolicyContext()`-এ নতুন environment field না যোগ করলে সেগুলো
  কখনো কোনো `PolicyContext`-এ পৌঁছাতোই না — এটাও টেস্ট রান করেই ধরা পড়া
  দ্বিতীয় real বাগ।** `types.ts`-এ ফিল্ড থাকা আর সেগুলো আসলে বিল্ডিং পাথ দিয়ে
  পার হওয়া দুইটা আলাদা জিনিস — এই পাসে দুটোই ঠিক করা হয়েছে।
- **empty AND/OR-এর জন্য deliberate, টেস্ট-করা boundary semantics।** empty
  AND = vacuously true (conjunction-এর identity, `Array.prototype.every`-এর
  সাথে সামঞ্জস্যপূর্ণ); empty OR = vacuously false (দুইটার মধ্যে নিরাপদ
  default — একটা খালি OR কখনো ভুলবশত access দিতে পারে না)।
- **কোনো route/service এখনো এই রুল ব্যবহার করছে না** — grep করে কনফার্ম করা
  হয়েছে (RBAC/3A/3B/3C/04-এর মতোই additive, unwired surface area)।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- এই sandbox-এ network/`node_modules` নেই (আগের ফেজগুলোর CHANGES doc-এও এই
  একই সীমাবদ্ধতা নথিভুক্ত আছে), তাই পুরো মনোরিপো `tsc --build` করা যায়নি।
  তবে এই ফেজের পুরো `lib/policy/*` মডিউল (Drizzle/Express-নির্ভর তিনটা ফাইল
  বাদে — `rbac/drizzle-rbac-provider.ts`, `resource/drizzle-resource-grant-
  provider.ts`, `rebac/drizzle-relationship-provider.ts`, `pip/context-
  adapter.ts`) একটা আইসোলেটেড `tsc` স্যান্ডবক্সে কপি করে টাইপচেক করা
  হয়েছে — **নতুন/পরিবর্তিত কোনো ফাইলে শূন্য error** (শুধু pre-existing,
  পরিবেশগত `@types/node` অনুপস্থিতি-জনিত error দেখা গেছে, যেগুলো এই ফেজের
  কোনো কোডের সাথে সম্পর্কিত না)।
- একই আইসোলেটেড স্যান্ডবক্সে `tsc`-দিয়ে JS-এ কম্পাইল করে **আসলেই Node দিয়ে
  রান করে** যাচাই করা হয়েছে — শুধু টাইপচেক না।
- `npx tsx scripts/src/test-policy-abac.ts`-এর সমতুল্য রান — **২৮/২৮ পাস**
  (operators unit tests, attribute-resolver dot-path lookup, condition-
  evaluator AND/OR/NOT + boundary cases, abac-rule declarative GIVEN/WHEN/
  THEN, security suites)। এই রান দুইটা real বাগ ধরেছে (উপরে ডিজাইন সিদ্ধান্ত
  সেকশনে বর্ণিত) যেগুলো code-review-only দিয়ে ধরা পড়তো না — দুটোই ফিক্স করে
  আবার রান করে কনফার্ম করা হয়েছে।
- রিগ্রেশন: 1A/1B(PIP-বাদে)/1C(observer)/02(RBAC)/3A/3B/3C/04(ReBAC) — সব
  কয়টা suite (`test-policy-engine`, `test-policy-rbac`, `test-policy-
  resource`, `test-policy-resource-grants`, `test-policy-resource-org-
  access`, `test-policy-rebac`, `test-policy-decision-observer`) এই পাসের
  `types.ts`/`policy-context.ts` পরিবর্তনের পরে আবার রান করে কনফার্ম করা
  হয়েছে — **কোনো রিগ্রেশন নেই**।
- `pip/context-adapter.ts` (Express-নির্ভর, তাই আইসোলেটেড স্যান্ডবক্সে
  কম্পাইল করা যায়নি) এই ফেজে স্পর্শ করা হয়নি — এর টাইপ-নির্ভরতা অপরিবর্তিত।

## Security tests কভার করা হয়েছে

- **IDOR / resource-ID substitution:** একটা concrete resource id-তে scoped
  condition অন্য কোনো id-তে (সংখ্যা-রূপে ভিন্ন বা string-রূপে ভিন্ন) leak
  করে না; number↔numeric-string equivalence-টাও একই সাথে যাচাই করা হয়েছে
  (exact numeric মিল ALLOW, বাকি সব substitution DENY)।
- **Privilege escalation:** resource-এর অপ্রাসঙ্গিক field forge করলে
  (ownerId/organizationId/classification/sensitivity) কোনো নতুন match তৈরি
  হয় না; আর শুধু action string relabel করে (`sylo.vault.read` থেকে
  `update`/`delete`/`manage`-এ) একটা read-only-scoped allow policy leverage
  করা যায় না।
- **Cross-user:** একজন subject-এর জন্য লেখা attribute condition অন্য
  subject-এর কাছে extend হয় না।
- **Fail-closed on incomparable/missing values:** exists/notExists ছাড়া
  বাকি প্রতিটা operator missing attribute-এ `false` রিটার্ন করে (কখনো
  throw না); greaterThan/lessThan-family incomparable টাইপে (boolean,
  array, non-date string) `false`; `in`/`notIn` malformed (non-array)
  right-hand-side-এ `false` — সবগুলোই ডেডিকেটেড টেস্টে যাচাই করা।
- **Unauthenticated subject** কখনো এই রুল পর্যন্ত পৌঁছায় না।
- **Composition:** ABAC ALLOW কখনো locked-resource DENY বা resource-grant
  DENY-কে হারায় না (deny-overrides, registration-order-independent);
  ownership আর ABAC দুটোই abstain করলে default deny-তে পড়ে; ABAC একটা gap
  পূরণ করে যেটা শুধু ownership রেখে দিত।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি

- কোনো route/service এখনো এই রুল ব্যবহার করছে না — grep করে কনফার্ম করা
  হয়েছে।
- `Subject.riskLevel`/`accountState`/`verificationLevel`,
  `ResourceRef.sensitivity`, `PolicyContext.deviceTrust`/
  `sessionAgeSeconds`/`authenticationFreshnessSeconds` — কোনো real
  populate করার কোড এখনো নেই। বিশেষভাবে `riskLevel` ইচ্ছাকৃতভাবে Phase
  10 (Risk-Aware Authorization)-এর জন্য ফাঁকা রাখা হয়েছে — roadmap নিজেই
  বলে "Risk Engine = calculates risk; Policy Engine = decides what to do
  with risk"; Phase 05 শুধু vocabulary/field-টা যোগ করেছে।
- Declarative string DSL, parser — Phase 06।
- Persisted/versioned policy registry, priority/precedence system — Phase
  07/08।
- `tsc --build` পুরো মনোরিপোতে — sandbox-এ network/node_modules না থাকায়
  সম্ভব হয়নি (Phase 02/03/04-এর ঠিক একই known limitation)। এর বদলে একটা
  আইসোলেটেড `tsc` + রানটাইম যাচাই করা হয়েছে (উপরে "যাচাই" সেকশন দেখুন)।

## PHASE STATUS

- **Implemented:** ABAC — attribute value/condition-tree/operator টাইপ
  সিস্টেম, attribute resolver + dot-path lookup, fail-closed operator
  লাইব্রেরি, recursive AND/OR/NOT condition evaluator, engine-এ প্লাগযোগ্য
  two-sided `PolicyRule`।
- **Files changed:** `lib/policy/types.ts`, `lib/policy/policy-context.ts`,
  `lib/policy/decision-reasons.ts`, `lib/policy/index.ts`।
- **Files added:** `lib/policy/abac/types.ts`,
  `lib/policy/abac/attribute-resolver.ts`, `lib/policy/abac/operators.ts`,
  `lib/policy/abac/condition-evaluator.ts`, `lib/policy/abac/abac-rule.ts`,
  `lib/policy/abac/index.ts`, `scripts/src/test-policy-abac.ts`।
- **Database changes:** কোনোটাই না — নতুন কোনো টেবিল/মাইগ্রেশন লাগেনি এই
  ফেজে।
- **Tests:** ২৮/২৮ পাস (`scripts/src/test-policy-abac.ts`-এর সমতুল্য
  আইসোলেটেড রান)।
- **Security tests:** IDOR/resource-ID substitution (number↔string
  equivalence-সহ), privilege escalation (forged fields + action-
  relabeling), cross-user, fail-closed incomparable/missing-value
  handling, unauthenticated-subject, composition/deny-overrides — সবগুলো
  কভার।
- **Known limitations:** নতুন attribute ফিল্ডগুলোর কোনোটাই এখনো বাস্তবে
  populate হয় না (কিছু PIP/risk-engine ভবিষ্যৎ ফেজের কাজ)। sandbox-এ পুরো
  মনোরিপো `tsc --build` চালানো যায়নি (network/node_modules নেই — বিদ্যমান
  সীমাবদ্ধতা, একটা isolated tsc + রানটাইম টেস্ট দিয়ে compensate করা
  হয়েছে)। `pip/context-adapter.ts` এই ফেজে স্পর্শ/যাচাই করা হয়নি (Express
  নির্ভরতার কারণে আইসোলেটেড sandbox-এ কম্পাইল অসম্ভব — আগের ফেজগুলোতেও একই
  ব্যতিক্রম)।
- **Regression status:** 1A/1B(PIP-বাদে)/1C/02/3A/3B/3C/04 — রিগ্রেশন নেই।
- **Next phase:** Phase 05 সম্পূর্ণ। **roadmap-এর "AUDIT GATES" তালিকা
  অনুযায়ী Phase 05-এর পরে একটা বাধ্যতামূলক Architecture + Security Audit
  ধার্য আছে** — Rule 15 অনুযায়ী এই রিপোর্ট রিভিউ হওয়া উচিত, আর roadmap
  স্পষ্টভাবে বলে "Do not continue if a critical security regression is
  discovered"। অর্থাৎ Phase 06 (Policy DSL) শুরু করার আগে এই আনুষ্ঠানিক
  audit gate সম্পন্ন হওয়া দরকার — এটা এই পাসের অংশ হিসেবে নিজে থেকে করা হয়নি
  (Rule 16-এর অধীনে একটা পৃথক, explicit ধাপ হিসেবে রাখা হয়েছে)।

**এই পাস এখানেই থামছে (Rule 16) — Phase 06 (Policy DSL) স্বয়ংক্রিয়ভাবে শুরু
হচ্ছে না, এবং Phase 05-এর audit gate মিস করা হয়নি বরং স্পষ্টভাবে ফ্ল্যাগ করা
হলো।**
