# AYZEN Policy & Authorization Mega Engine — Phase 03, Sub-phase 3C: Organization Access

## কেন এটা 3B থেকে আলাদা পাস, কিন্তু কোনো নতুন টেবিল লাগেনি
Roadmap-এর Phase 03-এর পাঁচটা রুলের শেষটা: **organization access**। 3B-এর মতো এটাও প্রথমে DB-backed মনে হচ্ছিল (org membership resolution), কিন্তু আসলে তা লাগেনি — `Subject.organizationId` আর `ResourceRef.organizationId` দুটোই Phase 1A-এর `lib/policy/types.ts`-এই আছে। `Subject.organizationId`-এর নিজের কমেন্টে সরাসরি লেখা: "Not modeled by the current schema yet (Phase 03+ concern) — carried here as optional so later phases don't need to touch this interface"। এই sub-phase সেই পরের ফেজ। ঠিক 3A (ownership-rule.ts)-এর মতোই — caller-supplied দুইটা ফিল্ড তুলনা করা একটা pure function, কোনো নতুন schema/provider ছাড়াই।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/policy/resource/organization-access-rule.ts` (**নতুন**) | `createOrganizationAccessRule()` — engine-এর চতুর্থ real `PolicyRule` (ownership, locked-resource, explicit-grant-এর পরে)। `subject.organizationId === resource.organizationId` হলে ALLOW; দুইয়ের যেকোনো একটা `undefined`/`null` হলে বা না মিললে **abstain** (ownership-rule.ts-এর ঠিক একই যুক্তি — non-member তবুও explicit grant বা RBAC role দিয়ে allowed হতে পারে)। |
| `lib/policy/resource/index.ts` (**পরিবর্তিত**) | `./organization-access-rule` যোগ; হেডার আপডেট — এখন 3A+3B+3C তিনটাই কভার করে। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | ব্যারেল কমেন্ট আপডেট (3A-only থেকে 3A+3B+3C)। |
| `scripts/src/test-policy-resource-org-access.ts` (**নতুন**) | ১৪টা DB-free টেস্ট — core allow/abstain আচরণ, cross-tenant security suite (3A-এর CHANGES doc-এ যেটা এই রুল তৈরি না হওয়া পর্যন্ত মুলতুবি ছিল), IDOR/org-id substitution, privilege escalation, আর 3A/3B-এর রুলগুলোর সাথে composition। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য
- **কোনো নতুন reason code লাগেনি।** ownership-rule.ts-এর মতোই এই রুলও generic `EXPLICIT_ALLOW` ব্যবহার করে, `policyId: "organization-access"` দিয়ে audit log-এ আলাদা করে চেনা যায় — RESOURCE_LOCKED/RESOURCE_GRANT_DENIED-এর মতো একটা distinct DENY code লাগেনি কারণ এই রুল কখনো DENY রিটার্ন করে না, শুধু ADD করে একটা ALLOW path (3A/3B-এর deny-দিকগুলোর সাথে অসামঞ্জস্য না — এইটা ইচ্ছাকৃতভাবে ownership-rule.ts-এর সমান্তরাল একটা ALLOW-only রুল)।
- **`null` আর `undefined` দুটোই "কোনো org fact নেই" হিসেবে ট্রিট করা হয়েছে** — আজকের বাস্তবতায় বেশিরভাগ subject-এরই `organizationId` পপুলেট করা নেই (কোনো org-membership resolver এখনো লেখা হয়নি), তাই এই abstain-path-টাই এখন সবচেয়ে বেশি হিট হবে — ঠিক যেমন RBAC-এর `user_roles` বা 3B-এর `resource_grants` শুরুতে খালি ছিল।
- **কোনো action-restriction নেই (ownership-rule.ts-এর সমান্তরাল)** — same-org হলে blanket ALLOW, কোন action সেটা বিবেচনা না করেই। এটা ইচ্ছাকৃতভাবে ব্লান্ট — per-role-within-org grain (member/manager/viewer/editor) হলো Phase 04 (ReBAC)-এর কাজ, এই sub-phase-এর না (Rule 16)।
- **Deny-overrides-এর ওপর ভরসা করেই composition কাজ করে** — কোনো নতুন combining logic ছাড়া organization-access-এর ALLOW লকড-রিসোর্স DENY বা resource-grant DENY-কে হারাতে পারে না, এবং cross-tenant ব্যবহারকারীর জন্য একটা explicit resource-grant ALLOW এখনও কাজ করে — দুটোই সরাসরি টেস্ট করা হয়েছে।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে
- `npx tsx scripts/src/test-policy-resource-org-access.ts` — **১৪/১৪ পাস**।
- রিগ্রেশন: 1A/1B/1C/02/3A/3B — সব কয়টা suite এই পাসে আবার রান করে কনফার্ম করা হয়েছে, কোনো রিগ্রেশন নেই।
- এই রুল সম্পূর্ণ DB-free (3A-এর ownership-rule.ts-এর মতোই), তাই sandbox-এর network/node_modules সীমাবদ্ধতা এটাকে প্রভাবিত করে না — পুরোটাই সরাসরি `tsx`-এ রান করে ভেরিফাই করা হয়েছে।

## Security tests কভার করা হয়েছে (3A-এর CHANGES doc যেটা মুলতুবি রেখেছিল)
- **Cross-tenant access:** ভিন্ন org-এর subject → abstain → default DENY (একা এবং ownership-rule.ts-এর সাথে composition-এ, দুইভাবেই টেস্ট করা)।
- **IDOR / org-id substitution:** resource id বদলালেও org-membership-হীন subject-এর জন্য কখনো ALLOW তৈরি হয় না।
- **Privilege escalation:** resource-এ forge করা `organizationId` বসিয়ে দিলেও subject-এর নিজের `organizationId`-ই একমাত্র মাপকাঠি — resource-এর দিকের ফিল্ড বদলে subject-কে org-এর ভেতরে ঢোকানো যায় না।
- **Unauthenticated subject** কখনো এই রুল পর্যন্ত পৌঁছায় না (engine-লেভেল UNAUTHENTICATED-এই থেমে যায়)।

## যা ইচ্ছাকৃতভাবে এই পাসে করা হয়নি
- বাস্তব org-membership resolver — কিছুই এখনো `Subject.organizationId` পপুলেট করে না। এই রুল শুধু তুলনাটা করে; ডেটা কোথা থেকে আসবে (একটা নতুন `organizations`/`organization_members` টেবিল, নাকি existing কোনো ফিল্ড থেকে ম্যাপ করা) সেটা নিজেই একটা future phase-এর সিদ্ধান্ত (Rule 16 — speculative schema যোগ করিনি)।
- Per-role-within-organization গ্র্যানুলারিটি (member vs manager vs viewer) — Phase 04 (ReBAC)।
- কোনো route/service এখনো এই রুল ব্যবহার করছে না — grep করে কনফার্ম করা হয়েছে।

## PHASE STATUS
- **Implemented:** Organization-access rule (`organizationId` match → ALLOW, abstain otherwise), Phase 03-এর পাঁচটা রুলের সবকটাই এখন শিপড (ownership, explicit grants, organization access, resource-level deny, locked-resource restrictions)।
- **Files changed:** `lib/policy/resource/index.ts`, `lib/policy/index.ts`।
- **Files added:** `lib/policy/resource/organization-access-rule.ts`, `scripts/src/test-policy-resource-org-access.ts`।
- **Database changes:** কোনোটাই না — সম্পূর্ণ existing `Subject`/`ResourceRef` ফিল্ডের ওপর কাজ করে।
- **Tests:** ১৪/১৪ পাস।
- **Security tests:** Cross-tenant access, IDOR/org-id substitution, privilege escalation, unauthenticated-subject — সবগুলো কভার।
- **Known limitations:** org-membership resolver নেই, তাই আজকের বাস্তবতায় `subject.organizationId` প্রায় সবসময়ই `undefined` — এই রুল abstain করবে যতক্ষণ না একটা future phase সেই ডেটা পপুলেট করে। কোনো route এই রুল ব্যবহার করছে না।
- **Regression status:** 1A/1B/1C/02/3A/3B — রিগ্রেশন নেই।
- **Next phase:** Phase 03 সম্পূর্ণ। Phase 04 (ReBAC) — relationship-based রুল (owner/member/manager/viewer/editor/approver/auditor) — শুরু করার আগে Rule 15 অনুযায়ী এই রিপোর্ট রিভিউ হওয়া উচিত।
