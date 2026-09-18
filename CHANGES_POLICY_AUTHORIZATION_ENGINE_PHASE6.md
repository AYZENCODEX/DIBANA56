# AYZEN Policy & Authorization Mega Engine — Phase 06: Policy DSL

## Phase 05 audit gate — closed before this phase began

Roadmap-এর "AUDIT GATES" তালিকা অনুযায়ী Phase 05-এর পরে একটা Architecture +
Security Audit বাধ্যতামূলক ছিল। এই পাস শুরুর আগে সেটা করা হয়েছে:
- `grep -rn "eval(\|new Function(\|require(" lib/policy/` চালিয়ে কনফার্ম করা
  হয়েছে যে পুরো policy engine-এ (Phase 1-5 পর্যন্ত) কোথাও dynamic code
  execution নেই — শুধু comment-এ উল্লেখ আছে (কেন নেই সেটা ব্যাখ্যা করতে)।
- Phase 05-এর CHANGES doc-এ নথিভুক্ত সব security test (IDOR, privilege
  escalation, cross-user, fail-closed, composition/deny-overrides) আবার
  রান করে কনফার্ম করা হয়েছে (নিচে "যাচাই" সেকশনে বিস্তারিত)।
- কোনো critical security regression পাওয়া যায়নি — তাই roadmap-এর "Do not
  continue if a critical security regression is discovered" শর্ত অনুযায়ী
  Phase 06 শুরু করা নিরাপদ।

## এই পাসে যা তৈরি হলো

Roadmap-এর Phase 06 লাইন-বাই-লাইন কভার করা হয়েছে: declarative policy DSL
(`subject.organization == resource.organization AND subject.assurance >=
L3`-এর ধরনের text), যেটা typed/validated/deterministic/bounded/
non-executable, আর কখনো `eval()` বা সমতুল্য ব্যবহার করে না — কিন্তু Phase 07
(Policy Registry/PAP, persisted/versioned policy storage + admin UI)-এর
কোনো কিছুই না (Rule 16)।

