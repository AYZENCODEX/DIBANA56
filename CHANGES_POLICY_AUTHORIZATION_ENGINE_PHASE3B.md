# AYZEN Policy & Authorization Mega Engine — Phase 03, Sub-phase 3B: Explicit Resource Grants + Resource-level Deny

## কেন 3B আলাদা একটা পাস
3A-এর CHANGES doc-এ বলা ছিল বাকি তিনটা Phase 03 আইটেম (explicit grants, organization access, resource-level deny) নতুন DB-backed lookup চায়। এর মধ্যে **explicit grants** আর **resource-level deny** — দুটোই আসলে একই ডেটা শেপ: "এই (subject, resource, action) টুপলের জন্য উত্তর কী" — শুধু `effect` ভিন্ন (`allow` বনাম `deny`)। তাই একটাই টেবিল, একটাই provider method, একটাই rule — `createExplicitResourceGrantRule()`। Organization access আলাদা রাখা হলো (3C) কারণ সেটার ডেটা-শেপ সম্পূর্ণ ভিন্ন (membership comparison, নতুন টেবিল লাগে না — `Subject.organizationId`/`ResourceRef.organizationId` ইতিমধ্যেই Phase 1A-এ আছে)।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/db/src/schema/resource-grants.ts` (**নতুন**) | `resourceGrantsTable` — `rbac.ts`-এর ঠিক একই প্যাটার্নে: no FK constraint, `resource_id` TEXT (কারণ `ResourceRef.id` হলো `string \| number`), `effect` কলাম zod refine দিয়ে শুধু "allow"/"deny" মেনে চলতে বাধ্য করা। `(subjectUserId, resourceType, resourceId, action)`-এর ওপর unique index — একই টুপলে দুইটা পরস্পরবিরোধী row বসতে পারবে না। |
| `lib/db/src/schema/index.ts` (**পরিবর্তিত**) | `export * from "./resource-grants";` যোগ। |
| `migrations/097_ayzen_resource_grants.sql` (**নতুন**) | `resource_grants` টেবিল — idempotent, কোনো seed data নেই (096-এর মতো illustrative catalog না — একটা grant শুধু তখনই অর্থবহ যখন একটা বাস্তব resource row-এর সাথে যুক্ত, আর এই টেবিল সব resource type জুড়ে generic থাকতে হবে)। |
| `lib/policy/resource/types.ts` (**নতুন**) | `ResourceGrantEntry` (`effect` + optional `reason`) আর `ResourceGrantProvider` ইন্টারফেস — `rbac/types.ts`-এর `RbacProvider`-এর ঠিক একই প্যাটার্ন: narrow, read-only, DB-free-to-depend-on, যাতে rule নিজে in-memory fake দিয়ে unit-test করা যায়। |
| `lib/policy/resource/explicit-grant-rule.ts` (**নতুন**) | `createExplicitResourceGrantRule(provider)` — engine-এর তৃতীয় real `PolicyRule`। **দুই দিকের রুল**: `effect: "allow"` হলে ownership-rule.ts-এর মতোই শুধু ADD করে একটা grant path (abstain যদি না পাওয়া যায়); `effect: "deny"` হলে explicit **DENY** (`RESOURCE_GRANT_DENIED`) — deny-overrides দিয়ে যেকোনো অন্য ALLOW-কে হারায়, registration order যাই হোক (locked-resource-rule.ts-এর deny-half-এর ঠিক একই posture)। Exact match only — `resource.id` ছাড়া কিছু লুকআপ করার নেই, তাই abstain; `String(resource.id)` করে TEXT কলামের সাথে মেলানো হয়। |
| `lib/policy/resource/drizzle-resource-grant-provider.ts` (**নতুন**) | `@workspace/db`-backed real provider। `rbac/drizzle-rbac-provider.ts`-এর মতোই: malformed `effect` (না "allow" না "deny") পেলে fail-closed (`null` রিটার্ন), row-টাকে trust করে না। কোনো route/service এখনো এটা কনস্ট্রাক্ট করে না (grep করে কনফার্ম করা হয়েছে) — Rule 16 অনুযায়ী ইচ্ছাকৃতভাবে unwired। |
| `lib/policy/resource/index.ts` (**পরিবর্তিত**) | `./types` আর `./explicit-grant-rule` যোগ; `drizzle-resource-grant-provider.ts` বাদ (RBAC barrel-এর ঠিক একই কারণে — `@workspace/db` কে DB-free guarantee-র বাইরে রাখা)। |
| `lib/policy/decision-reasons.ts` (**পরিবর্তিত**) | নতুন reason code `RESOURCE_GRANT_DENIED` — `EXPLICIT_DENY`/`RESOURCE_LOCKED` থেকে আলাদা করে চেনার জন্য, `policyId` না দেখেই। |
| `scripts/src/test-policy-resource-grants.ts` (**নতুন**) | ১৪টা DB-free টেস্ট। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য
- **এক টেবিল, দুই effect** — আলাদা allow-list আর deny-list টেবিল রাখলে প্রতি রিকোয়েস্টে দুইটা লুকআপ লাগতো আর দুই জায়গায় future admin/sharing UI-কে লিখতে হতো, কোনো বাড়তি expressiveness ছাড়াই।
- **Deny-overrides-এর ওপর নতুন কোনো কম্পোজিশন লজিক লাগেনি** — Phase 1A-এর engine-এর existing algorithm-ই যথেষ্ট; দুই দিকের registration order দিয়েই টেস্ট করা হয়েছে (`revoking a deny grant restores whatever other rule would otherwise apply`)।
- **`expiresAt` কলাম এখনো নেই** — কোনো caller time-boxed grant চায়নি, speculative schema যোগ করিনি (Rule 16)।
- **`resource.id` না থাকলে abstain, DENY না** — ownership-rule.ts-এর ownerId-না-থাকা কেসের সাথে সামঞ্জস্যপূর্ণ।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে
- `npx tsx scripts/src/test-policy-resource-grants.ts` — **১৪/১৪ পাস**।
- রিগ্রেশন: 1A/1B/1C/02/3A — সবগুলো suite এই পাসে আবার রান করে কনফার্ম করা হয়েছে, কোনো রিগ্রেশন নেই।
- **সীমাবদ্ধতা:** এই sandbox-এ নেটওয়ার্ক নেই এবং `node_modules` ইনস্টল করা নেই (`drizzle-orm`/`drizzle-zod`/`zod`/`@workspace/db` কোনোটাই resolve হয় না) — তাই `resource-grants.ts` schema ফাইল আর `drizzle-resource-grant-provider.ts` পুরো `tsc -b` দিয়ে টাইপচেক করা যায়নি এই পাসে (ঠিক যেমন `drizzle-resource-grant-provider.ts`-এর নিজের হেডারেই লেখা আছে এটা এই sandbox-এ বাস্তব Postgres-এর বিপরীতে রান করা যায় না)। DB-free rule/টেস্ট অংশটুকু (`explicit-grant-rule.ts`, `types.ts`, টেস্ট ফাইল) `tsx`-এ সরাসরি রান করে আচরণগতভাবে ভেরিফাই করা হয়েছে।

## Security tests কভার করা হয়েছে
- **IDOR / resource-ID substitution:** id=42-এর জন্য দেও়া grant অন্য কোনো id (numeric/string/leading-zero) দিয়ে ম্যাচ করে না।
- **Cross-user:** alice-কে দেওয়া grant bob-এর কাছে extend হয় না, একই resource/action হলেও।
- **Privilege escalation:** `organizationId`/`classification` forge করলেও গ্রান্ট ম্যাচ তৈরি হয় না — শুধু exact tuple মেলে।
- **Cross-tenant** এখনো এই ফাইলে নেই — organization access rule নিজেই 3C-তে আসছে, cross-tenant suite সেখানেই।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি
- Organization access rule (3C — পরের পাস)।
- কোনো writer/admin-UI যা আসলে `resource_grants`-এ INSERT করে — grant data আসলে কোথাও থেকে আসছে না এখনো।
- `expiresAt` / time-boxed grants।

## PHASE STATUS
- **Implemented:** Explicit resource grant rule (allow + deny উভয়), Drizzle provider, `resource_grants` schema + migration, নতুন `RESOURCE_GRANT_DENIED` reason code।
- **Files changed:** `lib/db/src/schema/index.ts`, `lib/policy/resource/index.ts`, `lib/policy/decision-reasons.ts`।
- **Files added:** `lib/db/src/schema/resource-grants.ts`, `migrations/097_ayzen_resource_grants.sql`, `lib/policy/resource/{types,explicit-grant-rule,drizzle-resource-grant-provider}.ts`, `scripts/src/test-policy-resource-grants.ts`।
- **Database changes:** নতুন `resource_grants` টেবিল (migration 097, কোনো seed data নেই)।
- **Tests:** ১৪/১৪ পাস।
- **Security tests:** IDOR/resource-ID substitution, cross-user access, privilege escalation — কভার। Cross-tenant → 3C।
- **Known limitations:** কোনো route এখনো এই rule ব্যবহার করে না; কোনো writer নেই; sandbox-এ DB-backed অংশ টাইপচেক/রান করা যায়নি (নেটওয়ার্ক/node_modules নেই)।
- **Regression status:** 1A/1B/1C/02/3A — রিগ্রেশন নেই।
- **Next phase:** 3C — organization access + cross-tenant security suite।
