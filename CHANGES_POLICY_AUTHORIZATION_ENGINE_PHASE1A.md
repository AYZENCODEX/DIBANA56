# AYZEN Policy & Authorization Mega Engine — Phase 01, Sub-phase 1A: Foundation / PDP Core

## যা আগে থেকেই ছিল
- Authorization এখন পর্যন্ত ছড়ানো — প্রতিটা route নিজে নিজে `req.user`/role চেক করে (`auth-utils.ts`-এর `isAdminAsync`, প্রতি route ফাইলে ইনলাইন `if (role !== "admin") ...`, ইত্যাদি)।
- কোনো centralized decision point নেই — কোনো একটা জায়গায় গিয়ে "এই subject কি এই action এই resource-এ করতে পারবে?" জিজ্ঞেস করার উপায় নেই।
- Authentication (WHO are you — JWT/session/OIDC/passkey) আগে থেকেই শক্তভাবে আছে (RS256 JWT, sessions.ts, passkey.ts, OIDC roadmap Season 1-5)। এই ফেজ সেটা **রিপ্লেস করে না** — শুধু তার ওপর একটা আলাদা "WHAT may you do" স্তর বসানোর ভিত্তি তৈরি করে।

## যেটা যোগ করা হলো (Phase 1A)
শুধু PDP (Policy Decision Point)-এর core — roadmap-এর target architecture-এর এই অংশটুকু:

```
Identity → PIP → PDP/Policy Engine → Decision → PEP → Business Action → Audit
                  ^^^^^^^^^^^^^^^^
                  এই ফেজে শুধু এইটুকু
```

কোনো route, কোনো middleware, কোনো `app.ts` — কিছুই টাচ করা হয়নি। এই মডিউল সম্পূর্ণ standalone, কোনো কিছুতে wire করা নেই। Import করলেও কিছু ব্যবহার না করলে বাকি অ্যাপের বিহেভিয়ার একবিন্দুও বদলায় না (roadmap-এর "Foundation works independently and existing routes remain unchanged" exit criteria)।

### Backend
| ফাইল | কী আছে |
|---|---|
| `artifacts/api-server/src/lib/policy/types.ts` | **নতুন** — `Subject` (existing `getUserFromToken()`-এর shape-এর ওপর ভিত্তি করে: userId/role/authType/keyType/scopes), `ResourceRef`, `PolicyContext`, `AuthorizationRequest`, `DecisionEffect`, `AuthorizationDecision` |
| `artifacts/api-server/src/lib/policy/decision-reasons.ts` | **নতুন** — `DecisionReasonCode` closed vocabulary (NO_MATCHING_POLICY, EXPLICIT_DENY, EXPLICIT_ALLOW, INVALID_AUTHORIZATION_CONTEXT, POLICY_EVALUATION_ERROR, UNAUTHENTICATED + future STEP_UP_REQUIRED/APPROVAL_REQUIRED) |
| `artifacts/api-server/src/lib/policy/policy-errors.ts` | **নতুন** — `InvalidAuthorizationContextError`, `PolicyEvaluationError` (internal-only, engine নিজেই catch করে) |
| `artifacts/api-server/src/lib/policy/policy-context.ts` | **নতুন** — `createPolicyContext()`, correlation ID (`randomUUID()`) generate/propagate করার একমাত্র জায়গা |
| `artifacts/api-server/src/lib/policy/authorization-request.ts` | **নতুন** — `buildAuthorizationRequest()`: subject/action/resource শেপ ভ্যালিডেট করে, invalid হলে `InvalidAuthorizationContextError` থ্রো করে |
| `artifacts/api-server/src/lib/policy/authorization-decision.ts` | **নতুন** — `allow()`/`deny()`/`stepUp()`/`approvalRequired()` factory helper, প্রতিটা decision-এ requestId + evaluatedAt consistent-ভাবে stamp করে |
| `artifacts/api-server/src/lib/policy/policy-engine.ts` | **নতুন** — `PolicyEngine` ক্লাস: `registerRule()`/`unregisterRule()`/`evaluate()`। Deny-overrides combining, default-deny (rule 7), fail-closed (rule 8), deterministic (rule 12) |
| `artifacts/api-server/src/lib/policy/index.ts` | **নতুন** — barrel export, ভবিষ্যৎ ফেজ ও route-এর জন্য একটাই import path (`./lib/policy`) |
| `scripts/src/test-policy-engine.ts` | **নতুন** — DB-free standalone test (existing `test-oidc-client-validation.ts`-এর মতো shape), roadmap-এর Phase 01 test list পুরোটা কভার করে |
| `scripts/package.json` | নতুন script: `pnpm --filter @workspace/scripts policy:test-engine` |

