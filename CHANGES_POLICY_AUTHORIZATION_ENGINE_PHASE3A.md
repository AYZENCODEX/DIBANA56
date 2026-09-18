# AYZEN Policy & Authorization Mega Engine — Phase 03, Sub-phase 3A: Resource Ownership + Locked-Resource Restriction

## কেন 3A / 3B ভাগ করা হলো
Roadmap-এর Phase 03 (RESOURCE / OWNERSHIP AUTHORIZATION)-এ ৫টা রুল চাওয়া হয়েছে: **ownership, explicit grants, organization access, resource-level deny, locked-resource restrictions**। এর মধ্যে ownership আর locked-state — দুটোই ইতিমধ্যে Phase 1A-এর `ResourceRef` টাইপে আছে (`ownerId`, `locked` ফিল্ড) — caller যা supply করে তার ওপর সরাসরি একটা pure function হিসেবে কাজ করা যায়, কোনো নতুন DB টেবিল বা provider interface ছাড়াই। বাকি তিনটা (explicit grants, organization access, resource-level deny) নতুন DB-backed lookup চায় (একটা `resource_grants`-জাতীয় টেবিল, org membership resolution) — Rule 16 ("do not implement future phases prematurely") মেনে সেটা একটা future sub-phase-এ (3B) রাখা হলো, ঠিক যেভাবে Phase 01 নিজেও 1A (core engine) → 1B (PIP adapters) → 1C (observability)-এ ভাগ হয়েছিল, প্রতিটা sub-phase-ই "যা এখন বাস্তবে আছে তার ওপর ভিত্তি করে" implementable ছিল।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/policy/resource/ownership-rule.ts` (**নতুন**) | `createResourceOwnershipRule()` — engine-এর দ্বিতীয় real `PolicyRule`। `request.resource.ownerId === request.subject.userId` হলে ALLOW; `ownerId` না থাকলে বা owner না মিললে **abstain** (deny না) — কারণ non-owner তবুও RBAC role grant বা future org/explicit-grant দিয়ে allowed হতে পারে (ঠিক `rbac-rule.ts`-এর মতো একই যুক্তি)। |
| `lib/policy/resource/locked-resource-rule.ts` (**নতুন**) | `createLockedResourceRule(options?)` — `resource.locked === true` হলে explicit **DENY** (`RESOURCE_LOCKED`), owner হোক বা না হোক। Deny-overrides combining-এর কারণে এটা সবসময় ownership/RBAC-এর ALLOW-কে বিট করে, registration order যাই হোক। কোন action "safe while locked" সেটা roadmap কোথাও fix করে দেয়নি এবং প্রোডাক্ট-ভেদে আলাদা হতে পারে — তাই hardcode না করে `exemptActions` অপশন হিসেবে caller-কে দেওয়া হয়েছে (ডিফল্ট: সব action-ই ব্লক)। |
| `lib/policy/resource/index.ts` (**নতুন**) | barrel — দুটোই DB-free বলে RBAC-এর মতো কিছু বাদ দিতে হয়নি। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `export * from "./resource";` যোগ। |
| `lib/policy/decision-reasons.ts` (**পরিবর্তিত**) | নতুন reason code `RESOURCE_LOCKED` — যাতে audit log-এ "কোনো role/owner-ই cover করেনি" (`NO_MATCHING_POLICY`) আর "resource নিজেই লকড ছিল" আলাদা করে চেনা যায়, `policyId` না দেখেও। |
| `scripts/src/test-policy-resource.ts` (**নতুন**) | ১২টা DB-free টেস্ট, `npx tsx scripts/src/test-policy-resource.ts` দিয়ে সরাসরি রান করা যায়। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য
- **Abstain vs deny** ownership-rule-এ ঠিক rbac-rule.ts-এর প্যাটার্ন অনুসরণ করে — non-owner হওয়া মানেই সব পথ বন্ধ না।
- **Deny-overrides দিয়ে lock-rule-কে ownership-rule-এর ওপরে বসানো** — কোনো নতুন combining logic লাগেনি, Phase 1A-এর engine-এর existing deny-overrides algorithm-ই যথেষ্ট। এই কম্পোজিশন সরাসরি টেস্ট করা হয়েছে (দুই দিকের registration order দিয়েই)।
- **`ownerId`/`locked` client trust boundary** — এই রুলগুলো নিজে DB থেকে owner lookup করে না; caller (route/PEP লেয়ার) যা resource-এ বসিয়ে দেয় তার ওপর ভরসা করে, ঠিক RBAC-এর `Subject` DB-verified হওয়ার মতোই একটা trust boundary। এটা explicitly ফাইলের হেডারে লেখা আছে যাতে ভবিষ্যতে কেউ ভুল করে client-supplied `ownerId` সরাসরি pass না করে।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে
- `npx tsc --noEmit` — পুরো tree (1A+1B+1C+02+03A) জুড়ে ০ এরর।
- `npx tsx scripts/src/test-policy-resource.ts` — **১২/১২ পাস**।
- রিগ্রেশন: 1A/1B/1C/02 — চারটা suite-ই এই একই পাসে আবার রান করে কনফার্ম করা হয়েছে, কোনো রিগ্রেশন নেই।

## Security tests কভার করা হয়েছে (roadmap-এর Phase 03 তালিকা থেকে, 3A-এর scope অনুযায়ী)
- **IDOR / resource-ID substitution:** একই real owner রেখে অনেকগুলো ভিন্ন `resource.id` (numeric, string, ভিন্ন ভ্যালু) try করে দেখানো হয়েছে যে id বদলালেই ownership match হয়ে যায় না।
- **Cross-user access:** bob-এর subject দিয়ে alice-এর resource রিকোয়েস্ট করলে ownership rule abstain করে, কোনো অন্য rule না থাকলে default-deny হয়।
- **Privilege escalation via forged resource fields:** `organizationId`/`classification` ইত্যাদি অতিরিক্ত ফিল্ড বসিয়ে দিলেও ownership check বদলায় না — শুধু `ownerId === subject.userId`-ই মাপকাঠি।
- **Cross-tenant access** এই sub-phase-এর scope-এ নেই (organization access এখনো implement হয়নি) — 3B-এর টেস্ট ফাইলে যাবে যখন org-membership resolver তৈরি হবে।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি (3B-এর জন্য বাকি)
- Explicit per-resource grants (নতুন `resource_grants`-জাতীয় টেবিল লাগবে)।
- Organization access rule (`subject.organizationId === resource.organizationId` — `Subject.organizationId` টাইপে থাকলেও এখনো কোনো ডেটা সোর্স populate করে না, Phase 1A-এর `types.ts`-এর কমেন্টেই লেখা আছে "Phase 03+ concern")।
- Resource-level explicit deny list (per-resource, per-subject override) — এটাও DB-backed, তাই 3B।
- Cross-tenant security টেস্ট স্যুট (org access rule না থাকলে অর্থহীন টেস্ট হতো)।
- কোনো route/service এখনো এই দুটো rule ব্যবহার করছে না — grep করে কনফার্ম করা হয়েছে। Rule 16 অনুযায়ী ইচ্ছাকৃত।

## PHASE STATUS

- **Implemented:** Resource-ownership rule (`ownerId` match → ALLOW, abstain otherwise), locked-resource restriction rule (explicit DENY, configurable exempt-action allow-list), নতুন `RESOURCE_LOCKED` reason code।
- **Files changed:** `lib/policy/index.ts`, `lib/policy/decision-reasons.ts`।
- **Files added:** `lib/policy/resource/{ownership-rule,locked-resource-rule,index}.ts`, `scripts/src/test-policy-resource.ts`।
- **Database changes:** কোনোটাই না — এই sub-phase সম্পূর্ণভাবে existing `ResourceRef` ফিল্ডের ওপর কাজ করে।
- **Tests:** ১২/১২ পাস, সত্যিকারভাবে রান করে কনফার্ম করা।
- **Security tests:** IDOR/resource-ID substitution, cross-user access, forged-resource-field privilege escalation — কভার করা আছে। Cross-tenant বাকি (3B, org access rule তৈরি হওয়ার পর)।
- **Known limitations:** Explicit grants, organization access, resource-level deny list — এই তিনটা roadmap-লিখিত Phase 03 আইটেম এখনো implement হয়নি (3B)। `exemptActions`-এর জন্য কোনো cross-product default কনভেনশন এখনো নেই — প্রতিটা call site নিজে ঠিক করবে কোন action নিরাপদ।
- **Migration status:** প্রযোজ্য না (কোনো schema change নেই)।
- **Regression status:** কোনো রিগ্রেশন নেই — 1A/1B/1C/02 চারটাই এই পাসে আবার পাস করেছে।
- **Next phase:** Phase 03, sub-phase 3B (explicit resource grants + organization access + resource-level deny list + cross-tenant security suite) — শুরু করার আগে Rule 15 অনুযায়ী এই রিপোর্ট রিভিউ হওয়া উচিত।
