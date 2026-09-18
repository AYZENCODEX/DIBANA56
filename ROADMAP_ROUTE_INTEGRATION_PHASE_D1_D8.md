# Route Integration Roadmap — Season D, Phase D1 থেকে D8

> **প্রেক্ষাপট:** Season C (`ROADMAP_ROUTE_INTEGRATION_PHASE_C26_C35.md`, C1
> থেকে C35) `routes/`-এর `:id`-shaped URL param routes-কে
> `requireOwnership()`/`authorizeMany()` দিয়ে systematically গেট করেছে,
> একটা CI lint guard (C33) বানিয়েছে যা ভবিষ্যতে নতুন gap আটকায়, আর একটা
> delta re-audit (C34) দিয়ে body-id shape-এর একটা real bug ধরে ফিক্স করে
> বন্ধ হয়েছে (C35)। কিন্তু C35-এর নিজের close-out summary-তেই স্বীকার করা
> হয়েছিল: C33-এর lint script-এর নিজস্ব baseline-এ **৩৪০টা** unwired param
> route "grandfathered" আছে, আর তার মধ্যে **২০৬টা** ("auth-only, no PDP")
> কখনো properly triage করা হয়নি — শুধু `requireAuth`-এর পেছনে আছে, categorize
> করা হয়নি safe/unsafe হিসেবে। এই ফাইলটা সেই backlog-টা close করার
> পরিকল্পনা।

## Audit context — C35-এর হ্যান্ডঅফ সংখ্যা, আর একটা নতুন nuance

C35-এর classification ছিল চার bucket-এ (মোট ৪৮৭টা param route):

| Bucket | সংখ্যা | % |
|---|---|---|
| PDP-wired (`requireOwnership`/`authorizeMany`) | ১৪৭ | ৩০.২% |
| Role/admin-gated (`requireAdmin`/`requireDev`/`requireRole`, নামযুক্ত middleware) | ১১০ | ২২.৬% |
| Public/token-possession (`:token`/`:code`) | ২৪ | ৪.৯% |
| **"Auth-only, no PDP" — untriaged** | **২০৬** | **৪২.৩%** |

Season D শুরু করার আগে সেই ২০৬-টা আবার closely দেখা হয়েছে (এই ফাইল লেখার
সময়), আর একটা গুরুত্বপূর্ণ correction পাওয়া গেছে: এই bucket-টা uniform
"ungated" না। তিনটা sub-shape স্পষ্ট:

| Sub-shape | আনুমানিক সংখ্যা | উদাহরণ |
|---|---|---|
| Inline role check (`role !== "admin"`-এর মতো, hand-written, `requireAdmin` middleware ব্যবহার করে না) | ~২২ | `teams.ts`-এর `DELETE /admin/teams/:id` (`if (role !== "admin" && role !== "operator")`) |
| Team/group-membership shape (single-owner `ownerId` না, `team_members`/`project_members` table lookup) | ~২৯ | `teams.ts`-এর `DELETE /teams/:id/members/:memberId` — **Phase C4-এ ইতিমধ্যে explicitly review করা হয়েছিল** ("leader OR self", `requireOwnership()`-এ fit করে না বলে ইচ্ছাকৃতভাবে untouched রাখা হয়েছিল, কোড-কমেন্টেও লেখা আছে) |
| বাকি — সত্যিকারের unknown, raw-SQL-scoped হতে পারে (C27-এর মতো) অথবা genuinely ungated হতে পারে (C26/C34-এর মতো) | ~১৫৫ | triage ছাড়া বলা যায় না |

মানে ২০৬-এর মধ্যে অন্তত ~৫১টা (inline-role + membership-shape) সম্ভবত
ইতিমধ্যেই নিরাপদ (হয় role-gated, নয়তো Season C-তেই একবার review করা)।
আসল unknown backlog সম্ভবত ~১৫৫টা route, ছড়িয়ে আছে বহু ফাইলে —
`teams.ts` (৫৭ মোট, membership-shape বাদ দিলে কম), `finance.ts` (৩২),
`projects.ts` (১৯), `tasks.ts` (১১), আর বাকি ~৪০টা ফাইলে ছোট ছোট সংখ্যায়
(১-৭টা করে)।

**এই ফাইলের মূল সিদ্ধান্ত: Season D "সব গেট করো" দিয়ে শুরু হবে না, শুরু
হবে triage দিয়ে** — ঠিক C18-এর "audit প্রথমে, code পরে" নীতি অনুসরণ করে,
কারণ না জেনে গেট করলে হয় false-positive fix (যেটা ইতিমধ্যে নিরাপদ, C4-এর
মতো) নয়তো missed bug (যেটা genuinely ungated, C26-এর মতো) — দুটোই ভুল।

