# Route Integration Roadmap — Season E, Phase E1 থেকে E7

> **প্রেক্ষাপট:** Season D (`ROADMAP_ROUTE_INTEGRATION_PHASE_D1_D8.md`,
> D1-D8) C35-এর ৩৪০-route grandfathered backlog পুরোপুরি triage করে
> বেসলাইন **৩৪০ → ১৫৪**-এ নামিয়েছে (`CHANGES_ROUTE_INTEGRATION_PHASE_D8.md`)।
> D8 নিজেই বলেছিল বাকি ১৫৪টা "কোনোটাই blocking না... future hygiene
> backlog"। এই ফাইলটা সেই backlog-টা নিয়ে কী করা যায় তার পরিকল্পনা —
> Season D-এর মতো **"সব গেট করো" দিয়ে শুরু না, বরং কোনগুলো wire করা আসলে
> মূল্য যোগ করে সেটা প্রথমে বেছে নিয়ে**।

## কেন "সবকটা ১৫৪ গেট করো" ভুল প্রশ্ন

D8-এর নিজস্ব close-out summary অনুযায়ী বাকি ১৫৪ (এখন E1-এর পরে ১৪১) পাঁচ
রকমের শেপে ভাগ হয়:

| শেপ | wire করা কি "better"? | কেন |
|---|---|---|
| Raw-SQL-scoped, **বিদ্যমান** resource-builder/audit-engine আছে (D7-এর audit-only) | **হ্যাঁ** | Infra ইতিমধ্যে আছে, শুধু blocking middleware হিসেবে ব্যবহার হচ্ছে না — mechanical promotion, কম ঝুঁকি |
| Raw-SQL-scoped, কোনো named wrapper/builder নেই (`ayzen-mailbox.ts`, `vault-attachments.ts`-এর মতো) | **সম্ভবত, পরে** | Wire করা মূল্য যোগ করে (audit trail, consistency) কিন্তু নতুন `ResourceRefBuilder` বানাতে হবে — বড় কাজ, আলাদা phase |
| Public/token-possession by design | **না** | কোনো ownership প্রশ্নই প্রযোজ্য না — wire করলে ভুল model (এমন কিছু "গেট" করা যেটার আসলে কোনো owner নেই) |
| Self-scoped (own-row, আলাদা resource-id নেই) | **না** | D6 নিজেই এই সিদ্ধান্ত নিয়েছিল (`teams.ts`-এর বুকেট খ.৩) — `requireOwnership()` এই শেপে fit করে না, জোর করে wire করলে ভুল abstraction |
| Login-gate-only | **না** | Ownership প্রশ্ন অবান্তর, শুধু authenticated হতে হবে |

**এই roadmap-এর সিদ্ধান্ত:** শুধু প্রথম দুই ক্যাটেগরি — যেখানে wire করা
সত্যিই কিছু যোগ করে (consistency, single enforcement point, আর script-এর
কাছে দৃশ্যমানতা) — টার্গেট করা হবে। বাকি তিনটা ক্যাটেগরি **ইচ্ছাকৃতভাবে
untouched থাকবে**, ঠিক D8 নিজে যেমন সিদ্ধান্ত নিয়েছিল।

---

## E1 — `finance.ts`: book + entry-derived group (✅ সম্পূর্ণ)

**করা হয়ে গেছে** — দেখুন `CHANGES_ROUTE_INTEGRATION_PHASE_E1.md`। ১৩টা
route (book ৩ + entry-derived attachments/receipt/amortization/invoice-lines
১০) audit-only থেকে real blocking `requireOwnership()`-এ promote করা
হয়েছে, বিদ্যমান resource builder/factory reuse করে। বেসলাইন **১৫৪ → ১৪১**।
একটা ordering ফাঁদ পাওয়া গেছে আর ডকুমেন্ট করা হয়েছে (resource builder যদি
route-এর *পরে* module-এ ঘোষিত হয়, router-level `requireOwnership()`
temporal-dead-zone এ পড়ে) — E2-এর প্রতিটা group-এ এটা মনে রাখতে হবে।

## E2 — `finance.ts`: বাকি ১৮টা raw-SQL/audit-only route

