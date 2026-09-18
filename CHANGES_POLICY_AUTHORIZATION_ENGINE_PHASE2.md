# AYZEN Policy & Authorization Mega Engine — Phase 02: RBAC (সম্পূর্ণ)

## যা আগে থেকেই ছিল (আপলোড করা draft ফাইলগুলো থেকে)
Phase 02-এর প্রায় সবটাই আগেই লেখা ছিল — `permission-matcher.ts` (wildcard grammar), `role-resolver.ts` (bounded/cycle-safe inheritance walk), `legacy-role-map.ts` (legacy `users.role` → RBAC role key mapping), `rbac-rule.ts` (আসল `PolicyRule`), `drizzle-rbac-provider.ts` (DB-backed provider), `lib/db/src/schema/rbac.ts` (schema), migration `096_ayzen_rbac_core.sql`, আর `scripts/src/test-policy-rbac.ts` (২৮টা টেস্ট)। কিন্তু দুইটা জিনিস miss ছিল যেগুলো ছাড়া কোনোটাই আসলে compile/run হতো না।

## এই পাসে যা যোগ/ঠিক করা হলো

### ১. দুইটা মিসিং ফাইল তৈরি
| ফাইল | কেন দরকার ছিল |
|---|---|
| `artifacts/api-server/src/lib/policy/rbac/types.ts` (**নতুন**) | `rbac-rule.ts`, `role-resolver.ts`, `drizzle-rbac-provider.ts` — সবগুলোই `import type { RbacProvider } from "./types"` করে, কিন্তু এই ফাইলটা কোথাও ছিল না। `RbacProvider` (৩টা read-only method) আর `RoleRecord` interface এখানে define করা হয়েছে — exactly যেভাবে `test-policy-rbac.ts`-এর `FakeRbacProvider` implement করে। এটা ছাড়া পুরো Phase 02 একটা টাইপ-এরর। |
| `artifacts/api-server/src/lib/policy/rbac/index.ts` (**নতুন**) | মূল `lib/policy/index.ts`-এর কমেন্টেই লেখা ছিল "drizzle-rbac-provider.ts deliberately NOT part of this re-export" — কিন্তু `./rbac` barrel-টাই ছিল না। এখন সেটা তৈরি হয়েছে, ঠিক সেই একই কনভেনশন মেনে (Drizzle provider বাদে বাকি সব re-export)। |

### ২. `lib/db/src/schema/index.ts`-এ একলাইন যোগ
আসল কোডবেস চেক করে দেখা গেল `rolesTable`/`rolePermissionsTable`/`userRolesTable` — এগুলো `@workspace/db` থেকে import হয় (`drizzle-rbac-provider.ts`), আর `@workspace/db` আসলে `export * from "./schema"` করে schema/index.ts-এর সব barrel export চালায়। `schema/rbac.ts` লেখা ছিল কিন্তু সেই barrel-এ যোগ করা হয়নি — তাই `DrizzleRbacProvider`-এর import বাস্তবে resolve করতোই না। শেষ লাইনে `export * from "./rbac";` যোগ করা হলো (existing `095`/`094` মাইগ্রেশনের পরের নাম্বার হিসেবে `096` কনফার্ম করা হয়েছে — কোনো কোলিশন নেই)।

### ৩. একটা টেস্ট বাগ পাওয়া গেছে এবং ঠিক করা হয়েছে
`test-policy-rbac.ts`-এর "privilege escalation" টেস্টে `ryft.payment.approve`-কে "কোনো role-এই নেই" ধরে নিয়ে assert করা হয়েছিল যে forged-admin সেটা পাবে না — কিন্তু `seededProvider()`-এর নিজের সেটআপেই admin-এর parent role `dev`, আর `dev`-কে সরাসরি `ryft.payment.approve` grant করা আছে। Role-inheritance (role-resolver.ts) ঠিকমতো কাজ করছে বলেই admin সেটা **legitimately** পায় — এটা escalation না, এটা design অনুযায়ী সঠিক inheritance। টেস্টের নিজের assumption-টাই ভুল ছিল। ঠিক করা হয়েছে: negative case হিসেবে `ryft.payment.create` ব্যবহার করা হয়েছে, যেটা আসলেই কোনো role-এর কাছে নেই এই fixture-এ।

