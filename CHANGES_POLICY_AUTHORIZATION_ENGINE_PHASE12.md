# AYZEN Policy & Authorization Mega Engine — Phase 12: Approval Engine

## স্কোপ

Roadmap-এর Phase 12 সেকশন verbatim implement করা হয়েছে: `REQUIRE_APPROVAL`
সাপোর্ট করা, request-এ থাকবে `initiator`, `approver`, `scope`, `reason`,
`expiry`, `approval state`, `audit trail` — এবং CRITICAL rule: "Initiator
must not approve their own sensitive operation।"

এই পাস শুরু করার আগে Phase 11 (Temporary / Expiring Access) মূল codebase-এ
merge করা হয়েছে — সেটা আগে একটা আলাদা zip-এ ছিল, main archive-এ ছিল না
(`CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE10B.md`-ই ছিল সর্বশেষ
merged phase)। Migration numbering (100 → 101) এবং `lib/policy/index.ts`
barrel সিকোয়েন্স ঠিক রাখার জন্য এটা প্রয়োজন ছিল।

## কেন `AuthorizationDecision.effect: "APPROVAL_REQUIRED"` নতুন কিছু না,
   শুধু প্রথমবার ব্যবহৃত হলো

Phase 1A থেকেই `types.ts`-এর `DecisionEffect` union-এ `"APPROVAL_REQUIRED"`
আর `decision-reasons.ts`-এ `APPROVAL_REQUIRED` reason code, আর
`authorization-decision.ts`-এ `approvalRequired()` factory — এই তিনটাই
আগে থেকেই reserved ছিল ("Reserved for later Phase 01+ sub-phases... Not
produced by anything in 1A")। Phase 12 হলো প্রথম phase যেটা আসলে এটা
produce করে — কোনো নতুন engine-level পরিবর্তন লাগেনি, শুধু একটা নতুন rule।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/db/src/schema/approval-requests.ts` (**merge করা — user-supplied**) | Drizzle table def: `approvalRequestsTable` (`initiator_user_id`, `resource_type`, `resource_id` nullable, `action`, `organization_id` nullable, `reason` NOT NULL, `state` default `'PENDING'`, `expires_at`, `decided_by`/`decided_at`/`decision_reason` nullable) এবং `approvalAuditLogTable` (append-only)। `insertApprovalRequestSchema`/`insertApprovalAuditLogSchema` — Zod state/action enum-refine। |
| `migrations/101_ayzen_approval_requests.sql` (**নতুন**) | Schema ফাইলের সাথে হুবহু মিল রেখে দুইটা `CREATE TABLE IF NOT EXISTS`, তিনটা index (`approval_requests_lookup_idx` — gate rule-এর exact-match lookup যে চারটা কলাম ফিল্টার করে ঠিক সেগুলো; `approval_requests_state_idx`; `approval_requests_expires_idx` — future cleanup job-এর জন্য), CHECK constraints (`state` enum, `action` enum, আর একটা নতুন `approval_requests_decision_consistency_check`: `APPROVED`/`REJECTED` হলে `decided_by`+`decided_at` NOT NULL বাধ্যতামূলক, `PENDING`/`EXPIRED`/`CANCELLED` হলে দুটোই NULL হতে হবে) — সবকিছু idempotent। |
| `lib/policy/approval/types.ts` (**নতুন**) | DB-free: `ApprovalState` union, `ApprovalRequestRecord`, `CreateApprovalRequestInput`, `ApprovalAuditEntry`, `ApprovalRequestProvider` ইন্টারফেস (never throws for "not found"; workflow legality validation entirely `ApprovalEngine`-এর দায়িত্ব, provider dumb store)। |
| `lib/policy/approval/errors.ts` (**নতুন**) | `ApprovalRequestNotFoundError`, `SelfDecisionNotAllowedError` (CRITICAL rule), `ApprovalAlreadyDecidedError`, `ApprovalRequestExpiredError`, `NotRequestInitiatorError`, `InvalidApprovalRequestError`। |
| `lib/policy/approval/approval-engine.ts` (**নতুন**) | `ApprovalEngine` ক্লাস — `requestApproval()` (shape validation: non-blank reason, future `expiresAt`), `decide()` (self-decision guard **সবার আগে** চেক হয় — এমনকি "already decided" চেকের আগেও, যাতে error ordering দিয়ে state leak না হয়; তারপর PENDING-legality; তারপর decision-window lazy expiry), `cancel()` (শুধু initiator নিজে পারে, অন্য কেউ না), `expireIfPastDeadline()` (idempotent lazy-expiry helper future cleanup job/read path-এর জন্য), `isPastDeadline()`। প্রতিটা mutation-এ audit entry লেখে (Rule 10), audit-write ব্যর্থ হলে re-throw করে (swallow করে না — `PolicyRegistry`-র একই posture)। |
| `lib/policy/approval/approval-gate-rule.ts` (**নতুন**) | `createApprovalGateRule()` — এই engine-এর প্রথম rule যেটা `APPROVAL_REQUIRED` *এবং* `ALLOW` দুটোই produce করতে পারে (assurance-rule-এর মতো শুধু gate/step-up-only না — একটা approved request-ই এই action-এর জন্য grant)। কোনো matching requirement না থাকলে abstain; থাকলে exact-match tuple (`initiatorUserId`, `resourceType`, `resourceId`, `action`)-এর জন্য live `APPROVED` row খোঁজে — পেলে ALLOW, না পেলে APPROVAL_REQUIRED। কখনো DENY রিটার্ন করে না — একটা REJECTED/EXPIRED request মানে শুধু "এখনো কোনো live approval নেই", permanent block না (সেটা Phase 13-এর scope)। |
| `lib/policy/approval/drizzle-approval-request-provider.ts` (**নতুন**) | আসল `@workspace/db`-backed provider — `findApprovedRequest()` SQL-এই `state = 'APPROVED'` ফিল্টার করে (temporary-access provider-এর বিপরীতে, যেখানে rule নিজে time compare করার জন্য filtering deliberately বাদ দেওয়া হয়েছিল — approval-এর ক্ষেত্রে `state` কোনো clock-derived property না, তাই SQL-এ ফিল্টার করাই স্বাভাবিক)। Malformed `state` row পেলে throw করে (fail closed) — single-row read-এ "skip" করার মতো array নেই বলে। |
| `lib/policy/approval/index.ts` (**নতুন**) | Barrel — Drizzle provider বাদে (`temporary-access/index.ts`-এর একই precedent)। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./approval` যোগ হলো টপ-লেভেল barrel-এ। |
| `scripts/src/test-policy-approval.ts` (**নতুন**) | ৩০টা DB-free টেস্ট। |
| Phase 11 merge (`lib/db/src/schema/temporary-access-grants.ts`, `lib/policy/temporary-access/*`, `migrations/100_...sql`, `scripts/src/test-policy-temporary-access.ts`, `CHANGES_..._PHASE11.md`) | আলাদা delivery থেকে main codebase-এ কপি করা হলো — Phase 12 শুরু করার prerequisite। কোনো লজিক পরিবর্তন হয়নি, verbatim merge। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **CRITICAL rule সবচেয়ে আগে চেক হয়, "already decided" চেকেরও আগে।**
  `decide()`-এ `actorUserId === request.initiatorUserId` সবার প্রথমে চেক
  হয় — এমনকি request এখনো PENDING কিনা সেটা দেখারও আগে। কারণ: initiator
  নিজে decide করার চেষ্টা করলে সে যেন error message থেকে বুঝতে না পারে
  request টা এখনো PENDING নাকি ইতিমধ্যে decided — দুই ক্ষেত্রেই একই
  `SelfDecisionNotAllowedError` আসে। টেস্টে এটা সরাসরি পিন করা হয়েছে
  ("self-decision guard fires even for an already-decided request")।
- **`decidedBy` রো-তে শুধু APPROVED/REJECTED-এর জন্য সেট হয়, CANCELLED-এর
  জন্যও না — যদিও cancel() initiator নিজে explicit call করে।** Schema
  file-এর নিজের header অনুযায়ী: "decided_by ... stays NULL forever for a
  row that ends EXPIRED/CANCELLED, since nobody ever decided it।" Row-এর
  `decidedBy` কলাম প্রশ্ন করে "কে approve/reject করলো", আর audit
  log-এর `actorId` আলাদাভাবে প্রশ্ন করে "কে এই নির্দিষ্ট transition-টা
  ঘটালো" — CANCELLED-এর ক্ষেত্রে এই দুই প্রশ্নের উত্তর আলাদা (row: কেউ না;
  audit: initiator)।
