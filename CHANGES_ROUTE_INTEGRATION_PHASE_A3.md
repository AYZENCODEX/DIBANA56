# Route Integration Roadmap — Season A, Phase A3: Telemetry Hookup

## যা আগে থেকেই ছিল
- Phase A2 `requireAdmin`/`requireDev`/`requireRoles()`-এর ভেতরের role-check
  `requireRole()` (PDP-backed, `lib/policy/pep/middleware.ts`)-এ সরিয়ে দিয়েছিল
  — প্রতিটা call এখন একটা real `AuthorizationDecision` বানায়।
- কিন্তু `requireRole()` (আর `requirePermission()`/`requireOwnership()`/
  `requireStepUp()`/`requireApproval()`) প্রতিটাই ভেতরে ভেতরে নিজের একটা
  throwaway `new PolicyEngine()` বানায় — **কোনো `options` ছাড়াই**। যাচাই করে
  দেখা গেছে, পুরো অ্যাপে **একটাও** `PolicyEngine` construction site
  `onDecision` পাস করে না (`grep -rn "new PolicyEngine("` — সবক'টা call
  `lib/policy/pep/middleware.ts`-এর ভেতরেই, প্রতিটাই আর্গুমেন্টবিহীন)। ফলে
  Phase A2-এর পরেও ১০৬টা legacy route-এর একটা decision-ও কোথাও observe হতো
  না — না কোনো metric, না কোনো audit row।
- `routes/authorization-telemetry.ts` (Phase 24) আগে থেকেই
  `lib/policy/observability/runtime-registries.ts`-এর
  `metricsRegistry`/`accessPatternRegistry` singleton pair পড়ে dashboards/
  Prometheus output বানাত — কিন্তু সেই ফাইলের নিজের হেডারই সৎভাবে লিখে
  রেখেছিল: "nothing routes through them yet ... requestsTotal: 0" — কোনো
  real engine কখনো এই registry-দুটোতে লেখেনি।
- `lib/policy/audit/drizzle-audit-writer.ts` (Phase 17)-এর
  `DrizzleAuthorizationAuditWriter` — `authorization_audit_log` টেবিলে সত্যিকার
  DB row লেখার একমাত্র implementation — আগে থেকেই সম্পূর্ণ আর টেস্ট করা ছিল,
  কিন্তু নিজের হেডারেই বলা ছিল "nothing in the app constructs
  `DrizzleAuthorizationAuditWriter` yet"।

## একটা সংশোধন (roadmap doc-এর একটা claim নিয়ে)
Roadmap doc-এ লেখা ছিল telemetry এখন শুধু "console/oidc-resource"-এ আছে।
কোড পড়ে দেখা গেছে এটা ঠিক না: `routes/oidc-resource.ts` আসলে
`lib/oidc-scope-enforcement.ts`-এর `requireOidcScope()` ব্যবহার করে, যেটা
`PolicyEngine`/PEP একদম touch-ই করে না (grep করে confirm করা হয়েছে — ওই
ফাইলে `PolicyEngine`/`policy-engine`/`pep/`-এর কোনো import নেই) — এটা একটা
সম্পূর্ণ আলাদা OIDC-scope check mechanism, PDP-র অংশ না। আর
`routes/admin-policy-console.ts` policy **definitions**/versions manage করে
(`lib/policy-admin-console.ts` দিয়ে) — কোনো decision/audit data পড়ে না,
তাই telemetry hookup তার output বদলাবে না। এই ফেজ তাই `admin-policy-console`
touch করেনি — এটা roadmap doc-এর একটা imprecision, ইচ্ছাকৃত scope-cut না।

## যেটা যোগ করা হলো (Phase A3)

### ১. `lib/policy/pep/*` একটা generic pass-through seam পেল, কোনো DB import ছাড়াই
`lib/policy/pep/index.ts`-এর নিজের হেডার স্পষ্ট করে বলে: এই ডিরেক্টরি কখনো
সরাসরি `@workspace/db` import করে না — যেকোনো real DB-backed provider
caller নিজে বানিয়ে পাস করে। এই invariant রক্ষা করেই `PepMiddlewareOptions`
(`pep/types.ts`)-এ একটা নতুন optional ফিল্ড যোগ হলো:

```ts
onDecision?: PolicyDecisionObserver;
```

