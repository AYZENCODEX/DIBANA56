# AYZEN Policy & Authorization Mega Engine — Phase 11: Temporary / Expiring Access

## স্কোপ

Roadmap-এর Phase 11 সেকশন verbatim implement করা হয়েছে: grant-এ
`grantedBy`, `reason`, `startsAt`, `expiresAt`, `scope`, `resource`,
`action` থাকবে, এবং "Expired grants must stop authorizing automatically।"

Phase 03B-এর `resource_grants` টেবিলে ইতিমধ্যেই একটা comment ছিল ("Why
there is no `expiresAt` column yet") যেটা explicitly বলে দিয়েছিল এই
সিদ্ধান্ত পরে একটা future phase-এর জন্য রাখা হয়েছে — Phase 11 সেই future
phase।

## কেন `resource_grants`-এ কলাম যোগ না করে নতুন টেবিল

দুইটা কারণ:

1. `resource_grants` exact-match-only (এক (subject, resourceType,
   resourceId, action) tuple-এ এক row — unique index দিয়ে enforced)।
   Temporary access প্রায়ই একটা single resource-এর চেয়ে বড় হয় ("এই
   contractor-কে org 7-এর প্রতিটা vault item-এ ৪৮ ঘণ্টার read access দাও",
   একটা নির্দিষ্ট item না) — সেটা `resource_grants`-এর shape-এ জোর করে
   ঢোকালে প্রতিটা resource-এর জন্য আলাদা row লিখতে হতো।
2. `resource_grants`-এর কোনো `effect: allow/deny` distinction এখানে দরকার
   নেই — temporary grant মানেই GRANT করা (roadmap নিজেই বলছে "Support
   grants with: ...", কোনো time-boxed deny চায়নি)। তাই নতুন টেবিলে কোনো
   `effect` কলাম নেই — এই rule কখনো DENY রিটার্ন করে না, শুধু ALLOW অথবা
   abstain (null)।

## এই পাসে যা তৈরি হলো

| ফাইল | কী করে |
|---|---|
| `lib/db/src/schema/temporary-access-grants.ts` (**নতুন**) | Drizzle table def: `temporaryAccessGrantsTable` (`subject_user_id`, `resource_type`, `resource_id` nullable, `action`, `scope`, `organization_id` nullable, `starts_at`, `expires_at`, `granted_by` NOT NULL, `reason`), `insertTemporaryAccessGrantSchema` (Zod: `scope` enum-refine, `expiresAt > startsAt`, `scope="resource"` হলে `resourceId` required)। |
| `migrations/100_ayzen_temporary_access_grants.sql` (**নতুন**) | Schema ফাইলের সাথে হুবহু মিল রেখে `CREATE TABLE IF NOT EXISTS`, দুটো index (subject lookup + future expiry-cleanup job-এর জন্য `expires_at`), তিনটা CHECK constraint (scope enum, `expires_at > starts_at`, scope↔resource_id consistency) — সবকিছু idempotent। |
| `lib/policy/temporary-access/types.ts` (**নতুন**) | DB-free: `TemporaryAccessGrant` (id/scope/resourceId/organizationId/startsAt/expiresAt/grantedBy/reason), `TemporaryAccessGrantProvider` ইন্টারফেস (never throws for "none found"; time-window filtering **rule**-এর দায়িত্ব, provider-এর না)। |
| `lib/policy/temporary-access/temporary-access-rule.ts` (**নতুন**) | `createTemporaryAccessRule()` — allow-only `PolicyRule`। `request.context.timestamp`-এর বিরুদ্ধে `[startsAt, expiresAt)` half-open interval চেক করে (একদম `expiresAt`-এ EXPIRED, `startsAt`-এ inclusive-active)। `scope: "resource"` → exact id match; `scope: "resource_type"` → পুরো resourceType কভার করে, ঐচ্ছিকভাবে `organizationId` দিয়ে narrow করা। |
| `lib/policy/temporary-access/drizzle-temporary-access-grant-provider.ts` (**নতুন**) | আসল `@workspace/db`-backed provider — সময়ের ফিল্টার ছাড়াই সব candidate row রিটার্ন করে (rule নিজে সময় compare করে)। Malformed `scope` row skip করে (fail-closed)। |
| `lib/policy/temporary-access/index.ts` (**নতুন**) | Barrel — Drizzle provider বাদে (`resource/index.ts`-এর একই precedent)। |
| `lib/policy/index.ts` (**পরিবর্তিত**) | `./temporary-access` যোগ হলো টপ-লেভেল barrel-এ। |
| `scripts/src/test-policy-temporary-access.ts` (**নতুন**) | ১৯টা DB-free টেস্ট। |

## ডিজাইন সিদ্ধান্ত যেগুলো উল্লেখযোগ্য

- **Time source: `request.context.timestamp`, কখনো fresh `new Date()` না।**
  Rule 12 (deterministic evaluation) — একই `AuthorizationRequest` দুইবার
  evaluate করলে একই decision আসা লাগবে। `context.timestamp` request-build
  time-এ fix হয়ে যায় (`createPolicyContext()`), তাই rule সেটাই পড়ে —
  `abac/operators.ts`-এর header একই কথা বলে তার নিজের before/after
  comparison-এর জন্য। এটাই rule-কে trivially testable করে তোলে (কোনো
  global clock mock লাগে না — শুধু `PolicyContext.timestamp` সেট করলেই
  হয়)।
- **Half-open interval `[startsAt, expiresAt)`।** ঠিক `expiresAt`-এ
  EXPIRED গণ্য করা হয় (exclusive end) — নাহলে একজন client ঠিক
  `expiresAt`-এ request পাঠিয়ে "still within window" দাবি করতে পারত।
  `startsAt`-এ inclusive (grant শুরুর মুহূর্ত থেকেই কার্যকর)।
- **Allow-only, কখনো DENY না।** একটা expired/not-yet-active grant মানে
  "এই নির্দিষ্ট grant-টার এখন কিছু বলার নেই" — rule abstain করে (null),
  DENY বানায় না। অন্য কোনো rule (RBAC, ownership, permanent resource
  grant) হয়তো একই request আলাদাভাবে allow করতে পারে — সেই পথ বন্ধ করার
  অধিকার এই rule-এর নেই।
- **`scope: "resource_type"` — Phase 03-এর `resource_grants` থেকে
  deliberately বেশি broad।** `resource_grants` exact-match-only; temporary
  grant প্রায়ই একটা গোটা resource type-কে (ঐচ্ছিকভাবে এক org-এ narrow
  করে) সাময়িকভাবে খুলে দিতে চায় — এটাই "temporary"-এর আসল use-case
  (on-call access, incident response), শুধু "একটা permanent grant-এর
  expiry-ওয়ালা ভার্সন" না।
- **`grantedBy` NOT NULL** — `resource_grants.grantedBy` nullable
  (কারণ সেই টেবিলের কোনো writer নেই এখনো), কিন্তু roadmap নিজেই Phase
  11-এর field list-এ `grantedBy`-কে required হিসেবে গণ্য করে — একটা
  time-boxed grant ইনহেরেন্টলি একটা accountable, one-off administrative
  act।
- **কোনো `revokedAt` কলাম নেই।** Roadmap-এর Phase 11 সেকশন early
  revocation চায়নি (সেটা Phase 23-এর admin console/PAP write-path
  concern) — একটা unused nullable কলাম এখন যোগ করা Rule 16 লঙ্ঘন করত।

## যা ইচ্ছাকৃতভাবে Phase 11-এ নেই

- **কোনো route/middleware `createTemporaryAccessRule()` বা
  `DrizzleTemporaryAccessGrantProvider` কল করে না** — Phase 19 (PEP)
  পর্যন্ত real wiring বাকি, প্রতিটা আগের phase-এর একই posture।
- **`PrecedenceEngine`-এ কোনো actual registration নেই** — এই rule
  EXPLICIT_GRANT tier-এ belong করে (ownership/ReBAC/Phase 03B-এর ALLOW
  half-এর একই tier — `precedence-tiers.ts`-এর টেবিল অনুযায়ী), কিন্তু
  `precedence-tiers.ts` ফাইলে কোনো পরিবর্তন লাগেনি (সেটা শুধু tier
  vocabulary define করে, কোনো rule hardcode করে না — registration সবসময়ই
  caller-এর দায়িত্ব, `precedence-engine.ts`-এর নিজের header অনুযায়ী)।
- **কোনো admin/write API নেই** grant তৈরি করার জন্য — শুধু read-side
  (`TemporaryAccessGrantProvider`) এই পাসে আছে। লেখা Phase 23 (Admin
  Policy Console)-এর scope।
- **কোনো cleanup/archival cron job নেই** পুরনো expired row মুছে ফেলার
  জন্য — শুধু একটা `expires_at` index রাখা হয়েছে যাতে ভবিষ্যতের এমন job
  সহজে লিখা যায়।
- **`scripts/src/check-all.ts`-এর মতো কোনো central script-runner registry
  আপডেট করা হয়নি** — অন্য কোনো `test-policy-*.ts`-ও সেখানে wired নেই
  (প্রতিটাই standalone `npx tsx` দিয়ে চালানো হয়)।

## যাচাই — আসলেই রান করে কনফার্ম করা হয়েছে

- **`npx tsx scripts/src/test-policy-temporary-access.ts`** — **১৯/১৯
  পাস।**
- **রিগ্রেশন — Phase 1A থেকে 10B পর্যন্ত সবকয়টা suite আবার রান করা হয়েছে**
  (১৬টা suite, নতুনটাসহ মোট ১৭টা) — **সবগুলো পাস, কোনো রিগ্রেশন নেই।**
- **Dynamic-code-execution audit:** নতুন কোনো ফাইলে `eval`/`new Function`/
  `vm.Script` নেই।
- **SQL-injection audit:** `DrizzleTemporaryAccessGrantProvider` শুধু
  Drizzle-এর `eq`/`and` query builder ব্যবহার করে — কোনো raw SQL string
  interpolation নেই।
- **`DrizzleTemporaryAccessGrantProvider` real DB-এর বিরুদ্ধে রান করা
  হয়নি** (network নেই এই sandbox-এ) — Phase 02-10B-এর প্রতিটা DB-backed
  provider-এর একই known limitation।
- **`pnpm run typecheck` (পুরো workspace) এই sandbox-এ রান করা যায়নি** —
  `node_modules` install করা যায়নি (network নেই)। নতুন ফাইলগুলো বিদ্যমান
  `resource/*`/`rbac/*` ফাইলের সাথে হুবহু একই import/type pattern অনুসরণ
  করে, তাই typecheck-এর risk কম, কিন্তু এটা confirm করা এখনো বাকি।

## Security tests কভার করা হয়েছে

- **Clock boundaries:** `startsAt`-এর ১ms আগে (deny), ঠিক `startsAt`-এ
  (allow), mid-window (allow), `expiresAt`-এর ১ms আগে (allow), ঠিক
  `expiresAt`-এ (EXPIRED, deny), অনেক পরে (deny) — ৬টা আলাদা boundary
  case।
- **IDOR / resource-ID substitution:** id=42-এর grant id=43-এ leak করে না।
- **Cross-user:** bob-এর grant alice-এ extend হয় না।
- **Cross-tenant:** org 7-এ narrow করা `resource_type` grant org 9-এ leak
  করে না।
- **Privilege escalation:** forged unrelated resource fields দিয়ে match
  তৈরি হয় না।
- **Determinism:** একই request object দুইবার evaluate করলে একই effect —
  live clock read না হওয়ার প্রমাণ।
- **Composition:** expired temporary grant অন্য rule-এর (ownership) ALLOW
  block করে না; permanent explicit DENY একটা active temporary ALLOW-কে
  beat করে (deny-overrides); দুইটা grant-এর মধ্যে একটা expired হলেও অন্যটা
  active থাকলে allow হয়।

## Regression status
কোনো রিগ্রেশন নেই।

## Migration status
সম্পূর্ণ additive, dormant। কোনো route/middleware কল করে না। নতুন migration
(100) idempotent, Supabase SQL Editor-এ manually রান করতে হবে (migration
099-এর পরে)।

## Next phase
Phase 10-এর audit gate ইতিমধ্যে cross হয়েছে (roadmap-এ Phase 15-এর আগে
কোনো নতুন gate নেই — পরের formal gate Phase 15)। এরপর Phase 12 (Approval
Engine)।
