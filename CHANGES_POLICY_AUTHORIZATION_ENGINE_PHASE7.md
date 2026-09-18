# AYZEN Policy & Authorization Mega Engine — Phase 07: Policy Registry / PAP

## Phase 06 audit gate — status

Roadmap-এর "AUDIT GATES" তালিকায় Phase 06-এর পরে কোনো formal audit-gate নেই
(পরের gate Phase 10-এ) — তবু শুরু করার আগে নিশ্চিত করা হয়েছে:
- `grep -rn "eval(\|new Function(\|require(" lib/policy/` চালিয়ে কনফার্ম করা
  হয়েছে যে Phase 07-এর নতুন কোনো ফাইলেও dynamic code execution নেই।
- Phase 06-এর CHANGES doc-এর সব security test আবার রান করে কনফার্ম করা
  হয়েছে (নিচে "যাচাই" সেকশনে বিস্তারিত) — কোনো critical security regression
  পাওয়া যায়নি।

## এই পাসে যা তৈরি হলো

Roadmap-এর Phase 07 লাইন-বাই-লাইন কভার করা হয়েছে: centralized policy
administration (PAP) — policy fields (policyId/name/description/
application/resource/action/rules/priority/status/version/createdBy/
approvedBy/timestamps), lifecycle
(`DRAFT → TESTING → APPROVED → ACTIVE → DISABLED → ARCHIVED`), শুধু
authorized administrator-রাই policy modify করতে পারবে, sensitive policy
change-এর জন্য strong authentication + audit বাধ্যতামূলক।