- **Approval gate rule কখনো DENY রিটার্ন করে না।** একটা REJECTED বা
  EXPIRED request মানে "এই মুহূর্তে কোনো live APPROVED row নেই" — এটা নতুন
  করে APPROVAL_REQUIRED-ই থাকে, permanent DENY বানানো হয় না। কেউ যদি একবার
  reject হয়ে থাকে তাহলে সে আবার নতুন request করতে পারবে কিনা সেটা
  ইচ্ছাকৃতভাবে বন্ধ করা হয়নি — Separation-of-Duties-স্টাইল hard block Phase
  13-এর scope, Phase 12-এর না।
- **Approval gate rule, assurance-rule-এর বিপরীতে, ALLOW-ও produce করতে
  পারে।** Roadmap-এর target architecture-এ APPROVAL হলো ALLOW/STEP-UP-এর
  পাশে একটা sibling outcome, কোনো অন্য rule-এর উপর layered একটা mere
  precondition না — একটা approved request নিজেই এই নির্দিষ্ট action-এর
  জন্য grant। এই কারণে assurance-rule-এর "never returns ALLOW" নীতি এখানে
  খাটে না, ইচ্ছাকৃতভাবে।
- **Exact-match lookup, কোনো wildcard/broad scope না।** Phase 11-এর
  `temporary_access_grants`-এর মতো `scope: "resource_type"` breadth এখানে
  নেই — schema file-এর header অনুযায়ী: একটা approval request ইনহেরেন্টলি
  এক named initiator-এর এক specific, accountable action-এর জন্য, broad
  short-lived capability না।