| ফাইল | কী করে |
|---|---|
| `lib/policy/abac/types.ts` (**পরিবর্তিত**) | `AttributeComparison`-এ নতুন optional `valueAttribute` ফিল্ড — comparison-এর ডান পাশ এখন আরেকটা dynamic attribute path হতে পারে (আগে শুধু fixed literal `value` সাপোর্ট করতো)। এটা লাগলো কারণ roadmap-এর নিজস্ব Phase 06 example-টাই attribute-vs-attribute তুলনা (`subject.organization == resource.organization`), যেটা Phase 05 সাপোর্ট করতো না। Additive, backward-compatible — Phase 05-এ বানানো কোনো condition-এর অর্থ পাল্টায়নি। |
| `lib/policy/abac/condition-evaluator.ts` (**পরিবর্তিত**) | `valueAttribute` সেট থাকলে সেটা `getAttribute()` দিয়ে resolve করে, নাহলে আগের মতোই `value` ব্যবহার করে। |
| `lib/policy/abac/dsl/errors.ts` (**নতুন**) | `DslError` — টাইপড, position-সহ (caret দেখানোর জন্য), ১৫টা নির্দিষ্ট error code-এর closed union। **Authoring-time** error — `policy-engine.ts`-এর POLICY_EVALUATION_ERROR path দিয়ে কখনো যায় না (parsing হয় policy লেখার সময়, প্রতিটা request-এ না)। |
| `lib/policy/abac/dsl/tokenizer.ts` (**নতুন**) | Hand-written lexer। তিনটা স্বাধীন bound: `MAX_INPUT_LENGTH` (৪০৯৬ char), `MAX_STRING_LITERAL_LENGTH` (৫১২ char), `MAX_TOKENS` (৫১২টা)। Keyword-vs-dotted-path disambiguation strict case-sensitive (AND/OR/NOT/IN/EXISTS uppercase-ই লাগবে, true/false/null lowercase-ই লাগবে) — deliberate strictness, ambiguity-মুক্ত গ্রামারের জন্য। |
| `lib/policy/abac/dsl/parser.ts` (**নতুন**) | Recursive-descent parser — `parseAbacDsl()`। EBNF গ্রামার ফাইলের হেডারে ডকুমেন্টেড। `MAX_NESTING_DEPTH` (৩২) দিয়ে paren/NOT nesting bound করা — token count bound-এর বাইরেও `((((...))))`-স্টাইল deep nesting থেকে stack overflow ঠেকায়। Output সরাসরি Phase 05-এর `AbacCondition` — কোনো নতুন AST layer নেই। |
| `lib/policy/abac/dsl/compile-policy.ts` (**নতুন**) | `compileAbacPolicy()`/`compileAbacPolicies()` — `AbacPolicyDefinitionSource` (DSL text-সহ) থেকে `AbacPolicyDefinition` (parsed condition-সহ) বানায়, একবার, authoring time-এ। Batch compile fail-fast (একটা invalid থাকলে পুরোটাই ব্যর্থ, partial compile না)। |
| `lib/policy/abac/dsl/index.ts` (**নতুন**) | Barrel। |
| `lib/policy/abac/index.ts` (**পরিবর্তিত**) | `./dsl` যোগ হলো। |
| `scripts/src/test-policy-dsl.ts` (**নতুন**) | ৩৬টা DB-free টেস্ট। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **কেন `AttributeComparison`-এ `valueAttribute` যোগ করতে হলো (Phase 05-এর
  টাইপ পরিবর্তন)।** roadmap-এর নিজস্ব conceptual example-টাই attribute-to-
  attribute তুলনা চায় — `subject.organization == resource.organization`।
  Phase 05-এর `AttributeComparison.value` শুধু একটা fixed literal ধরে
  রাখতে পারতো, তাই এই উদাহরণটাই কম্পাইল করা যেত না literal-only ডিজাইনে।
  Fix-টা ইচ্ছাকৃতভাবে narrow ও additive: নতুন optional ফিল্ড, পুরনো কোনো
  condition-এর semantics বদলায়নি (`test-policy-abac.ts`-এর ২৯টা টেস্ট আগের
  মতোই পাস করে — নিচে "যাচাই" দেখুন)।
- **`eval()`/`Function()`/`vm` কোথাও নেই — convention না, construction-এর
  ফলাফল।** পুরো DSL একটা hand-written character-by-character tokenizer +
  recursive-descent parser, যেটা input text-কে শুধু classify করে আর একটা
  data structure (`AbacCondition`) বানায় — কখনো কোনো substring-কে code
  হিসেবে execute করে না। `test-policy-dsl.ts`-এ এইটা সরাসরি টেস্ট করা
  হয়েছে: classic "if this were eval'd" payload (`require("child_process")`,
  template-literal injection, `__proto__`/`constructor` chain) — সবগুলো
  শুধু syntax error হিসেবে reject হয়, কখনো execute হয় না।
- **Parsing authoring-time, evaluation request-time — আলাদা রাখা হয়েছে
  ইচ্ছাকৃতভাবে।** `parseAbacDsl()`/`compileAbacPolicy()` কল হওয়ার কথা একবার,
  যখন policy লেখা/লোড হয় — প্রতিটা authorization request-এ না। এটা
  roadmap-এর নিজস্ব PERFORMANCE RULES ("unbounded policy evaluation",
  "dynamic code execution" এড়ানো) মেনে চলে — `evaluateAbacCondition()`
  Phase 05-এর মতোই সস্তা আর dynamic-code-free থেকে যায়, parsing-এর খরচ
  hot path-এর বাইরে।