### Combining algorithm (কীভাবে একাধিক rule মিলে এক Decision হয়)
DENY-OVERRIDES:
1. কোনো registered rule DENY দিলে সঙ্গে সঙ্গে সেই DENY রিটার্ন (বাকি rule আর চালানো হয় না)।
2. কোনো DENY না থাকলে, কোনো rule ALLOW দিয়ে থাকলে সেই ALLOW রিটার্ন।
3. কোনো rule কোনো opinion না দিলে (সব `null` রিটার্ন করলে, বা কোনো rule-ই registered না থাকলে) → default DENY, reason `NO_MATCHING_POLICY`।
4. কোনো rule থ্রো করলে → পুরো evaluation-ই DENY (`POLICY_EVALUATION_ERROR`), সেই rule-এর throw বাইরে leak করে না।

Phase 1A-তে **কোনো rule কোথাও register করা নেই** — উপরের algorithm test file-এ ad-hoc test rule দিয়ে যাচাই করা হয়েছে, বাস্তব app-এর কোনো rule এখনো নেই (সেটা Phase 02 — RBAC)।

## যা Phase 1A-তে ইচ্ছাকৃতভাবে করা হয়নি
Roadmap-এর Rule 16 ("Do not implement future phases prematurely") অনুযায়ী:
- **কোনো route/middleware-এ wiring নেই।** `PolicyEngine`-কে Express request-এর সাথে জোড়ার কোনো adapter (PEP) এখনো নেই — সেটা Phase 01-এরই পরের sub-phase বা Phase 02-এর কাজ।
- **RBAC ডেটা মডেল নেই** (roles/permissions/role_permissions/user_roles টেবিল) — Phase 02।
- **Resource/ownership rule নেই** (IDOR-প্রতিরোধ, cross-tenant চেক) — Phase 03।
- **ReBAC (owner/member/manager/...) নেই** — Phase 04।
- **Policy versioning/PAP (admin panel থেকে policy এডিট)** — অনেক পরের ফেজ, এখানে touch করা হয়নি।
- Existing auth stack (`auth-utils.ts`, `jwt.ts`, `sessions.ts`, OIDC roadmap) — **কিছুই বদলানো হয়নি।**

## যা টেস্ট করা হয়েছে
- `npx tsc` দিয়ে নতুন সব ফাইল (`lib/policy/*.ts` + নতুন test script) strict mode-এ (`strictNullChecks`, `noImplicitAny`, ইত্যাদি — প্রজেক্টের `tsconfig.base.json`-এর সমান সেটিংস দিয়ে) টাইপ-চেক করা হয়েছে — **০টা এরর**।
- `npx tsx scripts/src/test-policy-engine.ts` সত্যিকারে রান করে roadmap-এর Phase 01 test list-এর প্রতিটা কেস পাস হয়েছে (এই পাসে node_modules ইনস্টল করা সম্ভব হয়েছে, তাই এবার শুধু syntax-check না — আসল রান):
  - authenticated + allowing rule → ALLOW
  - কোনো rule registered না থাকলে → default DENY
  - সব rule abstain করলে → default DENY
  - unauthenticated subject (`null`) → DENY, এবং কোনো rule-ই call হয় না (assert করে চেক করা হয়েছে)
  - invalid context (খালি action, malformed subject) → DENY (`INVALID_AUTHORIZATION_CONTEXT`)
  - throw করা rule → DENY (`POLICY_EVALUATION_ERROR`), exception বাইরে propagate করে না
  - deny-overrides precedence (ALLOW আগে registered হলেও পরের DENY জেতে)
  - deterministic repeated evaluation (একই input দুইবার evaluate করলে effect/reason/requestId হুবহু এক)
  - correlation ID propagation — caller-supplied ও auto-generated উভয় ক্ষেত্রে, এমনকি invalid-context DENY-তেও
- Grep করে নিশ্চিত করা হয়েছে `artifacts/api-server/src` জুড়ে কোথাও `lib/policy` ইম্পোর্ট করা হচ্ছে না — অর্থাৎ কোনো existing route/middleware/app.ts এখনো এই মডিউল সম্পর্কে জানেই না, রানটাইম বিহেভিয়ার অপরিবর্তিত।

## পরবর্তী ধাপ (এই ফেজের অংশ না, শুধু context-এর জন্য)
Roadmap-এর Rule 15 অনুযায়ী পরের phase (1B বা Phase 02) শুরুর আগে review — এই ফাইলগুলো audit করে দেখা উচিত `PolicyRule` সিগনেচার, combining algorithm, আর reason-code vocabulary ঠিকঠাক লাগছে কিনা, কারণ Phase 02 (RBAC)-এর সব rule এই একই ইন্টারফেসের ওপর বসবে।
