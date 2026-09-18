# Route Integration Roadmap — Season B, Phase B3: Admin Consoles (dogfooding)

## যা আগে থেকেই ছিল
- চারটা admin console — `routes/admin-policy-console.ts`,
  `routes/admin-rbac-console.ts`, `routes/admin-resource-console.ts`,
  `routes/authorization-telemetry.ts` — প্রতিটাই `requireDev` দিয়ে
  protected ছিল (operator-tier session gate)। কিন্তু `requireDev`-এর পরে,
  WHO আসলে সেই console manage করতে পারবে সেটা প্রতিটা ক্ষেত্রেই একটা
  **hand-rolled, PDP-বহির্ভূত** authorizer করত:
  - `RbacPolicyAdminAuthorizer` (`lib/policy/registry/authorizer.ts`) —
    `admin.policy.manage` OR `admin.policy.approve`
  - `RbacRbacAdminAuthorizer` (`lib/policy/rbac-admin/authorizer.ts`) —
    `admin.role.manage` OR `admin.role.assign`
  - `RbacResourceAdminAuthorizer` (`lib/policy/resource-admin/authorizer.ts`)
    — `admin.resource.manage` (একটাই flat permission)

  প্রতিটাই সরাসরি `resolveEffectivePermissions()`/`permissionMatches()`
  call করত — কখনো `PolicyEngine.evaluate()` না। ফলে এই চারটা console-এর
  নিজের access decision কখনো `Decision`/`requestId` পায়নি, কখনো
  `authorization_audit_log`-এ row হয়নি, আর `authorization-telemetry`-র
  নিজের dashboards-এই কখনো গোনা হয়নি — Season A/B1 যা RBAC/ownership
  route-গুলোর জন্য আগেই করে ফেলেছে, engine নিজের ম্যানেজমেন্ট-console-এর
  জন্য কখনো করেনি।
- `routes/authorization-telemetry.ts` আরও খারাপ অবস্থায় ছিল: এটা
  `routes/index.ts`-এ **কোনো auth middleware ছাড়াই** mounted ছিল —
  `requireDev`-ও না। যেকোনো unauthenticated caller এই engine-এর প্রতিটা
  authorization decision-এর aggregate (denial rate, কোন policy fire করে,
  unusual-access-pattern flag) পড়তে পারত। একটা real information
  disclosure, sibling তিনটা console-এর মতো "always required `requireDev`"
  tier-এ কখনো ছিলই না।
- `lib/policy/rbac/rbac-rule.ts`-এর `createRbacRule()` একটা fixed
  `request.action`-এর বিরুদ্ধে চেক করে — "subject-এর EITHER of two
  independent permissions আছে কিনা" (policy/RBAC console দুটোর নিজের
  প্রশ্ন) এটা দিয়ে express করা যায় না।

## যেটা যোগ করা হলো (Phase B3)

### নতুন rule: `createAnyPermissionRule()` (`lib/policy/rbac/any-permission-rule.ts`)
`createRbacRule()`-এর ঠিক same shape (DB-free, `RbacProvider` নেয়,
`resolveEffectivePermissions()`/`permissionMatches()`/
`legacyRoleToRoleKeys()` reuse করে — Rule 4, কোনো দ্বিতীয়
permission-resolution path না), কিন্তু ভিন্ন প্রশ্ন করে: subject-এর
effective grants একটা caller-সরবরাহকৃত fixed `permissionKeys` তালিকার
**যেকোনো একটার** সাথে মেলে কিনা — `request.action` একদম touch করে না।
`rbac-rule.ts`-এর মতোই **ABSTAIN, না EXPLICIT DENY**, যখন কোনোটাই মেলে না
— যাতে পরের কোনো rule (ownership, ReBAC) একই request অন্য কোনোভাবে এখনো
grant করার সুযোগ পায়। `lib/policy/rbac/index.ts` barrel থেকে re-export
করা হলো (`createRbacRule`-এর পাশেই)।

### একটা shared `RbacProvider` singleton — `middlewares/auth.ts`-এ
`getPepRbacProvider()`: `DrizzleRbacProvider`-এর lazily-constructed একটা
instance, PEP layer-এর প্রতিটা নতুন check-এর জন্য reuse হয় (stateless
wrapper, তাই একটাই instance যথেষ্ট — `adminRoleCheck`/`devRoleCheck`-এর
নিজের "cheap to build, build once" posture-ই এখানে অনুসরণ করা হলো)।
এটা ইচ্ছাকৃতভাবে `lib/policy-admin-console.ts`/`lib/rbac-admin-console.ts`/
`lib/resource-admin-console.ts`-এর নিজের নিজের internal authorizer-এর
জন্য বানানো instance থেকে **আলাদা** (এই ফাইল অন্য module-এর private
singleton-এ হাত দেয় না) — কিন্তু একই DB table পড়ে, তাই দুই layer কখনোই
ভিন্ন উত্তর দেয় না।