- **কেন `MAX_NESTING_DEPTH` লাগলো `MAX_TOKENS`-এর পরেও।** `((((...))))`-
  স্টাইল একটা expression মাত্র দুটো token per level ব্যবহার করে — তাই
  token-count limit-এর নিচে থেকেও parser-কে recursively অনেক গভীরে
  পাঠাতে পারতো, এবং JS-এর নিজের call stack limit-এ আঘাত করে একটা uncaught
  `RangeError` (crash-প্রবণ, "fail closed" না) তৈরি করতে পারতো। `parser.ts`-
  এর নিজস্ব `MAX_NESTING_DEPTH` (৩২) counter এটা আগে থেকেই ধরে ফেলে, একটা
  clean `DslError` দেয় (crash না)। `test-policy-dsl.ts`-এ ২০০-গভীরতার
  nested paren দিয়ে সরাসরি টেস্ট করা।
- **Keyword casing strict কেন — ambiguity দূর করার জন্য, না অলসতা।**
  `AND`/`OR`/`NOT`/`IN`/`EXISTS` uppercase-ই, `true`/`false`/`null`
  lowercase-ই — একটাই সঠিক বানান per keyword, "roadmap-এর নিজস্ব
  requirement list-এ থাকা 'typed, validated, deterministic'"-এর সাথে
  সামঞ্জস্যপূর্ণ। lowercase `and` লিখলে সেটা keyword হিসেবে না, একটা
  malformed attribute-path হিসেবে reject হয় (silently AND-এ downgrade হয়
  না) — এইটা সরাসরি টেস্ট করা হয়েছে।
- **IN/NOT IN-এর literal list mixed-type হতে পারবে না।** `[1, "a"]`-এর
  মতো একটা list reject হয় — শুধু all-string বা all-number list অনুমোদিত।
  এটা `AttributeValue`-এর নিজস্ব `string[] | number[]` (কখনো mixed array
  না) shape-এর সাথে সামঞ্জস্যপূর্ণ রাখার জন্য, আর DSL-টাকে সত্যিকারের
  "typed" রাখার জন্য।
- **Left-hand side সবসময় একটা attribute path হতে হবে, কখনো literal না।**
  `AttributeComparison.attribute` টাইপ একটা `string` path — এটাই কাঠামোগত
  বাধ্যবাধকতা। `"5" == subject.role`-এর মতো কিছু লিখলে `INVALID_LEFT_OPERAND`
  দিয়ে reject হয়, silently flip হয় না। এন্ড-অফ-ইনপুট (একদম কিছুই নেই)
  বনাম "ভুল টাইপের টোকেন আছে" — এই দুটো ভিন্ন পরিস্থিতির জন্য আলাদা error
  code (`UNEXPECTED_END_OF_INPUT` বনাম `INVALID_LEFT_OPERAND`/
  `UNEXPECTED_TOKEN`) — টেস্ট রান করেই এই distinction-এর একটা bug ধরা
  পড়েছে (নিচে দেখুন)।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- আইসোলেটেড `tsc` স্যান্ডবক্সে (network/node_modules ছাড়া, আগের ফেজগুলোর
  একই সীমাবদ্ধতা) `lib/policy/*`-এর পুরো non-Drizzle/non-Express অংশ
  টাইপচেক করা হয়েছে — **নতুন/পরিবর্তিত কোনো ফাইলে শূন্য error**।
- একই স্যান্ডবক্সে `tsc`-দিয়ে JS কম্পাইল করে Node দিয়ে **আসলেই রান করে**
  যাচাই করা হয়েছে (শুধু টাইপচেক না) — প্রথমে একটা ছোট smoke-test স্ক্রিপ্ট
  দিয়ে, তারপর পূর্ণাঙ্গ `scripts/src/test-policy-dsl.ts`।