---

## D1 — Triage batch ১: `teams.ts` (৫৭ route)

সবচেয়ে বড় ফাইল, তাই প্রথমে। প্রতিটা route-কে তিনটা bucket-এ classify
করা: (ক) inline role-gated — ঠিক আছে, শুধু `requireRole()`-এ migrate
করার optional hygiene item; (খ) membership-shape, Season C-তে review
হয়েছে কিনা কোড-কমেন্টে চেক করে confirm করা (C4-এর মতো আরও থাকতে পারে) —
থাকলে untouched রাখা ঠিক আছে, না থাকলে নতুন review দরকার; (গ) সত্যিই কোনো
check নেই — C34-এর মতো candidate বাগ, immediately flag।

**Output**: একটা findings doc (C18-এর মতো), কোনো code change বাধ্যতামূলক
না — শুধু bucket (গ)-তে কিছু পাওয়া গেলে সেটা সাথে সাথেই ফিক্স হবে
(C26/C34-এর precedent — bug পেলে অপেক্ষা করা হয় না)।

## D2 — Triage batch ২: `finance.ts` + `finance-invoices.ts` (৩৬ route)

Finance-এর pattern historically (B1, C3) `and(eq(id), eq(userId))`
combined-where SQL শেপ — সম্ভবত এই ৩৬টার বেশিরভাগ সেই একই raw-SQL-scoped-
but-PDP-বাইরে শেপ (C27-এর bulk-family ঠিক এই কারণেই আলাদা phase পেয়েছিল)।
একই triage পদ্ধতি প্রয়োগ, buckets একই তিনটা।

## D3 — Triage batch ৩: `projects.ts` + `tasks.ts` (৩০ route)

`projects.ts` C9-এ একবার touch হয়েছিল (enrollment shape, silent-200)।
এই ৩০টা route সেই সময় untouched রাখা অংশ — কেন রাখা হয়েছিল সেটা প্রথমে
C9-এর নিজের "এখনো যা বাকি" সেকশন থেকে check করা, তারপর একই triage।

## D4 — Triage batch ৪: বাকি ~৮০ route, ~৪০টা ফাইল জুড়ে (long tail)

`marketplace.ts` + marketplace satellite ফাইল (~২০ route মোট),
`vault-attachments.ts`/`vault-snapshot.ts`/`vault-backup-cloud.ts`
(~১৩), আর প্রায় ৩০টা ফাইলে ১-২টা করে বাকি। এইগুলো ছোট বলে batch করে একসাথে
triage করা — C15-C18-এর ছোট-ফাইল batching pattern অনুসরণ করে।

---

## D5 — বাগ ফিক্স (contingent, D1-D4-এর findings অনুযায়ী sized)

D1-D4-এ bucket (গ) ("সত্যিই কোনো check নেই") হিসেবে যা পাওয়া যাবে, সেটা
এই ফেজে ফিক্স হবে — C26/C34-এর precedent অনুসরণ করে (owner-prefilter বা
silent-drop, pre-existing behavior যতটা সম্ভব preserve করে)। এই ফেজের
size পুরোপুরি D1-D4-এর উপর নির্ভরশীল — যদি triage-এ কিছু না পাওয়া যায়
(সবই আসলে bucket ক/খ), তাহলে এই ফেজ স্কিপ হবে, আর সেটাও একটা ভালো ফলাফল
(C34-এর নিজের "কিছু না পেলে সেটাও প্রমাণ" নীতির মতো)।

## D6 — `createGroupMembershipRule()` — নতুন reusable PDP rule (contingent)

যদি D1-এ `teams.ts`-এর membership-shape যথেষ্ট বড়/repeated পাওয়া যায়
(২৯+ candidate), তাহলে এই শেপ-টাকে (`team_members WHERE team_id AND
user_id AND status='active'`, role read করে compare) একটা নতুন,
reusable PDP rule হিসেবে `lib/policy/resource/`-এ বানানো — ঠিক যেভাবে
`createResourceOwnershipRule()` single-owner শেপ কভার করে, এটা
"caller must have role X in group Y" শেপ কভার করবে। এতে C4-এর সময়ের
সিদ্ধান্ত ("এই শেপ `requireOwnership()`-এ ফিট করে না") উল্টানো হয় না —
`requireOwnership()` নিজে না বদলে, তার পাশে একটা নতুন rule-type যোগ করা
হয়, যেটা `PolicyEngine`-এর existing rule-registration pattern-ই reuse
করে (C27-এর bulk engine-গুলো যেভাবে করেছিল)।

## D7 — Consistency sweep: audit-trail wiring (contingent, C27-pattern)