- **APPROVAL_REQUIRED short-circuit করে, ALLOW-এর registration order
  যাই হোক না কেন।** `policy-engine.ts`-এর `evaluateCore()` প্রথম ALLOW
  পেলেও loop চালিয়ে যায় (পরে কোনো DENY আসতে পারে সেই আশায়), কিন্তু
  APPROVAL_REQUIRED/STEP_UP পেলে সাথে সাথে রিটার্ন করে — তাই approval
  gate rule অন্য কোনো ALLOW-producing rule-এর আগে বা পরে register করা
  হোক, gate যদি APPROVAL_REQUIRED রিটার্ন করে সেটাই জিতবে। শুধু একটা
  আগে-registered DENY gate-কে beat করতে পারে (deny-overrides, unconditional)
  — এই ambiguity assurance-rule-এর header-এই আগে থেকে documented, একই
  posture এখানে অনুসরণ করা হয়েছে। টেস্টে তিনটা composition case দিয়ে এটা
  পিন করা হয়েছে।
- **`decide()`-এ `now` default একটা fresh clock read, PDP rule-এর মতো
  `context.timestamp` না।** `ApprovalEngine.decide()` একটা mutation
  method, evaluation না — একটা real decision সত্যিই যে মুহূর্তে ঘটে
  সেটাই। Boundary টেস্টের জন্য explicit `now` পাস করা হয়েছে, ঠিক
  `test-policy-temporary-access.ts`-এর মতোই একটা "fixed clock" প্যাটার্ন,
  শুধু এখানে সেটা একটা pure rule-এর বদলে একটা mutation-এ প্রয়োগ করা।
- **`findApprovedRequest()` SQL-এই `state = 'APPROVED'` ফিল্টার করে,
  `DrizzleTemporaryAccessGrantProvider`-এর বিপরীতে।** Time-window filtering
  Phase 11-এ deliberately rule-এর কাজ (determinism-এর জন্য — DB-এর "now"
  বনাম request-এর fixed timestamp)। এখানে `state` কোনো clock-derived
  property না — একটা row হয় APPROVED, নাহয় না, query time-এ — তাই SQL-এ
  ফিল্টার করাই স্বাভাবিক, কোনো determinism সমস্যা নেই।

## যা ইচ্ছাকৃতভাবে Phase 12-এ নেই

- **কোনো route/middleware `ApprovalEngine`/`createApprovalGateRule()`/
  `DrizzleApprovalRequestProvider` কল করে না** — Phase 19 (PEP) পর্যন্ত
  real wiring বাকি, প্রতিটা আগের phase-এর একই posture।
- **কোনো `ApprovalAdminAuthorizer`/RBAC permission gate নেই WHO may
  decide()-এর উপর।** Roadmap-এর Phase 12 সেকশন ঠিক একটা CRITICAL rule
  নাম করে (self-decision guard) — "কে approver permission রাখে" একটা
  আলাদা concern যেটা ভবিষ্যতে একটা route `registry/authorizer.ts`-এর
  `admin.policy.approve`-এর মতো `admin.approval.decide`-স্টাইল permission
  দিয়ে wire করতে পারবে, কিন্তু roadmap টেক্সট নিজে সেটা require করে না,
  তাই Rule 16 অনুযায়ী এখানে invent করা হয়নি।
- **`PrecedenceEngine`-এ কোনো actual registration নেই এবং কোনো নতুন
  precedence tier নেই।** Assurance-rule-এর মতোই — কোন tier-এ belong করে
  সেটা registration-time-এর caller-এর সিদ্ধান্ত, `precedence-tiers.ts`
  ফাইলে কোনো পরিবর্তন লাগেনি।
- **কোনো "at most one live APPROVED per tuple" DB-level constraint নেই।**
  একটা fresh `requestApproval()` call একই tuple-এর জন্য যখন একটা approved
  request ইতিমধ্যে on file আছে, তখনও সম্পূর্ণ legal একটা নতুন request —
  migration 099-এর "at most one ACTIVE policy version" partial unique
  index-এর মতো কোনো analogous invariant Phase 12-এর roadmap টেক্সট চায়নি।