- `npx tsx scripts/src/test-policy-dsl.ts`-এর সমতুল্য রান — **৩৬/৩৬ পাস**।
- এই রান **তিনটা real বাগ ধরেছে**, যেগুলো code-review-only দিয়ে ধরা পড়তো
  না:
  1. `parseLiteral()`-এর ডিফল্ট error branch সবসময় `UNEXPECTED_TOKEN` কোড
     দিতো, এমনকি end-of-input-এও — fix: EOF হলে `UNEXPECTED_END_OF_INPUT`।
  2. `parseComparison()`-এর operator-selection branch-এও একই সমস্যা —
     একই fix প্রয়োগ করা হয়েছে।
  3. `parseComparison()`-এর left-operand check `INVALID_LEFT_OPERAND`
     সবসময় দিতো, এমনকি end-of-input-এও (যেমন `"subject.role == \"x\" AND"`-
     এর পরে কিছুই নেই) — fix: EOF-এ `UNEXPECTED_END_OF_INPUT`, শুধু
     "ভুল টাইপের টোকেন উপস্থিত" অবস্থাতেই `INVALID_LEFT_OPERAND`।
  তিনটাই ফিক্স করে আবার রান করে কনফার্ম করা হয়েছে।
- রিগ্রেশন: 1A/1B(PIP-বাদে)/1C/02/3A/3B/3C/04/05 — সব কয়টা suite
  (`test-policy-engine`, `test-policy-rbac`, `test-policy-resource`,
  `test-policy-resource-grants`, `test-policy-resource-org-access`,
  `test-policy-rebac`, `test-policy-decision-observer`,
  `test-policy-abac`) এই পাসের `abac/types.ts`/`abac/condition-evaluator.ts`
  পরিবর্তনের পরে আবার রান করে কনফার্ম করা হয়েছে — **কোনো রিগ্রেশন নেই**
  (`test-policy-abac`-এর ২৯টা টেস্টই এখনো পাস করে, `valueAttribute` যোগ
  হওয়ার পরেও)।

## Security tests কভার করা হয়েছে

- **কখনো dynamic code execution না — সরাসরি টেস্ট করা।** classic
  eval-injection payload (`require("child_process")`, template-literal
  injection, arithmetic injection, `__proto__`/`constructor` chain) —
  সবগুলো শুধু syntax error, কখনো execute হয় না।
- **`subject.__proto__` একটা সাধারণ (non-matching) field, prototype-
  pollution vector না** — `getAttribute()`-এর `hasOwnProperty` check-এর
  উপর নির্ভর করে, DSL-লেভেলেও নিশ্চিত করা হয়েছে।
- **Policy injection:** একটা hostile/malformed expression কখনো silently
  "always allow"-এ fallback করে না বা partially parse হয় না — সবসময় থ্রো
  করে, `compileAbacPolicies()`-এর batch compile-ও fail-fast (partial
  compile না)।
- **Invalid DSL:** ১৫টা error code-এর প্রতিটার জন্য ডেডিকেটেড টেস্ট
  (malformed path, unknown group, unterminated string, unbalanced paren,
  empty/mixed-type list, ইত্যাদি)।
- **Bounded parsing (DoS-প্রতিরোধ):** oversized input, oversized string
  literal, অতিরিক্ত token সংখ্যা, আর — সবচেয়ে গুরুত্বপূর্ণভাবে — deeply
  nested parens (২০০ লেভেল) MAX_NESTING_DEPTH_EXCEEDED দিয়ে fail-closed
  হয়, JS call-stack crash না।
- **Cross-tenant isolation:** roadmap-এর নিজস্ব conceptual example
  (`subject.organization == resource.organization`) ব্যবহার করে একটা real
  cross-tenant deny টেস্ট করা হয়েছে — same-org ALLOW, different-org DENY।
- **Composition:** DSL দিয়ে কম্পাইল করা একটা ABAC allow তবুও locked-resource
  DENY-কে হারাতে পারে না (deny-overrides অপরিবর্তিত)।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি

- Persisted/versioned policy storage, admin UI, lifecycle
  (DRAFT→TESTING→APPROVED→ACTIVE→DISABLED→ARCHIVED) — Phase 07 (Policy
  Registry/PAP)।