আর `pep/middleware.ts`-এর ৫টা internal engine-construction site
(`requirePermission`, `requireOwnership`, `requireRole`, `requireStepUp`,
`requireApproval`) — প্রতিটাতে `new PolicyEngine()` বদলে
`new PolicyEngine({ onDecision: options.onDecision })` করা হলো। `options`
প্রতিটা ফাংশনেই already parameter হিসেবে ছিল (Phase 19 থেকেই) — শুধু সেই
একটা field এখন engine constructor পর্যন্ত পৌঁছায়। `requirePolicy()` (fully
generic, caller-supplied engine) touch করা হয়নি — সেটা caller-এর নিজের
engine, caller নিজের `onDecision` নিজের construction site-এ ঠিক করবে।

### ২. `middlewares/auth.ts` — একমাত্র real call site যেটা concrete observer বানায়
`lib/policy/audit/index.ts`-এর নিজের কথায়: "Import `./audit/drizzle-audit-writer`
directly at the one real call site that actually constructs it।" এই ফেজে
`middlewares/auth.ts`-ই সেই জায়গা — module load-এ একবার বানানো হলো:

```ts
const pepDecisionObserver = composeObservers(
  authorizationObserver,                                              // Phase 24 — metrics + access-pattern (DB-free)
  createAuthorizationAuditObserver(new DrizzleAuthorizationAuditWriter()), // Phase 17 — durable DB row
);
```

তারপর `adminRoleCheck`/`devRoleCheck` (module-level, একবার বানানো) আর
`requireRoles(...)`-এর ভেতরের per-call `roleCheck` — তিনটাতেই `onDeny`-র
পাশে `onDecision: pepDecisionObserver` যোগ করা হলো। `onDeny` অপরিবর্তিত —
Phase A2-এর response shape guarantee এই ফেজেও অক্ষত থাকে।

### ফলাফল
- `routes/authorization-telemetry.ts`-এর dashboards/Prometheus output এখন
  real decision data দেখাবে (permanently-zero placeholder না) — ১০৬টা
  legacy route-এর প্রতিটা `requireAdmin`/`requireDev`/`requireRoles(...)`
  call এখন `metricsRegistry`/`accessPatternRegistry`-তে গণনা হয়।
- প্রতিটা সেই decision `authorization_audit_log` টেবিলে একটা durable row
  হিসেবে persist হয় — Phase 17 বানানোর পর প্রথমবার সত্যিকার ব্যবহৃত হলো।
- কোনো route file touch হয়নি — ১০৬টা route এখনো একই `requireAdmin`/
  `requireRoles(...)` import করে, ঠিক Phase A2-এর মতোই।