### চারটা console-এই একটা নতুন, ADDITIVE PDP gate — hand-written authorizer সরানো হয়নি
প্রতিটা console-এ `requireDev`-এর ঠিক পরে, existing handler-এর আগে একটা
নতুন middleware বসানো হলো:

| Console | নতুন middleware | PDP mechanism |
|---|---|---|
| `admin-policy-console.ts` | `requirePolicyAdminPepAccess` | `requirePolicy()` + throwaway `PolicyEngine` + `createAnyPermissionRule(["admin.policy.manage", "admin.policy.approve"])` |
| `admin-rbac-console.ts` | `requireRbacAdminPepAccess` | `requirePolicy()` + throwaway `PolicyEngine` + `createAnyPermissionRule(["admin.role.manage", "admin.role.assign"])` |
| `admin-resource-console.ts` | `requireResourceAdminPepAccess` | `requirePermission()` সরাসরি — একটাই flat permission (`admin.resource.manage`), তাই `createAnyPermissionRule()` লাগেনি |
| `authorization-telemetry.ts` | `requireTelemetryReadAccess` | `requirePermission()` সরাসরি — একটা নতুন `admin.telemetry.read` permission (migration 106) |

`lib/policy-admin-console.ts`/`lib/rbac-admin-console.ts`/
`lib/resource-admin-console.ts`-এর ভেতরের hand-written
`assertCanViewPolicies()`/`assertCanViewRbacAdmin()`/
`RbacResourceAdminAuthorizer` — এই কোনোটাই সরানো হয়নি (Rule: কাজ করা
সিস্টেম সরানো হয় না)। প্রতিটা console এখন **দুইটা** independent check
পার হয়: hand-written authorizer (আগের মতোই, request-এর জীবনে যেখানেই
ছিল সেখানেই আছে) + নতুন PEP gate (route-এর একদম সামনে)। এই ফেজের আসল
যোগফল protection না (সেটা আগে থেকেই ছিল) — **observability**: প্রতিটা
console-access decision এখন প্রথমবারের মতো একটা `requestId`/reason
code পায় আর `authorization_audit_log`-এ/`authorization-telemetry`-তে
ধরা পড়ে।

### `admin.telemetry.read` — নতুন permission (migration 106)
`authorization-telemetry.ts`-এর নিজের কেস আলাদা, তাই migration-ও আলাদা
যুক্তিতে: এই route-এর আগে **কোনো** auth middleware ছিল না, তাই এই
ফেজে `requireDev` আর `admin.telemetry.read` একসাথে যোগ হলো। নতুন
`requireDev`-টাই একা বেশি strict check হয়ে না যায় সেজন্য
`admin.telemetry.read` 'dev' আর 'admin' — দুটো role-কেই দেওয়া হয়েছে
(migration 096-এর seed অনুযায়ী `requireDev`-এর নিজের "dev OR admin"
scope-এর সাথে মিলিয়ে) — নতুন PDP-routed check কখনো সামনের role-gate-এর
চেয়ে বেশি strict না হয়।

### বাইরের response shape অপরিবর্তিত
চারটা console-এর প্রতিটার নতুন middleware নিজের `onDeny` পাস করে, ঠিক
যে `{ error: "forbidden", message }`, 403 shape hand-written authorizer
আগে থেকেই ছুড়ত (প্রতিটা console-এর নিজের `sendFailure()`/
`translateFailure()` হেল্পার যা রেন্ডার করত) — caller-এর কাছে দৃশ্যমান
কিছুই বদলায়নি। আজ যে caller পৌঁছাতে পারত, আজও পারে (migration
096/099/104/105-এর seed অনুযায়ী শুধু 'admin' role-ই এই permission-গুলো
ধরে, তার pre-existing `'*'` wildcard দিয়ে) — কোনো নতুন denial, কোনো নতুন
allow তৈরি হয়নি।

### `createAnyPermissionRule()` — কেন Policy/RBAC console-এই দরকার, Resource console-এ না
Policy আর RBAC console দুটোই "manage OR approve"/"manage OR assign" —
দুটো independent permission-এর একটা প্রশ্ন করে, `requirePermission()`-এর
built-in sugar (single fixed action) দিয়ে express করা যায় না — তাই
`requirePolicy()` + একটা throwaway `PolicyEngine` + `createAnyPermissionRule()`।
Resource console-এর নিজের প্রশ্ন একটাই flat permission
(`admin.resource.manage`), তাই `requirePermission()` সরাসরি যথেষ্ট।

## Backend