- Priority/precedence system একাধিক conflicting policy-র মধ্যে — Phase 08।
- DSL-থেকে-টেক্সট round-trip (stringify করে আবার DSL text বানানো) —
  explainability (Phase 15)-এর জন্য দরকার হতে পারে, কিন্তু এখনই implement
  করা হয়নি (Rule 16, এখনো কোনো প্রয়োজন নেই)।
- Exponent notation, escape sequence (`\n`, `\t`, `\uXXXX`) স্ট্রিং
  লিটারেলে, বা `+`/`OR`-এর বাইরে কোনো arithmetic operator — ইচ্ছাকৃতভাবে
  বাদ, DSL-টাকে ছোট আর unambiguous রাখার জন্য।
- কোনো route/service এখনো এই DSL ব্যবহার করছে না — grep করে কনফার্ম করা
  হয়েছে।
- `tsc --build` পুরো মনোরিপোতে — sandbox-এ network/node_modules না থাকায়
  সম্ভব হয়নি (Phase 02-05-এর একই known limitation)।

## PHASE STATUS

- **Implemented:** Policy DSL — hand-written tokenizer + recursive-descent
  parser (`parseAbacDsl()`), text-থেকে `AbacCondition` কম্পাইল করে; DSL
  policy source থেকে `AbacPolicyDefinition` বানানোর হেল্পার
  (`compileAbacPolicy()`/`compileAbacPolicies()`); attribute-to-attribute
  তুলনা সাপোর্ট (Phase 05-এর `AbacCondition`-এ additive এক্সটেনশন)।
- **Files changed:** `lib/policy/abac/types.ts`,
  `lib/policy/abac/condition-evaluator.ts`, `lib/policy/abac/index.ts`।
- **Files added:** `lib/policy/abac/dsl/errors.ts`,
  `lib/policy/abac/dsl/tokenizer.ts`, `lib/policy/abac/dsl/parser.ts`,
  `lib/policy/abac/dsl/compile-policy.ts`, `lib/policy/abac/dsl/index.ts`,
  `scripts/src/test-policy-dsl.ts`।
- **Database changes:** কোনোটাই না।
- **Tests:** ৩৬/৩৬ পাস (`scripts/src/test-policy-dsl.ts`-এর সমতুল্য
  আইসোলেটেড রান)।
- **Security tests:** no-dynamic-code-execution probes, prototype-pollution
  non-vector confirmation, policy injection / fail-fast batch compile,
  ১৫টা error code-এর প্রতিটা, bounded parsing (input length/string
  length/token count/nesting depth — DoS-প্রতিরোধ), cross-tenant isolation
  (roadmap-এর নিজস্ব উদাহরণ ব্যবহার করে), composition/deny-overrides —
  সবগুলো কভার।
- **Known limitations:** কোনো policy registry/storage নেই এখনো (Phase 07);
  কোনো route/service এই DSL ব্যবহার করছে না; sandbox-এ পুরো মনোরিপো
  `tsc --build` চালানো যায়নি (আগের ফেজগুলোর একই সীমাবদ্ধতা, isolated tsc +
  রানটাইম টেস্ট দিয়ে compensate করা হয়েছে)।
- **Regression status:** 1A/1B(PIP-বাদে)/1C/02/3A/3B/3C/04/05 — রিগ্রেশন
  নেই।
- **Next phase:** Phase 06 সম্পূর্ণ। Roadmap-এর AUDIT GATES তালিকায় Phase
  06-এর পরে কোনো নির্দিষ্ট আনুষ্ঠানিক audit ধার্য নেই (পরেরটা Phase 10-এ,
  Identity + Risk Audit) — তবে Rule 15 অনুযায়ী এই রিপোর্ট রিভিউ হওয়া
  উচিত Phase 07 (Policy Registry/PAP) শুরু করার আগে।

**এই পাস এখানেই থামছে (Rule 16) — Phase 07 (Policy Registry/PAP)
স্বয়ংক্রিয়ভাবে শুরু হচ্ছে না।**