## যাচাই — এবার প্রথমবারের মতো আসলেই রান করে কনফার্ম করা হয়েছে
আগের তিনটা phase report-এই (1A/1B/1C) লেখা ছিল "network/node_modules না থাকায় সরাসরি রান করা যায়নি, শুধু code-review দিয়ে verify করা হয়েছে"। এই পাসে network available ছিল — তাই:
- `npm install` (typescript + tsx + @types/node) সফল হয়েছে।
- `npx tsc --noEmit` — **০ এরর**, পুরো `lib/policy/*` tree জুড়ে (Phase 1A+1B+1C+02+03A সব একসাথে)।
- চারটা regression suite আসলেই রান করে পাস করানো হয়েছে: `test-policy-engine.ts` (1A, ১২টা), `test-policy-pip.ts` (1B, ১১টা), `test-policy-decision-observer.ts` (1C, ১২টা) — কোনো রিগ্রেশন নেই।
- `test-policy-rbac.ts` (Phase 02) — উপরের বাগ ফিক্সের পর **২৮টা টেস্টই পাস**।

## PHASE STATUS

- **Implemented:** RBAC data model (roles/permissions/role_permissions/user_roles + inheritance), permission-matcher grammar (concrete key vs constrained trailing-wildcard grant pattern), bounded/cycle-safe role-inheritance resolver, legacy `users.role` → RBAC role mapping, `createRbacRule()` wired as this engine's first real `PolicyRule`.
- **Files changed:** `lib/db/src/schema/index.ts` (added `export * from "./rbac"`).
- **Files added:** `lib/policy/rbac/types.ts`, `lib/policy/rbac/index.ts`, `lib/db/src/schema/rbac.ts`, `migrations/096_ayzen_rbac_core.sql`, `lib/policy/rbac/{permission-matcher,role-resolver,legacy-role-map,rbac-rule,drizzle-rbac-provider}.ts`, `scripts/src/test-policy-rbac.ts`.
- **Database changes:** migration `096` — 4 নতুন টেবিল (`roles`, `permissions`, `role_permissions`, `user_roles`), no FK constraints (কোডবেসের existing pattern অনুসরণ করে), idempotent (`IF NOT EXISTS`/`ON CONFLICT DO NOTHING`), ৩টা system role seed (user→dev→admin) + ৫টা illustrative permission + baseline grants। **এই মাইগ্রেশন এখনো actual Supabase-এ রান করা হয়নি** (sandbox-এ কোনো DB নেই) — বুট-টাইম `MIGRATIONS` অ্যারেতেও যোগ করা হয়নি, ম্যানুয়ালি রান করার জন্য migration ফাইলটা তৈরি করে দেওয়া হয়েছে, ঠিক migration 096-এর নিজের হেডার কমেন্ট অনুযায়ী।
- **Tests:** ২৮/২৮ পাস, সত্যিকারভাবে `npx tsx` দিয়ে রান করে কনফার্ম করা (আগের phase-গুলোর মতো শুধু code-review না)।
- **Security tests (roadmap-এর Phase 02 তালিকা থেকে):** role grants permission, missing permission denied, inherited role, revoked role (role-level ও grant-level দুইভাবেই), invalid wildcard, privilege escalation (forged `subject.role` string + forged `request.resource` fields) — সবগুলো কভার করা আছে টেস্ট স্যুটে।
- **Known limitations:**
  - Migration `096` বাস্তব Supabase-এ এখনো apply করা হয়নি এবং boot-time auto-migration array-তে যোগ করা হয়নি (ইচ্ছাকৃত — ম্যানুয়াল রান দরকার, migration ফাইলের নিজের কমেন্টেই তা বলা আছে)।
  - `DrizzleRbacProvider` বাস্তব Postgres-এর বিপরীতে রান করে দেখা যায়নি (sandbox-এ কোনো DB নেই) — শুধু typecheck দিয়ে কনফার্ম করা হয়েছে যে schema/provider-এর ফিল্ড নাম মিলে যাচ্ছে।
  - কোনো route/middleware এখনো `createRbacRule`/`PolicyEngine` ব্যবহার করছে না — grep করে কনফার্ম করা হয়েছে পুরো আসল কোডবেসে `lib/policy` বা `PolicyEngine`-এর কোনো রেফারেন্স নেই। এটা roadmap Rule 16 অনুযায়ী ইচ্ছাকৃত।
- **Migration status:** SQL ফাইল রেডি, ম্যানুয়াল Supabase SQL Editor রান বাকি (কোডবেসের existing convention — কিছু migration boot array-তে, কিছু ম্যানুয়াল)।
- **Regression status:** কোনো রিগ্রেশন নেই — 1A/1B/1C-এর তিনটা suite-ই আগের মতোই পাস করছে, এই পাসে সত্যিকারভাবে রান করে কনফার্ম করা হয়েছে।
- **Next phase:** Phase 03 (Resource / Ownership Authorization) — sub-phase 3A একই পাসে implement করা হয়েছে, আলাদা রিপোর্টে (`CHANGES_POLICY_AUTHORIZATION_ENGINE_PHASE3A.md`) বিস্তারিত।