### Backend
| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/lib/policy/pep/types.ts` | `PepEnrichmentOptions`-এ নতুন optional `onDecision?: PolicyDecisionObserver` ফিল্ড; `PolicyDecisionObserver` টাইপ `../policy-engine` থেকে import |
| `artifacts/api-server/src/lib/policy/pep/middleware.ts` | ৫টা internal `new PolicyEngine()` কল-ই `new PolicyEngine({ onDecision: options.onDecision })`-এ বদলানো (`requirePermission`, `requireOwnership`, `requireRole`, `requireStepUp`, `requireApproval`); file header-এ Phase A3 note যোগ; `requirePolicy()` অপরিবর্তিত |
| `artifacts/api-server/src/middlewares/auth.ts` | `composeObservers`/`authorizationObserver` (`../lib/policy/observability`), `createAuthorizationAuditObserver` (`../lib/policy/audit`), `DrizzleAuthorizationAuditWriter` (`../lib/policy/audit/drizzle-audit-writer`, সরাসরি ফাইল থেকে — barrel-এ excluded) import; module-level `pepDecisionObserver` const; `adminRoleCheck`/`devRoleCheck`/`requireRoles()`-এর `roleCheck` — প্রতিটাতে `onDecision: pepDecisionObserver` যোগ |

**কোনো route file touch করা হয়নি।**

## এখনো যা যোগ হয়নি (ইচ্ছাকৃতভাবে, পরের ফেজ)
- `requirePermission()`/`requireOwnership()`/`requireStepUp()`/
  `requireApproval()` এখন `onDecision` support করে, কিন্তু `routes/*.ts`-এর
  কেউ এখনো এদের call করে না (Season B শুরু হয়নি) — তাই এদের জন্য এখনো কোনো
  real traffic নেই observe করার মতো। যেদিন Season B (finance ownership,
  vault step-up) শুরু হবে, সেই route-গুলো নিজেদের PEP call-এ
  `onDecision: pepDecisionObserver`-এর মতো কিছু pass করলেই টেলিমেট্রি পাবে
  — এই ফেজ শুধু সেই সেতুটা বানিয়ে রাখল।
- `routes/admin-policy-console.ts` অপরিবর্তিত — উপরে ব্যাখ্যা করা হয়েছে কেন।
- `authorization_audit_log`-এ এখন row লেখা হচ্ছে, কিন্তু সেই টেবিল পড়ে দেখানোর
  মতো কোনো admin UI/route এখনো নেই — শুধু raw DB access দিয়ে দেখা যাবে। একটা
  "audit log viewer" route বানানো এই ফেজের কাজ ছিল না (Rule 16 — future
  phase-এর কাজ আগেই করা যাবে না), roadmap doc-ও এমন কিছু চায়নি।

## Rollout
কোনো নতুন env var লাগেনি — `DrizzleAuthorizationAuditWriter` যে `@workspace/db`
ব্যবহার করে, সেই `DATABASE_URL` অ্যাপ এমনিতেই boot করার জন্য লাগে (অন্য
routes/providers আগে থেকেই DB-নির্ভর)। কোনো নতুন migration লাগেনি —
`authorization_audit_log` টেবিল Phase 17-এই বানানো হয়েছিল, শুধু এই ফেজে
প্রথমবার তাতে সত্যিকার লেখা শুরু হলো। Response shape (status code, body)
প্রতিটা route-এর জন্য অপরিবর্তিত — এই ফেজ শুধু observability যোগ করেছে,
decision-making বা রেসপন্স রেন্ডারিং কিছুই বদলায়নি।

## যা টেস্ট করা হয়েছে
- তিনটা edited ফাইলের bracket/brace/paren balance একটা ছোট script দিয়ে
  চেক করা হয়েছে (string/template-literal/comment-aware scanner) — তিনটাতেই
  stack খালি, কোনো mismatch নেই।
- নতুন প্রতিটা import আসলেই export হিসেবে বিদ্যমান কিনা grep করে যাচাই করা
  হয়েছে: `composeObservers`/`authorizationObserver`
  (`lib/policy/observability`), `createAuthorizationAuditObserver`
  (`lib/policy/audit`), `DrizzleAuthorizationAuditWriter`
  (`lib/policy/audit/drizzle-audit-writer.ts`)।
- `lib/policy/**`-এর কোনো ফাইল `middlewares/auth.ts` সরাসরি `import` করে কিনা
  আবার grep করে যাচাই করা হয়েছে (Phase A2-এর মতোই) — শুধু comment-এ
  reference, কোনো circular import নেই।
- `pep/authorize.ts` কীভাবে `enrichment: PepMiddlewareOptions` পড়ে তা দেখা
  হয়েছে — শুধু `.pip`/`.pipTimeoutMs` access করে, তাই নতুন `onDecision` ফিল্ড
  inert (কোনো conflict নেই)।
- পুরো `artifacts/api-server/src` ট্রি-র উপর একটা scratch root-level
  `tsconfig` (base config extend করে) দিয়ে `tsc --noEmit` চালানো হয়েছে
  (৩৯২৬টা ফাইল listed)। `node_modules` install না থাকায় প্রতিটা ফাইলেই
  `express`/`@workspace/db`-এর মতো module-not-found noise আসে (Phase A2-এর
  CHANGES doc-এও একই expected limitation লেখা আছে) — তিনটা edited ফাইলে
  filter করে দেখা গেছে **শুধু** `Cannot find module 'express'`
  (project-wide ১৬৫ বার আসা একই noise) ছাড়া আর কোনো error নেই; আমাদের নতুন
  কোনো সিম্বল (`onDecision`, `pepDecisionObserver`, `composeObservers`,
  `authorizationObserver`, `createAuthorizationAuditObserver`,
  `DrizzleAuthorizationAuditWriter`, `PolicyDecisionObserver`) নিয়ে কোনো
  error ওঠেনি — পুরো output-এ grep করে ওই নামগুলো কোথাও error-এ আসেনি তা
  নিশ্চিত করা হয়েছে।
- Type-level reasoning: `composeObservers(...)` আর `createAuthorizationAuditObserver(...)`
  দুটোই সরাসরি `PolicyDecisionObserver` রিটার্ন করে (কোনো arity-mismatch
  concern নেই, Phase A2-এর `onDeny` callback-এর মতো কম-প্যারামিটার সমস্যা
  এখানে প্রযোজ্য না — এখানে টাইপ হুবহু মেলে) — তাই
  `PepMiddlewareOptions.onDecision`-এ সরাসরি assignable।