| ফাইল | পরিবর্তন |
|---|---|
| `lib/policy/rbac/any-permission-rule.ts` | **নতুন** — `createAnyPermissionRule()`, `ANY_PERMISSION_POLICY_ID` |
| `lib/policy/rbac/index.ts` | `./any-permission-rule` re-export যোগ |
| `middlewares/auth.ts` | `DrizzleRbacProvider`/`RbacProvider` import; `getPepRbacProvider()` singleton getter যোগ |
| `routes/admin-policy-console.ts` | `requirePolicyAdminPepAccess` (নতুন) `requireDev`-এর পরে প্রতিটা route-এ যোগ; কোনো handler body বদলায়নি |
| `routes/admin-rbac-console.ts` | `requireRbacAdminPepAccess` (নতুন) `requireDev`-এর পরে প্রতিটা route-এ যোগ; কোনো handler body বদলায়নি |
| `routes/admin-resource-console.ts` | `requireResourceAdminPepAccess` (নতুন) `requireDev`-এর পরে প্রতিটা route-এ যোগ; কোনো handler body বদলায়নি |
| `routes/authorization-telemetry.ts` | `requireDev` + `requireTelemetryReadAccess` (দুটোই নতুন) দুটো route-এই যোগ — আগে কোনো auth middleware ছিল না |
| `migrations/106_ayzen_telemetry_read_permission.sql` | **নতুন** — `admin.telemetry.read` permission-catalog entry, 'dev'/'admin' দুটো role-কেই grant |
| `scripts/src/test-policy-rbac.ts` | `createAnyPermissionRule()`/`ANY_PERMISSION_POLICY_ID` import যোগ; ৫টা নতুন test — ALLOW (প্রথম permission), ALLOW (দ্বিতীয় permission), abstain/default-DENY (কোনোটাই না), abstain-এর পর পরের rule ALLOW করতে পারে, unauthenticated subject rule-এ পৌঁছায় না |

## এখনো যা বাকি (roadmap-এর নিজের ভাষায়, ইচ্ছাকৃতভাবে এই ফেজের বাইরে)
- Season C (mechanical sweep) — বাকি non-admin legacy route-গুলো এখনো
  শুধু `requireAuth`/`requireAdmin`/`requireRoles` (Phase A2-এর shim-এর
  ভেতর দিয়ে PDP-তে যায়, কিন্তু route-ভিত্তিক কোনো নতুন ownership/ABAC
  check নেই)।
- `PolicyRegistry.transitionStatus()`-এর নিজের dynamic
  manage-vs-approve-by-target-status split (উদাহরণ: draft policy শুধু
  manage দিয়ে যায়, কিন্তু active-এ promote করতে approve লাগে) —
  `createAnyPermissionRule()`-এর নতুন PEP gate সেই finer-grained logic
  ডুপ্লিকেট করে না, শুধু একটা coarser "is this actor even eligible for
  this console at all" প্রশ্ন করে। ওই dynamic split এখনো শুধু
  `PolicyRegistry` নিজেই owns করে।

## Rollout
নতুন কোনো env var লাগেনি। migration 106 চালানো লাগবে (105-এর পরে,
idempotent, safe to re-run)। Behavior-wise ADDITIVE — migration 096-এর
seed অনুযায়ী আজকে যে caller-রা এই চারটা console-এ পৌঁছাতে পারত
('admin' role, তার `'*'` wildcard দিয়ে), তারা আজও ঠিক একই ভাবে পারবে;
যারা আগে denied হতো তারা আজও denied হবে, একই status code, একই body।

## যা টেস্ট করা হয়েছে
- এডিট করা প্রতিটা ফাইলের উপর standalone `tsc --noEmit --skipLibCheck
  --ignoreConfig` চালানো হয়েছে (node_modules ইনস্টল করা নেই বলে
  project-mode-এর বদলে) — বাকি থাকা প্রতিটা error module-resolution-জনিত
  (`@workspace/db`, `express`, `drizzle-orm`, `jsonwebtoken`, `pino`,
  `node:crypto` — এগুলো এই ফেজের আগে থেকেই একই কারণে fail করত,
  pre-existing) — নতুন/edited কোডের নিজের কোনো type/syntax error নেই।
- `createAnyPermissionRule()`-এর নিজের ৫টা নতুন unit test
  (`scripts/src/test-policy-rbac.ts`, `npx tsx
  scripts/src/test-policy-rbac.ts` দিয়ে রান করা যায়) — ALLOW উভয় দিক
  থেকে, abstain/default-DENY, deny-না-করা (পরের rule ALLOW করতে পারে),
  unauthenticated subject।
- প্রতিটা import (`getPepRbacProvider`, `pepDecisionObserver`,
  `POLICY_MANAGE_PERMISSION`/`POLICY_APPROVE_PERMISSION`,
  `ROLE_MANAGE_PERMISSION`/`ROLE_ASSIGN_PERMISSION`,
  `RESOURCE_GRANT_MANAGE_PERMISSION`, `createAnyPermissionRule`) সোর্স
  ফাইলে গিয়ে সরাসরি চেক করা হয়েছে যে সংশ্লিষ্ট নামে export আসলেই আছে।