- **কোনো background cleanup/reminder job নেই** overdue PENDING row
  walk করার জন্য — `expireIfPastDeadline()` তৈরি করা হয়েছে যাতে ভবিষ্যতের
  এমন job (বা lazy read path) সহজে এটা কল করতে পারে, কিন্তু কিছুই এখনো
  এটা schedule করে না।
- **কোনো admin/write API নেই** approval request তৈরি বা decide করার
  জন্য — শুধু engine (এই পাসের scope), route wiring পরের phase-এর কাজ।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-approval.ts`** — **৩০/৩০ পাস।**
- **রিগ্রেশন — Phase 1A থেকে 11 পর্যন্ত সবকয়টা suite আবার রান করা হয়েছে**
  (১৭টা পুরনো suite + নতুনটাসহ মোট ১৮টা) — **সবগুলো পাস, কোনো রিগ্রেশন
  নেই।**
- **Isolated `tsc --noEmit --strict` টাইপ-চেক** নতুন `approval/*` ফাইলগুলো
  এবং `lib/policy/index.ts`-এর উপর (drizzle provider বাদে, যেটা
  `@workspace/db`/`drizzle-orm` লাগে) — **approval-সংক্রান্ত কোনো error
  নেই।** যে দুটো error এসেছে (`express` টাইপ না পাওয়া, `node:crypto`
  টাইপ না পাওয়া) সেগুলো পুরো sandbox-এ preexisting environment gap
  (`@types/node`/`express` install করা নেই), নতুন কোডের সাথে সম্পর্কহীন।
- **Dynamic-code-execution audit:** নতুন কোনো ফাইলে `eval`/`new Function`/
  `vm.Script` নেই।
- **SQL-injection audit:** `DrizzleApprovalRequestProvider` শুধু
  Drizzle-এর `eq`/`and`/`isNull`/`desc` query builder ব্যবহার করে — কোনো
  raw SQL string interpolation নেই।
- **`DrizzleApprovalRequestProvider` real DB-এর বিরুদ্ধে রান করা হয়নি**
  (network নেই এই sandbox-এ) — Phase 02-11-এর প্রতিটা DB-backed
  provider-এর একই known limitation।
- **`pnpm run typecheck` (পুরো workspace) এই sandbox-এ রান করা যায়নি** —
  `node_modules` install করা যায়নি (network নেই)। Isolated tsc check
  (উপরে) দিয়ে risk কমানো হয়েছে যতটা সম্ভব।

## Security tests কভার করা হয়েছে

- **CRITICAL — self-decision guard:** initiator নিজের request approve
  করতে চেষ্টা করলে block; already-decided request-এর উপরও একই guard
  fire করে (state leak হয় না)।
- **Workflow legality:** already-approved request আবার decide করা যায়
  না; unknown id-তে decide/cancel করলে NotFoundError; non-initiator
  cancel করতে পারে না; already-decided request cancel করা যায় না।
- **Clock boundaries:** decision window বন্ধ হওয়ার ১ms আগে (decide হয়),
  ঠিক `expiresAt`-এ (lazy EXPIRED, decide ব্যর্থ হয়), অনেক পরে (একই)।
- **IDOR / resource-ID substitution:** resourceId 555-এর approval
  resourceId 556-এ leak করে না।
- **Cross-user:** এক initiator-এর approval অন্য subject-এ extend হয় না।
- **Privilege escalation:** forged unrelated resource fields দিয়ে ALLOW
  তৈরি হয় না — শুধু exact-match tuple-ই ব্যাপার রাখে।
- **Org-wide vs concrete resource:** `resourceId: null` approval শুধু
  আরেকটা `resourceId: null` request-কেই match করে, কোনো concrete id-কে
  না।
- **Unauthenticated:** কখনো gate rule পর্যন্ত পৌঁছায় না।
- **Composition/precedence:** আগে-registered DENY জেতে; আগে-registered
  ALLOW approval gate-কে bypass করতে পারে না; approved হওয়ার পর অন্য
  ALLOW rule-এর সাথে সঙ্গতিপূর্ণভাবে ALLOW।
- **Determinism:** একই request object দুইবার evaluate করলে একই effect।

## Regression status
কোনো রিগ্রেশন নেই।

## Migration status
সম্পূর্ণ additive, dormant। কোনো route/middleware কল করে না। নতুন migration
(101) idempotent, Supabase SQL Editor-এ manually রান করতে হবে (migration
100-এর পরে)।

## Next phase
Phase 12-এর পরে roadmap-এ পরের formal audit gate নেই (পরেরটা Phase 15)।
এরপর Phase 13 (Separation of Duties) — creator != approver, requester !=
reviewer, key-rotator != sole approver-এর মতো constraint, finance/vault/
security/org-administration-কে prioritize করে।