D2 (Season D)-এর triage-করা বাকি groups: asset (২), goal (৩), recurring
(২), budget (১), account (২), journal (২), report-schedule (২), আর
own-id groups — amortization pay (১), depreciation post (১),
asset-depreciation read+generate (২)। প্রতিটার নিজস্ব `*Resource`/
`*AuditEngine` জোড়া ইতিমধ্যে module-এ আছে (E1-এর মতোই), কিন্তু প্রতিটা
group-এর নিজস্ব `requireX Ownership()` factory বানাতে হবে আর E1-এর ordering
ফাঁদ প্রতিটার জন্য আলাদাভাবে চেক করতে হবে (কিছু group-এর route তাদের নিজের
resource builder-এর আগে আসে, কিছু পরে — একই মেকানিক্যাল কাজ, কিন্তু ১০টা
আলাদা group মানে ১০ বার যাচাই)। প্রতিটা group-এর 404 message ভিন্ন হতে পারে
(`finance.ts`-এ ইতিমধ্যে "Not found"/"Entry not found"/"Asset not
found"/"Goal not found" মেশানো আছে — E1-এর ডকুমেন্টেড পদ্ধতি অনুসরণ করে
প্রতিটা route-এর নিজস্ব pre-existing message-ই `onDeny`-তে বসাতে হবে, কোনো
message বদলানো যাবে না)।

**Output**: `CHANGES_ROUTE_INTEGRATION_PHASE_E2.md`, `finance.ts` পুরোপুরি
D7 audit-only-মুক্ত হয়ে যাবে (এই ফেজের শেষে `auditFinanceOwnership()`
helper নিজে dead code হয়ে যাবে — সরিয়ে ফেলা হবে)। প্রত্যাশিত baseline
shrink: ১৪১ → ~১২৩ (১৮টা)।

## E3 — `projects.ts`: raw-SQL/audit-only group

`projects.ts`-এ ইতিমধ্যে `auditProjectsOwnership()` (finance.ts-এর D7
pattern-এর হুবহু কপি), `vaultEntryAuditEngine`, `kycEntryAuditEngine`,
`vaultEntryOwnerResource` বিদ্যমান — `GET /projects/entity/:vaultEntryId/
overview` আর enrollment-সংক্রান্ত ২-৩টা call site এগুলো ব্যবহার করে।
প্রথম কাজ: বর্তমান বেসলাইনের ১৮টা `projects.ts` entry-এর প্রতিটাকে
আবার তিন-বাকেটে ভাগ করা (public token ২, self-scoped ~৯, raw-SQL/
audit-only ~৭) — D3 (Season D)-এর নিজস্ব bucket-breakdown-এর বিপরীতে
cross-check করে, কারণ D7-এর পরে সংখ্যা কিছুটা সরে থাকতে পারে। শুধু
raw-SQL/audit-only bucket promote করা হবে, একই E1/E2 পদ্ধতিতে।

**Output**: `CHANGES_ROUTE_INTEGRATION_PHASE_E3.md`। প্রত্যাশিত shrink:
~৭ route।

## E4 — `teams.ts`: D7-এর leader-অর্ধেক audit-only routes

D8-এর close-out summary অনুযায়ী D7 `teams.ts`-এর কম্পাউন্ড বুকেটের
leader-অর্ধেকে ২টা route-এ audit-only wiring দিয়েছিল (বাকিটা membership-half,
D6-এর `createGroupMembershipRule()`-এ ইতিমধ্যে real PDP enforcement
পেয়েছে)। বর্তমান বেসলাইনে `teams.ts`-এর ৬টা entry বাকি
(`/favorite`, `/join-request`, `/leave`, `/notifications` GET+PATCH,
`/invites/respond`) — এগুলো D6 **ইচ্ছাকৃতভাবে** untouched রেখেছিল
("এখানে আলাদা কোনো membership fact নেই যা গেট করার মতো", D8-এর ফাইল-বাই-ফাইল
টেবিল)। প্রথম কাজ তাই triage, না code — এই ৬টার মধ্যে কোনটা সত্যিই
D7-এর leader-audit-only shape (promote-worthy) বনাম কোনটা genuinely
self-scoped (D6-এর সিদ্ধান্ত বহাল রাখা উচিত) সেটা আলাদা করা।