| ফাইল | কী করে |
|---|---|
| `lib/policy/registry/types.ts` (**নতুন**) | Pure types। `PolicyStatus`/`PolicyRuleKind`/`PolicyEffect`, immutable `PolicyRecord` (কোন চারটা ফিল্ড-ই একমাত্র মিউটেবল — `status`/`approvedBy`/`approvedAt`/`updatedAt` — তার ডকুমেন্টেশনসহ), `NewPolicyInput`/`NewPolicyVersionInput`, `PolicyAdminActor`, `PolicyAdminAuditEntry`, আর দুইটা injected-collaborator interface: `PolicyRegistryProvider` (storage) এবং `PolicyAdminAuthorizer` (authorization)। |
| `lib/policy/registry/errors.ts` (**নতুন**) | ৬টা ডেডিকেটেড error class — `PolicyNotFoundError`, `PolicyAlreadyExistsError`, `InvalidPolicyContentError`, `PolicyLifecycleError`, `PolicyAuthorizationError`, `SelfApprovalNotAllowedError`, `InsufficientAssuranceError` — যাতে caller স্ট্রিং পার্স না করে WHY একটা mutation reject হলো বুঝতে পারে। |
| `lib/policy/registry/lifecycle.ts` (**নতুন**) | `LIFECYCLE_TRANSITIONS` টেবিল — roadmap-এর সরল লিনিয়ার লাইফসাইকেলকে বাস্তব operational প্রয়োজন মেটানোর জন্য extend করা হয়েছে (TESTING→DRAFT ফিরে যাওয়া যায়, ACTIVE↔DISABLED টগল করা যায়, যেকোনো state থেকে সরাসরি ARCHIVED যাওয়া যায়, ARCHIVED সত্যিকারের terminal)। `SENSITIVE_TRANSITIONS` (আজ শুধু →ACTIVE) আর `assertValidTransition()`। |
| `lib/policy/registry/authorizer.ts` (**নতুন**) | `RbacPolicyAdminAuthorizer` — Phase 02-এর `RbacProvider`/`resolveEffectivePermissions`/`permissionMatches` পুনঃব্যবহার করে (Rule 4: reuse existing auth/role data), নতুন কোনো permission-resolution পথ বানায়নি। `admin.policy.manage` (create/edit) আর `admin.policy.approve` (approve — manage থেকে আলাদা, সংকীর্ণ permission) — দুইটা distinct grant। |
| `lib/policy/registry/policy-registry.ts` (**নতুন**) | `PolicyRegistry` — আসল PAP ইঞ্জিন। `createPolicy()`/`createNewVersion()`/`transitionStatus()` — প্রতিটাই authorization → validation/lifecycle-check → DB write → audit write এই ক্রমে যায় (fail closed: reject হওয়া transition কখনো আংশিক apply হয় না)। `transitionStatus()`-এ maker-checker (creator ≠ approver) আর assurance gate (sensitive transition-এ strong auth লাগবে) enforce করা হয়। →ACTIVE করলে একই policyId-এর অন্য ACTIVE version স্বয়ংক্রিয়ভাবে DISABLED হয়ে যায় (at most one ACTIVE per policyId)। |
| `lib/policy/registry/drizzle-policy-registry-provider.ts` (**নতুন**) | `DrizzlePolicyRegistryProvider` — আসল `@workspace/db`-backed provider। `lib/policy/registry/*`-এর একমাত্র ফাইল যেটা `@workspace/db` import করে — বাকি সব DB-free, তাই `test-policy-registry.ts` কোনো database ছাড়াই রান করতে পারে। এখনো কিছু এটা construct করে না (কোনো admin route নেই — Phase 07-এর স্কোপের বাইরে)। |
| `lib/policy/registry/index.ts` (**নতুন**) | Barrel — `drizzle-policy-registry-provider.ts` বাদে সবকিছু re-export করে, `rbac/index.ts`/`rebac/index.ts`-এর একই pattern অনুসরণ করে। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./registry` যোগ হলো টপ-লেভেল barrel-এ। |
| `lib/db/src/schema/policy-registry.ts` (**নতুন**) | Drizzle schema — `policiesTable` আর `policyAdminAuditLogTable`। `rbac.ts`/`resource-grants.ts`-এর একই convention: কোনো DB-level FK নেই, zod insert-schema shallow validation। `rules` কলাম TEXT (DSL source, pre-compiled AST না)। |
| `lib/db/src/schema/index.ts` (**পরিবর্তিত**) | `./policy-registry` যোগ হলো। |
| `migrations/099_ayzen_policy_registry.sql` (**নতুন**) | `policies` + `policy_admin_audit_log` টেবিল তৈরি করে, idempotent। Partial unique index `policies_one_active_per_policy_id_idx ON policies(policy_id) WHERE status = 'ACTIVE'` — application-level "at most one ACTIVE" invariant-এর DB-level backstop। CHECK constraint দিয়ে status/effect/rule_kind/action shape-guard করা হয়েছে। |
| `scripts/src/test-policy-registry.ts` (**নতুন**) | ১৩টা DB-free টেস্ট — in-memory `FakePolicyRegistryProvider` + আসল `RbacPolicyAdminAuthorizer` (test-policy-rbac.ts-এর একই `FakeRbacProvider` shape-এ wired)। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **লাইফসাইকেল গ্রাফ roadmap-এর লিনিয়ার বর্ণনার চেয়ে richer কেন।**
  Roadmap আক্ষরিকভাবে বলে `DRAFT → TESTING → APPROVED → ACTIVE → DISABLED →
  ARCHIVED` — কিন্তু সেটা একটা সরল রেখা হিসেবে implement করলে বাস্তব
  operational প্রয়োজন মেটে না: একটা reject হওয়া TESTING policy-কে edit করার
  জন্য DRAFT-এ ফিরতে হবে (নাহলে প্রতিটা rejected draft-ই from scratch আবার
  বানাতে হতো), একটা misbehaving ACTIVE policy-কে বন্ধ করার একমাত্র উপায়
  ARCHIVED (terminal) হতে পারে না — তাই DISABLED-এ যাওয়া লাগে, আর DISABLED
  থেকে আবার ACTIVE-এ ফেরার সুযোগ না থাকলে DISABLED স্টেট থাকারই কোনো মানে
  নেই। যেকোনো state থেকে সরাসরি ARCHIVED-এ যাওয়া সবসময় খোলা রাখা হয়েছে
  ("retire this, আমি আর এটা বিবেচনা করতে চাই না" সবসময় available থাকা
  উচিত)। ARCHIVED থেকে "undo" ইচ্ছাকৃতভাবে model করা হয়নি — পুরনো intent
  ফিরিয়ে আনা মানে `createNewVersion()` (নতুন DRAFT, নতুন করে review), কোনো
  archived row-এর history-তে shortcut ফেরা না (Rule 11: versioned, না
  rewritten)।
- **Maker-checker আর assurance দুইটা আলাদা mechanism, একটা না।** Approval
  (`→APPROVED`)-এর জন্য লাগে `admin.policy.approve` permission + creator ≠
  approver চেক — এইটা distinct-actor requirement। Activation
  (`→ACTIVE`)-এর জন্য লাগে strong assurance (OTP/TOTP/passkey/backup-code)
  — এইটা distinct-authentication-strength requirement। এই দুইটাকে
  ইচ্ছাকৃতভাবে আলাদা রাখা হয়েছে কারণ roadmap-এর নিজস্ব Rule 13 ("sensitive
  operations must support stronger authentication assurance") আর
  maker-checker আলাদা concern — একটাকে অন্যটার প্রক্সি হিসেবে ব্যবহার করলে
  একটা legitimate single-approver-with-MFA workflow ভুলভাবে block হয়ে
  যেতে পারতো, অথবা উল্টোটা।
- **`applyStatusChange()`-এ audit snapshot DB call-এর ADGE নেওয়া হয়,
  পরে না।** এই মেথডের নিজস্ব কমেন্ট অনুযায়ী: কোনো `PolicyRegistryProvider`
  implementation যদি row object-টা in-place mutate করে return করে (একটা
  in-memory provider-এর জন্য common bug), তাহলে snapshot-টা call-এর পরে
  নিলে `before` আর `after` একই object হয়ে যেত (audit record নষ্ট হয়ে
  যেত)। Snapshot আগেই নিয়ে নেওয়া এই bug-টা structurally impossible করে
  দেয়, provider implementation যেভাবেই আচরণ করুক না কেন —
  `test-policy-registry.ts`-এর "every mutation writes exactly one audit
  row..." টেস্টটা এইটা সরাসরি pin করে।
- **`toAuditSnapshot()` থেকে `rules` (DSL source text) বাদ কেন।** একটা
  policy-র lifecycle-এ (DRAFT→TESTING→...→ARCHIVED) প্রতিটা status-change
  একটা নতুন audit row লেখে — যদি `rules`-ও প্রতিটা রো-তে duplicate হতো,
  audit log অপ্রয়োজনীয়ভাবে ফুলে যেত, যেখানে DSL text ইতিমধ্যে
  `policies.rules` কলামেই (getPolicy/listVersions দিয়ে) durably readable।
  audit row-এর বাকি সব ফিল্ড ইচ্ছাকৃতভাবে duplicate করা হয়েছে, কারণ একটা
  audit row-কে পরের কোনো version এসে supersede করলেও meaningful থাকতে হবে।
- **Audit-write ব্যর্থ হলে re-throw করা হয়, silently swallow করা হয় না
  — `oidc-client-admin-audit.ts`-এর best-effort precedent থেকে ইচ্ছাকৃতভাবে
  ভিন্ন।** একটা unaudited sensitive policy mutation একটা caller-কে retry
  করতে বলার চেয়ে খারাপ, Rule 10 (auditability) অনুযায়ী। Transactional
  (single round-trip) guarantee নেই insertVersion/updateStatus আর
  recordAudit-এর মধ্যে — এই codebase-এর বিদ্যমান কোনো Drizzle call site-ই
  `db.transaction()`-এ wrap করা না (দেখুন `DrizzleRbacProvider`), তাই এই
  পাস একতরফাভাবে নতুন কোনো pattern চালু করেনি।
- **Partial unique index শুধু migration SQL-এ, Drizzle `pgTable()` কলে
  না।** Drizzle-এর query builder-এ first-class partial-unique-index API
  নেই। "at most one ACTIVE per policyId" ইতিমধ্যে `PolicyRegistry
  .transitionStatus()`-এ application-level enforce করা হয় (নতুন কিছু
  activate করার আগে অন্য ACTIVE version-কে DISABLED করে দেয়) — DB-level
  index-টা শুধু belt-and-suspenders backstop, `role_permissions`-এর নিজস্ব
  unique index-এর একই যুক্তি।
- **`policyId` policy-র own natural key (URL-safe slug), `id` না।**
  `insertVersion`/`getPolicy`/`listVersions` সব `policyId` দিয়ে filter করে,
  numeric `id` শুধু একটা নির্দিষ্ট রো-কে (একটা নির্দিষ্ট version-কে)
  reference করার জন্য — যেমন audit entry-র `policyRowId`।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **আইসোলেটেড `tsc` sandbox** (network/node_modules ছাড়া, আগের ফেজগুলোর
  একই সীমাবদ্ধতা — `global-stubs.d.ts` দিয়ে node builtin-গুলো stub করা)
  দিয়ে পুরো `lib/policy/*`-এর DB-free অংশ (Drizzle provider-গুলো বাদে)
  টাইপচেক করা হয়েছে — **শূন্য error** (একমাত্র pre-existing,
  Phase-07-unrelated `pip/context-adapter.ts`-এর `express` type-এর
  অনুপস্থিতি বাদ দিয়ে, যেটা এই sandbox-এ ইচ্ছাকৃতভাবে exclude করা হয়েছে
  কারণ Phase 07-এর কোনো কোড path সেটা import করে না)।
- **`npx tsx scripts/src/check-all.ts --syntax-only`** পুরো মনোরিপোতে
  (৯৯৯টা ফাইল, ৬টা module) — **শূন্য syntax issue**।
- **`npx tsx scripts/src/test-policy-registry.ts`** — **১৩/১৩ পাস**।
- **রিগ্রেশন:** 1A/1B/1C/02/3A/3B/3C/04/05/06 — সবকয়টা suite
  (`test-policy-engine`, `test-policy-pip`, `test-policy-decision-observer`,
  `test-policy-rbac`, `test-policy-resource`,
  `test-policy-resource-grants`, `test-policy-resource-org-access`,
  `test-policy-rebac`, `test-policy-abac`, `test-policy-dsl`) এই পাসের
  `lib/policy/index.ts`/`lib/db/src/schema/index.ts` পরিবর্তনের পরে আবার
  রান করে কনফার্ম করা হয়েছে — **কোনো রিগ্রেশন নেই**।
- **`tsc --build`/`pnpm run typecheck` পুরো মনোরিপোতে রান করা হয়নি** —
  sandbox-এ `pnpm`/network/`node_modules` না থাকায় সম্ভব হয়নি, Phase
  02-06-এর একই known limitation। Isolated `tsc` sandbox আর
  `check-all.ts`-এর syntax check এটার আংশিক বিকল্প হিসেবে ব্যবহার করা
  হয়েছে।

## Security tests কভার করা হয়েছে

- **Fail closed:** `createPolicy()`/`createNewVersion()` কখনো কোনো DB
  write করে না validation বা authorization পাশ করার আগে — `assert.equal
  (provider.rows.length, 0)` দিয়ে সরাসরি টেস্ট করা হয়েছে দুইটা reject
  path-এই (invalid DSL, missing permission)।
- **Privilege escalation — approve ≠ manage:** শুধু `admin.policy.manage`
  থাকা একজন actor `→APPROVED` transition করতে পারে না
  (`PolicyAuthorizationError`), যদিও একই actor অন্য সব transition করতে
  পারে — permission narrowing সরাসরি টেস্ট করা।
- **Maker-checker bypass attempt:** একজন actor-কে ইচ্ছাকৃতভাবে দুইটা
  permission-ই (`manage` + `approve`) দিয়ে টেস্ট করা হয়েছে যে self-approval
  তবুও block হয় — শুধু permission-based check না, actor-identity-based
  check।
- **Lifecycle bypass:** step skip করা (`DRAFT→ACTIVE` সরাসরি) আর
  terminal state থেকে বের হওয়ার চেষ্টা (`ARCHIVED→DRAFT`) — দুটোই
  `PolicyLifecycleError`।
- **Assurance downgrade attempt:** `admin.policy.approve` থাকা কিন্তু
  কোনো `assuranceMethods` ছাড়া একজন actor `→ACTIVE` করতে পারে না
  (`InsufficientAssuranceError`), যদিও তার কাছে সঠিক permission আছে —
  permission আর assurance আলাদা gate, একটা অন্যটাকে bypass করতে পারে না।
- **Invalid policy content — injection-style DSL:** malformed rule text
  (`"subject.role =="`) কখনো silently store হয় না — `InvalidPolicyContentError`
  থ্রো করে, Phase 06-এর `compileAbacPolicy()` (fail-closed DSL validator)
  পুনঃব্যবহার করে, নতুন কোনো parsing path বানানো হয়নি।
- **Audit-log integrity:** প্রতিটা mutation-এ ঠিক একটা audit row লেখা হয়
  (দুইটা না, শূন্যটাও না), সঠিক `before`/`after` shape-সহ — direct assert
  দিয়ে টেস্ট করা।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি

- কোনো Express route/admin API — কিছুই `/admin/policies/*`-এ wire করা
  হয়নি, `DrizzlePolicyRegistryProvider` এখনো কিছুই construct করে না
  (Rule 16 — future phase-এর কাজ)।
- Registry-তে ACTIVE policy-র rule content PDP-র `PolicyEngine`-এ feed
  করা (registry থেকে rule load করে PDP rule হিসেবে register করা) —
  স্বাভাবিক next step কিন্তু এই ফেজের scope না (রেজিস্ট্রি + PAP নিজেই
  সম্পূর্ণ আর সঠিক এটা ছাড়াই)।
- Priority/precedence system একাধিক conflicting ACTIVE policy-র মধ্যে —
  Phase 08 (এই doc-এর পরে শুরু হচ্ছে)।
- `insertVersion`/`updateStatus` আর `recordAudit`-এর মধ্যে transactional
  guarantee — উপরে ব্যাখ্যা করা হয়েছে কেন এই পাস ইচ্ছাকৃতভাবে সেই pattern
  চালু করেনি।
- `tsc --build` পুরো মনোরিপোতে — sandbox limitation, উপরে "যাচাই" দেখুন।

## PHASE STATUS

- **Implemented:** Policy Registry / PAP — `PolicyRegistry` (create/
  createNewVersion/transitionStatus, lifecycle+authorization+
  maker-checker+assurance+audit সব enforce করে), `RbacPolicyAdminAuthorizer`
  (Phase 02 RBAC পুনঃব্যবহার), lifecycle transition graph, `PolicyRecord`
  persistence schema + Drizzle provider।
- **Files changed:** `lib/policy/index.ts`, `lib/db/src/schema/index.ts`।
- **Files added:** `lib/policy/registry/{types,errors,lifecycle,authorizer,
  policy-registry,drizzle-policy-registry-provider,index}.ts`,
  `lib/db/src/schema/policy-registry.ts`,
  `migrations/099_ayzen_policy_registry.sql`,
  `scripts/src/test-policy-registry.ts`।
- **Database changes:** নতুন টেবিল `policies`, `policy_admin_audit_log`
  (migration 099, idempotent, run AFTER 098) — কোনো বিদ্যমান টেবিল
  পরিবর্তন হয়নি।
- **Tests:** ১৩টা নতুন DB-free টেস্ট, সব পাস।
- **Security tests:** fail-closed create/transition, privilege escalation
  (approve≠manage), maker-checker bypass attempt, lifecycle bypass
  (skip-step, leave-terminal), assurance downgrade attempt, DSL
  injection-style content, audit-log integrity — সব কভার করা, সব পাস।
- **Known limitations:** কোনো route wire করা হয়নি (Rule 16); registry →
  PDP loader নেই; cross-write transactional guarantee নেই (ইচ্ছাকৃত,
  existing codebase pattern অনুসরণ করে); পুরো-মনোরিপো `tsc --build` sandbox-এ
  সম্ভব হয়নি।
- **Migration status:** `099_ayzen_policy_registry.sql` লেখা হয়েছে, run
  করা হয়নি (sandbox-এ কোনো database connectivity নেই — Phase 02-06-এর একই
  সীমাবদ্ধতা)। Idempotent, তাই Supabase SQL Editor-এ safe।
- **Regression status:** কোনো regression নেই — Phase 1A থেকে 06 পর্যন্ত
  প্রতিটা suite আবার রান করে কনফার্ম করা হয়েছে।
- **Next phase:** Phase 08 — Policy Precedence।
