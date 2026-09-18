# AYZEN Policy & Authorization Mega Engine — Phase 04: ReBAC

## এই পাসে যা তৈরি হলো

Roadmap-এর Phase 04 লাইন-বাই-লাইন কভার করা হয়েছে: সাতটা relation kind
(owner/member/manager/viewer/editor/approver/auditor), একটা generic
`(subject, relation, resource_type, resource_id)` ডেটা মডেল, "relationship
resolver abstraction" যেটা roadmap স্পষ্টভাবে চেয়েছিল, আর engine-এ প্লাগ হওয়া
একটা real `PolicyRule` — কিন্তু Phase 05 (ABAC)/06 (DSL)/07 (Registry)-এর
কোনো কিছুই না (Rule 16)।

| ফাইল | কী করে |
|---|---|
| `lib/db/src/schema/relationships.ts` (**নতুন**) | `relationships` টেবিল — একটাই generic টেবিল যেকোনো relation kind × যেকোনো relation target (organization/team/vault/ভবিষ্যতের যেকোনো resource type)-এর জন্য। `resource_grants.ts`-এর ঠিক একই প্যাটার্ন (TEXT resource_id, কোনো FK না, `expiresAt` এখনো নেই), কিন্তু unique index-টা **চার কলামের পুরো tuple**-এর ওপর (subject+resource+relation) — কারণ একই subject একই resource-এ একাধিক relation রাখতে পারে (যেমন কেউ একসাথে `member` আর `manager` হতে পারে) — এইটা `resource_grants`-এর থেকে আলাদা, যেখানে একটা tuple-এর একটাই effect থাকতে পারে। |
| `migrations/098_ayzen_relationships.sql` (**নতুন**) | উপরের টেবিলের migration — idempotent, কোনো seed data নেই (097-এর মতো একই যুক্তি: বাস্তব resource row ছাড়া relationship অর্থহীন)। |
| `lib/policy/rebac/types.ts` (**নতুন**) | `RELATION_KINDS` (সাতটা kind-এর closed vocabulary) + `RelationshipProvider` interface — `RbacProvider`/`ResourceGrantProvider`-এর সমান্তরাল read-only contract। |
| `lib/policy/rebac/relation-action-map.ts` (**নতুন**) | `actionVerb()` (action string-এর trailing segment বার করে) + `relationGrantsAction()` — প্রতিটা relation kind কোন verb-class (read/write/approve/manage) কভার করে তার একটা fixed, reviewed টেবিল। এইটাই আসলে Phase 04-কে অর্থবহ করে তোলে — নাহলে সাতটা relation থেকেও 3A/3C-এর মতো blanket allow হতো। |
| `lib/policy/rebac/relationship-resolver.ts` (**নতুন**) | `resolveRelations()` — roadmap-এর নির্দিষ্ট করা "relationship resolver abstraction"। এইটাই একমাত্র জায়গা যেখানে `RelationshipProvider` কল হয়; storage থেকে আসা string-গুলোকে `RELATION_KINDS`-এর বিপরীতে narrow/filter করে (malformed/অচেনা relation string থাকলে সেটা চুপচাপ বাদ পড়ে, trust করা হয় না — fail-closed)। |
| `lib/policy/rebac/rebac-rule.ts` (**নতুন**) | `createRebacRule()` — engine-এর পঞ্চম real `PolicyRule`। resolver দিয়ে subject-এর relation-গুলো আনে, তারপর `relationGrantsAction()` দিয়ে action কভার হয় কিনা দেখে। কভার করলে ALLOW; না করলে (relation থাকা সত্ত্বেও action না মিললে, বা কোনো relation-ই না থাকলে) **abstain** — কখনো explicit DENY রিটার্ন করে না (ownership-rule.ts/organization-access-rule.ts-এর মতোই একমুখী)। |
| `lib/policy/rebac/drizzle-relationship-provider.ts` (**নতুন**) | Real `@workspace/db`-backed provider। `rebac/index.ts`-এর বাইরে রাখা হয়েছে (rbac/resource-এর Drizzle provider-দের ঠিক একই কারণে)। |
| `lib/policy/rebac/index.ts` (**নতুন**) | Barrel — Drizzle provider বাদে সবকিছু re-export করে। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./rebac` যোগ হলো টপ-লেভেল ব্যারেলে। |
| `lib/db/src/schema/index.ts` (**পরিবর্তিত**) | `./relationships` যোগ হলো। |
| `scripts/src/test-policy-rebac.ts` (**নতুন**) | ২২টা DB-free টেস্ট। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **কেন relation kind-ভিত্তিক action-verb ম্যাপিং লাগলো, যেখানে 3A/3C blanket allow ছিল।** 3A (ownership) আর 3C (organization-access) দুটোরই CHANGES doc স্পষ্ট বলেছে "per-role-within-organization granularity (member vs manager vs viewer) হলো Phase 04-এর কাজ"। সাতটা আলাদা relation নাম দিয়ে যদি সবগুলোই blanket allow করে দিতাম, তাহলে সেই deferred grain-টা কখনোই আসতো না — তাই `relation-action-map.ts`-এর ফিক্সড টেবিলটা এই ফেজের আসল কাজ, শুধু একটা পাশের ডিটেইল না। এটা ইচ্ছাকৃতভাবে এখনো Phase 05 (ABAC)-এর মতো general attribute/operator ইঞ্জিন না, আর Phase 06-এর মতো configurable DSL-ও না — একটা ছোট, রিভিউড, ফিক্সড vocabulary মাত্র (Rule 16)।
- **কোনো নতুন reason code লাগেনি।** ownership-rule.ts/organization-access-rule.ts-এর মতোই generic `EXPLICIT_ALLOW` ব্যবহার করা হয়েছে, `policyId: "rebac"` দিয়ে audit log-এ আলাদা করে চেনা যায়।
- **একই subject একই resource-এ একাধিক relation রাখতে পারে** — `resource_grants`-এর "একটা tuple-এর একটাই effect" নীতির উল্টো। DB schema-র unique index এটা মাথায় রেখে চার কলামের পুরো tuple কভার করে (দেখুন schema ফাইলের হেডার)। Test suite-এ এটা সরাসরি টেস্ট করা হয়েছে (member + approver একসাথে থাকলে approve কাজ করে, শুধু member থাকলে করে না)।
- **Resolver storage থেকে আসা string fail-closed ভাবে filter করে** — malformed/future relation string থাকলে সেটা silently drop হয়, trust করা হয় না। এইটা `drizzle-resource-grant-provider.ts`-এর malformed `effect` column-এর সাথে ঠিক একই posture।
- **ABSTAIN, কখনো DENY না** — RBAC role grant বা explicit resource grant এখনো একটা non-matching-relation subject-কে allow করতে পারবে; rebac rule শুধু একটা নতুন ALLOW path যোগ করে, শেষ কথা বলে না।
- **কোনো route/service এখনো এই রুল ব্যবহার করছে না** — grep করে কনফার্ম করা হয়েছে (RBAC/3A/3B/3C-এর মতোই additive, unwired surface area)।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে
- `npx tsx scripts/src/test-policy-rebac.ts` — **২২/২২ পাস**।
- রিগ্রেশন: 1A/1B(PIP)/1C(observer)/02(RBAC)/3A/3B/3C — সব কয়টা suite এই পাসে আবার রান করে কনফার্ম করা হয়েছে, কোনো রিগ্রেশন নেই।
- `scripts/src/test-oidc-dynamic-client-redirect-uri-policy.ts` একটা pre-existing, সম্পূর্ণ-অসম্পর্কিত failure দেখাচ্ছে ("a fragment is rejected" assertion) — এই ফেজের কোনো ফাইলের সাথে এর কোনো সম্পর্ক নেই (grep করে কনফার্ম করা হয়েছে, এই টেস্টটা OIDC redirect-URI validation নিয়ে, policy/rebac-এর কিছুই import করে না), এবং এই পাসের আগেও একই কারণে fail করতো।
- এই রুল সম্পূর্ণ DB-free (rebac-rule.ts/relation-action-map.ts/relationship-resolver.ts/types.ts), তাই sandbox-এর network/node_modules সীমাবদ্ধতা এটাকে প্রভাবিত করে না — পুরোটাই সরাসরি `tsx`-এ রান করে ভেরিফাই করা হয়েছে।

## Security tests কভার করা হয়েছে
- **IDOR / resource-ID substitution:** id=42-এ scoped relation অন্য কোনো id-তে leak করে না (forged/substituted id সহ), আর একই id-তে ভিন্ন resource type-এ leak করে না।
- **Cross-user:** alice-কে দেওয়া relation bob-এর কাছে extend হয় না।
- **Tenant isolation:** organization A-তে member থাকা subject organization B-এর (একই shape-এর, ভিন্ন id-র) resource-এ কোনো access পায় না।
- **Privilege escalation:** resource-এর অপ্রাসঙ্গিক field forge করলে relation match তৈরি হয় না; আর — এই ফেজের নিজস্ব নতুন আক্রমণ-ভেক্টর — শুধু action string-এর নাম বদলে (`viewer` থেকে `manage`/`delete`/`approve`/`update`-এ escalate করার চেষ্টা) কোনো লাভ হয় না, কারণ `relationGrantsAction()` fail-closed।
- **Fail-closed on malformed storage data:** resolver-এর মাধ্যমে অচেনা relation string silently dropped হয় (trusted হয় না), একা এবং একটা real relation-এর সাথে মিশ্রিত অবস্থায় — দুইভাবেই টেস্ট করা।
- **Unauthenticated subject** কখনো এই রুল পর্যন্ত পৌঁছায় না।
- **Composition:** rebac ALLOW কখনো locked-resource DENY বা resource-grant DENY-কে হারায় না (deny-overrides, registration-order-independent); ownership আর rebac দুটোই abstain করলে default deny-তে পড়ে।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি
- বাস্তব org/team-membership writer — `relationships` টেবিলে কিছুই এখনো লেখে না (কোনো admin-console/org-management ফিচার এখনো নেই)। Migration-এ কোনো seed data নেই।
- Attribute/operator ভিত্তিক শর্ত (equals/IN/time-comparison ইত্যাদি) — Phase 05 (ABAC)।
- Declarative policy language, priority/precedence system — Phase 06/07/08।
- Approval/separation-of-duties সেমান্টিক্স যেখানে `approver` relation একটা প্রধান ভূমিকা রাখতে পারে — Phase 12/13, শুধু নাম রাখা হয়েছে (relation-action-map.ts-এর হেডার দেখুন), কিছু বাস্তবায়ন করা হয়নি।
- কোনো route/service এখনো এই রুল ব্যবহার করছে না — grep করে কনফার্ম করা হয়েছে।
- `tsc --build` দিয়ে টাইপচেক — এই sandbox-এ network/`node_modules` না থাকায় সম্ভব হয়নি (Phase 02/03-এর Drizzle provider ফাইলগুলোর ঠিক একই known limitation — দেখুন সেই CHANGES doc-গুলো)। নতুন ফাইলগুলো বিদ্যমান ফাইলগুলোর টাইপ-প্যাটার্ন হুবহু অনুসরণ করে লেখা হয়েছে (`db, relationshipsTable` from `@workspace/db`; `and`/`eq` from `drizzle-orm`), কিন্তু বাস্তব `tsc` রান দিয়ে যাচাই করা যায়নি।

## PHASE STATUS
- **Implemented:** ReBAC — সাতটা relation kind, relation→action-verb ম্যাপিং, relationship resolver abstraction, engine-এ প্লাগযোগ্য `PolicyRule`।
- **Files changed:** `lib/policy/index.ts`, `lib/db/src/schema/index.ts`।
- **Files added:** `lib/db/src/schema/relationships.ts`, `migrations/098_ayzen_relationships.sql`, `lib/policy/rebac/types.ts`, `lib/policy/rebac/relation-action-map.ts`, `lib/policy/rebac/relationship-resolver.ts`, `lib/policy/rebac/rebac-rule.ts`, `lib/policy/rebac/drizzle-relationship-provider.ts`, `lib/policy/rebac/index.ts`, `scripts/src/test-policy-rebac.ts`।
- **Database changes:** নতুন `relationships` টেবিল (migration 098) — কোনো বিদ্যমান টেবিল স্পর্শ করা হয়নি।
- **Tests:** ২২/২২ পাস (`npx tsx scripts/src/test-policy-rebac.ts`)।
- **Security tests:** IDOR/resource-ID substitution, cross-user, tenant isolation, privilege escalation (forged fields + action-relabeling), fail-closed malformed-storage-data, unauthenticated-subject, composition/deny-overrides — সবগুলো কভার।
- **Known limitations:** কোনো org/team-membership writer নেই এখনো, তাই বাস্তবে `relationships` টেবিল খালি থাকবে যতক্ষণ না একটা future admin-console/org-management ফেজ ডেটা পপুলেট করে। sandbox-এ `tsc --build` চালানো যায়নি (network/node_modules নেই — বিদ্যমান Drizzle provider ফাইলগুলোর একই সীমাবদ্ধতা)। `test-oidc-dynamic-client-redirect-uri-policy.ts`-এ একটা pre-existing, সম্পূর্ণ-অসম্পর্কিত failure আছে (এই ফেজের আগে থেকেই, policy/rebac-এর সাথে সম্পর্কহীন)।
- **Regression status:** 1A/1B/1C/02/3A/3B/3C — রিগ্রেশন নেই।
- **Next phase:** Phase 04 সম্পূর্ণ। Rule 15 অনুযায়ী এই রিপোর্ট রিভিউ হওয়া উচিত Phase 05 (ABAC) শুরু করার আগে। মনে রাখা দরকার: roadmap-এর নিজস্ব "AUDIT GATES" তালিকায় Phase 05 শেষ হওয়ার পর একটা আনুষ্ঠানিক Architecture + Security Audit ধার্য করা আছে — অর্থাৎ Phase 05 শুরু করা যাবে, কিন্তু Phase 05 শেষে (Phase 06 শুরুর আগে) সেই audit gate-টা মিস করা যাবে না।

**এই পাস এখানেই থামছে (Rule 16) — Phase 05 (ABAC) স্বয়ংক্রিয়ভাবে শুরু হচ্ছে না।**