**Output**: findings doc; শুধু যা promote-worthy পাওয়া যায় সেটাই code
change পাবে (D1-D4-এর "audit first" নীতি অনুসরণ করে)। প্রত্যাশিত shrink:
০-২ route (বেশিরভাগ সম্ভবত self-scoped থেকে যাবে, D6-এর সিদ্ধান্ত সঠিক
প্রমাণিত হবে)।

## E5 — নতুন resource-builder: `ayzen-mailbox.ts` + `vault-attachments.ts`

এই দুটো ফাইলের ১০টা route (৫+৫) raw-SQL-scoped কিন্তু কোনো named
wrapper/builder নেই — `ayzen-mailbox.ts` সরাসরি `WHERE userId = ...`,
`vault-attachments.ts`-এর নিজস্ব inline `assertEntityOwnership()` helper
`PEP_WIRING_NAMES`-এ recognized না। E1-E4-এর থেকে ভিন্ন — এখানে কোনো
বিদ্যমান `ResourceRefBuilder` reuse করার সুযোগ নেই, নতুন বানাতে হবে
(`makeAyzenMailboxOwnerResource()`, `vault-attachments.ts`-এর নিজস্ব শেপ
অনুযায়ী একটা)। ঝুঁকি বেশি কারণ নতুন কোড, তাই আলাদা phase, D1-D4-এর মতোই
আগে হাতে-পড়ে প্রতিটা route-এর owner-column শেপ confirm করে তারপর builder
লেখা।

**Output**: দুটো নতুন `ResourceRefBuilder` + factory, `CHANGES_ROUTE_
INTEGRATION_PHASE_E5.md`। প্রত্যাশিত shrink: ~১০ route (যদি triage-এ সব
সত্যিই simple owner-column শেপ প্রমাণিত হয়; নাহলে আংশিক)।

## E6 — Long-tail triage: বাকি ~৩৪টা ফাইল, ~৮০ route

`local-accounts.ts` (৭), `marketplace.ts` + satellite ফাইল (~২৫ মোট),
`vault-snapshot.ts`/`vault-backup-cloud.ts` (~৮), আর ~২৫টা ফাইলে ১-২টা
করে বাকি (`auth.ts`, `content.ts`, `emergency-access.ts`, `messages.ts`,
`oidc-register.ts`, `tools.ts`, `vault-shares.ts`, `vault.ts`, `wallets.ts`,
`watchlist.ts`, ইত্যাদি)। D4 (Season D) এগুলো batch triage করেছিল কিন্তু
"raw-SQL-scoped-safe" বলে বেসলাইনে রেখে দেওয়া ছিল যথেষ্ট — প্রতিটার জন্য
নতুন resource-builder বানানো তখন scope-এ ছিল না। এই ফেজে সেই একই ~৮০
route আবার দেখা হবে, এবার প্রশ্নটা "safe কিনা" না (সেটা D4 already
confirm করেছে) বরং **"wire করার cost-বেনিফিট আছে কিনা"** — যে ফাইলে ৫+
route একই owner-shape share করে (যেমন `marketplace.ts` family) সেখানে
একটা builder অনেকগুলো route কভার করবে, বেনিফিট বেশি; যেখানে ১-২টা
isolated route, সেখানে নতুন builder বানানোর cost তার নিজের বেনিফিটের
তুলনায় বেশি হতে পারে — সেগুলো **ইচ্ছাকৃতভাবে বেসলাইনে থেকে যাওয়াই
সঠিক সিদ্ধান্ত** হতে পারে, D4-এর precedent-এর মতোই।

**Output**: findings doc প্রথমে (C18/D1-D4-এর precedent) — বড় cluster
(marketplace family, local-accounts.ts) কোড পায়; isolated single-route
ফাইলগুলো একটা explicit "intentionally not wired, cost > benefit" নোট
পায় বেসলাইনের নিজের `_comment`-এর পাশে বা একটা সাথের doc-এ, যাতে ভবিষ্যতে
কেউ আবার এই একই প্রশ্ন না তোলে।

## E7 — Close-out: baseline final shrink + Season E addendum