D1-D4-এ যা bucket (খ)/raw-SQL-scoped-but-safe হিসেবে confirm হবে (Finance
সহ), সেগুলোর জন্য C27-এর precedent প্রয়োগ — কোনো SQL/behavior বদলায় না,
শুধু `authorizeMany()`-স্টাইল audit call যোগ হয় যাতে decision
`pepDecisionObserver`-এ কেন্দ্রীয়ভাবে দেখা যায়।

## D8 — CI lint guard আপডেট + baseline shrink + Season D close-out

`scripts/src/check-ownership-gate-coverage.ts`-এর `PEP_WIRING_NAMES`
সেটে D6-এ বানানো নতুন rule-type-এর wrapper pattern যোগ করা (যদি D6 হয়),
আর inline role-check pattern (`role !== "..."`) recognize করার জন্য
script-এ একটা নতুন detection branch যোগ করা — এতে ভবিষ্যতের run-এ D1-এ
hand-classify করা "safe" route-গুলো আর false "unwired" হিসেবে দেখাবে না।
`--update-baseline` চালিয়ে D1-D7-এর সব কাজ reflect করে baseline নতুন করে
generate করা — ৩৪০ থেকে সংখ্যা কমে আসা উচিত (কতটা কমবে তা D1-D4-এর আসল
findings-এর উপর নির্ভরশীল)। শেষে C35-এর reference table-এ একটা নতুন
"Season D" সেকশন যোগ করে, পুরো ২০৬-route backlog-এর চূড়ান্ত disposition
ডকুমেন্ট করা (প্রতিটা bucket-এ কয়টা গেল, কয়টা বাগ পাওয়া গেল ও ফিক্স হলো)।

---

## Sizing note

| ফেজ | Scope | Route/ফাইল | Dependency | Output |
|---|---|---|---|---|
| D1 | `teams.ts` triage | ৫৭ route, ১ ফাইল | কিছু না, প্রথমে (সবচেয়ে বড়) | Findings doc + immediate bug-fix যদি পাওয়া যায় |
| D2 | `finance.ts`/`finance-invoices.ts` triage | ৩৬ route, ২ ফাইল | কিছু না, D1-এর সমান্তরালে করা যায় | Findings doc + immediate bug-fix যদি পাওয়া যায় |
| D3 | `projects.ts`/`tasks.ts` triage | ৩০ route, ২ ফাইল | কিছু না | Findings doc + immediate bug-fix যদি পাওয়া যায় |
| D4 | Long-tail batch triage | ~৮০ route, ~৪০ ফাইল | কিছু না | Findings doc + immediate bug-fix যদি পাওয়া যায় |
| D5 | বাগ ফিক্স (roundup) | TBD | D1-D4-এর findings | কোনো bug বাকি থাকলে ফিক্স; নাহলে স্কিপ |
| D6 | `createGroupMembershipRule()` | TBD (~২৯ candidate) | D1-এর findings, বড় হলে করা | নতুন PDP rule + `teams.ts`-এ wiring |
| D7 | Consistency sweep (audit-trail) | TBD | D1-D4-এর "raw-SQL-scoped-safe" findings, C27 pattern reuse | Audit-only wiring, কোনো SQL change না |
| D8 | CI guard আপডেট + close-out | — (tooling/docs) | D1-D7 সব | Updated lint script, shrunk baseline, Season D reference-table addendum |

মোট: **৪টা triage phase** (D1-D4, প্রায় ২০৬টা route পুরোপুরি কভার করে),
**১টা contingent bug-fix phase** (D5), **১টা contingent new-rule phase**
(D6), **১টা contingent consistency phase** (D7), শেষে **১টা close-out**
(D8)। D1-D4-এর triage ফলাফলই ঠিক করবে D5-D7 আসলে কতটা কাজ — এটা
ইচ্ছাকৃতভাবে over-committed না রেখে C26/C34-এর precedent অনুসরণ করে
("audit first, size the fix from what you actually find")।

## এই roadmap তৈরির সময় ব্যবহৃত পদ্ধতি (transparency-এর জন্য)
এই ফাইলের bucket সংখ্যা (২২ inline-role, ২৯ membership-shape, ১৫৫ other)
একটা automated heuristic দিয়ে বের করা হয়েছে (snippet-এ
`role !== `/`req.user!.role !== ` বা `team_members`/`project_members`
টেবিল-নাম আছে কিনা regex-চেক) — এটা C33/C34-এর script-গুলোর মতোই একটা
**candidate-level** classification, প্রতিটা route হাতে পড়ে confirm করা
হয়নি। D1-D4-এর আসল কাজ সেই হাতে-পড়া অংশটা — এই ফাইলের সংখ্যাগুলো শুধু
phase-sizing-এর জন্য একটা প্রাথমিক অনুমান, চূড়ান্ত সত্য না।