D8-এর নিজস্ব pattern অনুসরণ করে:
1. E1-E6-এর সব কাজ শেষে `--update-baseline` চালিয়ে চূড়ান্ত সংখ্যা বসানো।
2. `auditFinanceOwnership()`/`auditProjectsOwnership()` helper দুটো যদি
   E2/E3-এর পরে সত্যিই সব caller হারিয়ে dead code হয়ে যায়, সেগুলো সরানো।
3. `CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`-এর reference table-এ (D8
   ইতিমধ্যে যেখানে "Season D — সম্পূর্ণ disposition" যোগ করেছিল) একটা
   নতুন "Season E — সম্পূর্ণ disposition" সেকশন যোগ করা — কয়টা promote
   হলো, কয়টা ইচ্ছাকৃতভাবে থেকে গেল (আর কেন), চূড়ান্ত বেসলাইন সংখ্যা।

---

## Sizing note

| ফেজ | Scope | Route | Dependency | ঝুঁকি |
|---|---|---|---|---|
| E1 | `finance.ts` book + entry-derived | ১৩ | কিছু না | কম — বিদ্যমান builder reuse (✅ সম্পূর্ণ) |
| E2 | `finance.ts` বাকি সব audit-only group | ১৮ | E1-এর ordering-note | কম — একই pattern, বেশি group |
| E3 | `projects.ts` raw-SQL/audit-only | ~৭ | প্রথমে re-triage | মাঝারি — bucket সংখ্যা re-confirm লাগবে |
| E4 | `teams.ts` leader-half audit-only | ০-২ | প্রথমে triage (D6 বিরুদ্ধে না যাওয়া) | কম — বেশিরভাগ probably no-op |
| E5 | নতুন builder: mailbox + vault-attachments | ~১০ | হাতে owner-column শেপ যাচাই | মাঝারি-বেশি — নতুন কোড |
| E6 | Long-tail ~৩৪ ফাইল triage | ~৮০ (আংশিক wire হবে) | কিছু না, D4-এর findings থেকে শুরু | মাঝারি — cost/benefit বিচার দরকার প্রতি ফাইলে |
| E7 | Close-out | — (tooling/docs) | E1-E6 সব | কম — tooling/doc only |

মোট সম্ভাব্য shrink যদি E1-E6 সবটা পুরোপুরি সফল হয়: ১৫৪ থেকে আনুমানিক
~৩৫-৪৫-এ (ঠিক কতটা E6-এর cost/benefit সিদ্ধান্তের উপর নির্ভরশীল — কিছু
isolated route ইচ্ছাকৃতভাবে বেসলাইনে থেকে যাবে, এটাও একটা ভালো ফলাফল,
D4/D8-এর নিজস্ব নীতির মতোই)। Public/token/self-scoped/login-gate shape
(~৪০-৫০টা route, সব ফাইল জুড়ে) কোনো ফেজেই wire হবে না — সেটা এই
backlog-এর স্থায়ী, সঠিক অংশ, "bug" না।

## এই roadmap তৈরির সময় ব্যবহৃত পদ্ধতি (transparency-এর জন্য)
E1 বাস্তবে চালিয়ে দেখা গেছে (কোড এডিট + `tsx scripts/src/check-ownership-
gate-coverage.ts` + `--update-baseline`, দুটোই globally-installed
`typescript`/`tsx` দিয়ে সত্যিই রান করে বেসলাইন ১৫৪→১৫১→১৪১ কনফার্ম করা
হয়েছে)। E2-E7-এর route সংখ্যা D8-এর নিজস্ব close-out টেবিল আর বর্তমান
`ownership-gate-baseline.json`-এর file-by-file breakdown থেকে গণনা করা —
প্রতিটা group-এর ভেতরের bucket-বিভাজন (কোনটা raw-SQL/audit-only বনাম
public/self-scoped) D8-এর নিজস্ব ফাইল-বাই-ফাইল টেবিল থেকে নেওয়া, নতুন করে
হাতে-verify করা হয়নি — ঠিক D1-D4-এর roadmap যেমন নিজের bucket সংখ্যাকে
"প্রাথমিক অনুমান, চূড়ান্ত সত্য না" বলেছিল, এখানেও একই সতর্কতা প্রযোজ্য।
