# Route Integration Roadmap — Season B, Phase B1: Finance Ownership (`requireOwnership()`)

## যা আগে থেকেই ছিল
- `routes/finance.ts`-এর Parties / Ledger entries / Repayments — এই তিন
  জায়গার প্রতিটা route শুধু `requireAuth` দিয়ে protected ছিল, তারপর নিজের
  হাতে-লেখা `eq(table.userId, authUser.userId)` (parties-এর ক্ষেত্রে ইনলাইন
  `where`, entries-এর ক্ষেত্রে `assertEntryOwnership()`) দিয়ে ownership scope
  করত। এই scoping **কাজ করত** — একজন user আরেকজনের party/entry/repayment
  কখনো touch করতে পারত না — কিন্তু পুরোপুরি PDP-র বাইরে, invisible: কোনো
  `Decision`, কোনো reason code, `authorization_audit_log`-এ কোনো row না,
  `authorization-telemetry`-তে কোনো count না।
- `lib/policy/pep/middleware.ts`-এর `requireOwnership()` (Phase 19) আগে
  থেকেই সম্পূর্ণ আর টেস্ট করা ছিল, কিন্তু `routes/*.ts`-এর কেউ কখনো call করত
  না (roadmap-এর নিজের ভাষায়: "Season B has not started")।
- `middlewares/auth.ts`-এর `pepDecisionObserver` (Phase A3) module-local
  ছিল — শুধু `requireRole()`-based checks (`requireAdmin`/`requireDev`/
  `requireRoles`)-এর জন্য ব্যবহৃত হতো, export হতো না।

## যেটা যোগ করা হলো (Phase B1)
`routes/finance.ts`-এর Parties/Ledger-entries/Repayments-এর যে ৬টা route
একটা EXISTING রেকর্ড read/update/delete করে (list/create routes বাদ —
নিচের "কেন list/create বাদ" অংশ দেখুন), প্রতিটাতে `requireAuth`-এর পরে,
handler-এর আগে একটা নতুন `requireOwnership()` (PDP-backed) middleware যোগ
করা হলো:

| Route | নতুন middleware | action |
|---|---|---|
| `PUT /finance/parties/:id` | `requireFinancePartyOwnership` | `finance.party.update` |
| `DELETE /finance/parties/:id` | `requireFinancePartyOwnership` | `finance.party.delete` |
| `PUT /finance/entries/:id` | `requireFinanceLedgerEntryOwnership` | `finance.entry.update` |
| `DELETE /finance/entries/:id` | `requireFinanceLedgerEntryOwnership` | `finance.entry.delete` |
| `GET /finance/entries/:id/repayments` | `requireFinanceLedgerEntryOwnership` | `finance.repayment.read` |
| `POST /finance/entries/:id/repayments` | `requireFinanceLedgerEntryOwnership` | `finance.repayment.create` |

### হাতে-লেখা ownership scoping সরানো হয়নি — এটা একটা **দ্বিতীয়**, PDP-routed চেক
`eq(table.userId, authUser.userId)` scoping (parties) আর
`assertEntryOwnership()` (entries/repayments) — প্রতিটা handler-এর ভেতরের
এই চেক **অপরিবর্তিত** রাখা হয়েছে (Rule: কাজ করা সিস্টেম সরানো হয় না)। নতুন
`requireOwnership()` middleware এটার আগে বসে একটা আলাদা, স্বাধীন চেক করে —
defense-in-depth, একটা replace না। এই ফেজের আসল যোগফল **protection** না
(সেটা আগে থেকেই ছিল) — **observability**: Finance-এর ownership decision
এখন প্রথমবারের মতো PDP-র মধ্য দিয়ে যায়, `requestId`/reason code পায়, আর
Phase A3-এর `pepDecisionObserver`-এর মধ্য দিয়ে `authorization_audit_log`-এ
একটা durable row হয়ে বসে + `authorization-telemetry`-তে গণনা হয় — ঠিক Season
A যেভাবে RBAC-based route-গুলোর জন্য করেছিল, Season B সেটাই ownership-based
route-গুলোর জন্য করল।

### Resource builder — DB থেকে আসল owner পড়ে, client-supplied কিছু trust করে না
`financePartyResource`/`financeLedgerEntryResource` (দুটোই
`ResourceRefBuilder`) `:id` দিয়ে সরাসরি DB থেকে রেকর্ডের real
`userId`/`ownerId` পড়ে — কখনো request body/query থেকে ownerId নেয় না, ঠিক
`ownership-rule.ts`-এর নিজের header-এ বলা trust boundary মেনে।
`financeLedgerEntryResource` দুটো repayment route-এই reuse করা হয়েছে —
`POST/GET /finance/entries/:id/repayments`-এর `:id` আসলে parent ledger
entry-র id (repayment-এর নিজের id না), তাই ownership প্রশ্নটা entries-এর
ঠিক একই প্রশ্ন।

### একটা রেকর্ড যেটা আদৌ নেই — সেটা এখনো একটা DENY, কোনো thrown wiring error না
`requireOwnership()`-এর নিজের ডকুমেন্টেড আচরণ: `resource.ownerId` unset
থাকলে সেটা একটা construction-time ভুল ধরে নেয় (`next(err)` → 500) — একটা
resource builder যেটা ভুলে `ownerId` populate করেনি তার জন্য ঠিক, কিন্তু
"`:id`-র রেকর্ডটাই নেই" এই কেসের জন্য ভুল। তাই `FINANCE_OWNER_SENTINEL_NONE`
(`-1` — কখনো কোনো real `usersTable.id` না, যেটা positive serial) ব্যবহার
করা হয়েছে: রেকর্ড না পেলে `ownerId: -1` রিটার্ন হয়, ownership rule সেটার
সাথে কোনো subject.userId মেলাতে পারে না (abstain), শুধু ওই rule-ই
registered থাকায় `PolicyEngine`-এর default-deny (`NO_MATCHING_POLICY`) এ
পড়ে — একটা normal, auditable DENY, কোনো 500 না।

### বাইরের response shape অপরিবর্তিত (A2-এর মতোই `onDeny` দিয়ে)
`requireOwnership()`-এর নিজস্ব default DENY rendering (403, generic body)
ব্যবহার না করে, `requireFinancePartyOwnership`/`requireFinanceLedgerEntryOwnership`
প্রতিটাই নিজের `onDeny` পাস করে — ঠিক আগে এই route-গুলো যা রিটার্ন করত তাই:
`404 { error: "Not found" }` (parties) বা `404 { error: "Entry not found" }`
(entries/repayments)। এটা ইচ্ছাকৃত: এই ফেজের আগে "রেকর্ড নেই" আর "রেকর্ড আছে
কিন্তু তোমার না" — দুটোই একই 404 হিসেবে দেখা যেত (কখনো existence leak হতো
না, কারণ handler-এর নিজের query সবসময় `id` আর `userId` দুটো দিয়েই scoped
ছিল)। নতুন PEP middleware ঠিক সেই একই দুটো কেসকে একই 404-এ ম্যাপ করে
(sentinel owner-id trick, উপরে) — caller-এর কাছে দৃশ্যমান কিছুই বদলায়নি,
শুধু ভেতরে এখন একটা real `AuthorizationDecision` আছে।

### কেন list/create route বাদ
- `GET /finance/parties`, `GET /finance/entries` — এগুলো list, single
  resource-এর ownership প্রশ্ন হয় না (already query-scoped by userId,
  `requireOwnership()`-এর জন্য কোনো single `:id` নেই)।
- `POST /finance/parties`, `POST /finance/entries`,
  `POST /finance/entries/:id/repayments`-এর মতো create — wait, শেষেরটা
  আসলে "creates a repayment against an EXISTING entry", তাই এটা তালিকায়
  আছে (উপরের টেবিল দেখুন)। কিন্তু `POST /finance/parties`/`POST
  /finance/entries` নিজেরাই একটা নতুন রেকর্ড বানায় — কোনো আগে-থেকে-থাকা owner
  নেই যার সাথে তুলনা করা যায় (creator নিজেই সবসময় owner, `userId:
  authUser.userId` দিয়ে insert হয়)। `requireOwnership()` একটা EXISTING
  resource-এর `ownerId === subject.userId` চেক করে — একটা not-yet-created
  resource-এর জন্য এই প্রশ্নটা অর্থহীন।

### `pepDecisionObserver` — এখন export করা, একটাই instance পুরো অ্যাপে
`middlewares/auth.ts`-এর `pepDecisionObserver` (Phase A3, module-local
ছিল) এই ফেজে `export` করা হলো, `routes/finance.ts` সেটাই import করে নিজের
`requireOwnership()` কলে পাস করে — একটা দ্বিতীয়, আলাদা
`DrizzleAuthorizationAuditWriter`/`composeObservers` instance বানানো
হয়নি। ফলে RBAC-PEP shim (Phase A2/A3)-এর decision আর Finance ownership
(Phase B1)-এর decision — দুটোই একই audit table/metrics registry-তে গিয়ে
পড়ে, দুইটা আলাদা observability path তৈরি হয়নি।

### Backend

| ফাইল | পরিবর্তন |
|---|---|
| `artifacts/api-server/src/middlewares/auth.ts` | `pepDecisionObserver` const-টা `export const` করা হলো; এর উপরের comment-এ Phase B1-এর reuse note যোগ |
| `artifacts/api-server/src/routes/finance.ts` | `requireOwnership` (`../lib/policy/pep/middleware`), `ResourceRefBuilder` (`../lib/policy/pep/types`), `pepDecisionObserver` (`../middlewares/auth`) import; `Request`/`Response` টাইপ import (`express`); নতুন `FINANCE_OWNER_SENTINEL_NONE`, `financePartyResource`, `financeLedgerEntryResource`, `requireFinancePartyOwnership()`, `requireFinanceLedgerEntryOwnership()` — Parties section-এর ঠিক আগে; ৬টা route-এ (উপরের টেবিল) নতুন middleware যোগ। কোনো existing handler body/query/response shape বদলানো হয়নি। |

## এখনো যা যোগ হয়নি (ইচ্ছাকৃতভাবে, পরের ফেজ)
- **Vault** (`requireStepUp()` + ownership, Phase B2) আর **Admin consoles
  নিজেরা** (Phase B3, dogfooding) — এখনো শুরু হয়নি।
- Finance module-এর নিজের বাকি অংশ (Books, Attachments, Assets, Budgets,
  Recurring rules, Goals, AI quick-entry ইত্যাদি) — roadmap doc নির্দিষ্টভাবে
  শুধু "parties, ledger, repayments" বলেছিল; `attachments`-এর
  `assertEntryOwnership()` call-গুলো (একই pattern, একই ফাইলে) ইচ্ছাকৃতভাবে
  touch করা হয়নি — এই ফেজের scope-এর বাইরে, একটা ভবিষ্যৎ mechanical
  batch-এর কাজ।
- `finance-invoices.ts` — আলাদা route file, এই ফেজে touch হয়নি।
- Parties/entries-এর RBAC দিকটা (কোনো role-based override, যেমন "admin
  role হলে সবার entry দেখতে পারবে") এখনো নেই — শুধু ownership rule একা
  registered, তাই non-owner সবসময় abstain → default-deny। ভবিষ্যতে দরকার
  হলে `requirePolicy()` দিয়ে একই engine-এ ownership + RBAC দুটো rule একসাথে
  register করে "owner OR admin" বানানো যাবে — এই ফেজ সেই দরজা বন্ধ করেনি,
  কিন্তু খোলেওনি।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE: একজন
owner নিজের party/entry/repayment-এ যা আগে করতে পারত, এখনো ঠিক তাই করতে
পারে (একই status code, একই body)। একজন non-owner আগেও 404 পেত (নিজের হাতে
লেখা scoping-এর কারণে), এখনো 404-ই পায় (নতুন PEP layer-এর `onDeny` সেটাই
render করে) — শুধু এখন সেই deny-টা প্রথমবারের মতো PDP-র মধ্য দিয়ে গিয়ে audit
হয়। কোনো legitimate owner flow ভাঙার কথা না।

## যা টেস্ট করা হয়েছে
- দুটো edited ফাইলের (`routes/finance.ts`, `middlewares/auth.ts`)
  bracket/brace/paren balance স্ক্রিপ্ট দিয়ে চেক করা হয়েছে — সব শূন্যে মেলে।
- `tsc --noEmit --skipLibCheck` (standalone, `--moduleResolution bundler`,
  node_modules ইনস্টল না থাকায় project-mode-এর বদলে) দুটো ফাইলের উপর চালানো
  হয়েছে। যে noise এসেছে তার সবটাই pre-existing, edited লাইনগুলোর বাইরের
  (missing `@types/node`, implicit-any যেখানে Express-এর নিজের callback
  overload resolve করতে পারেনি — ঠিক Phase A1/A2-এর CHANGES doc-এ যে একই
  ধরনের baseline noise লেখা আছে)। নতুন যোগ করা identifier-গুলো
  (`financePartyResource`, `financeLedgerEntryResource`,
  `requireFinancePartyOwnership`, `requireFinanceLedgerEntryOwnership`,
  `FINANCE_OWNER_SENTINEL_NONE`, `requireOwnership`, `pepDecisionObserver`,
  `ResourceRefBuilder`) নিয়ে grep করে confirm করা হয়েছে — এদের কারো নামে
  একটাও error আসেনি।
- `requireOwnership()`-এর সিগনেচার (`action: string, resource:
  ResourceRefBuilder, options: PepMiddlewareOptions`) আর `ResourceRef`-এর
  shape (`type`, `id?: string|number`, `ownerId?: number`) সরাসরি
  `lib/policy/pep/middleware.ts`/`lib/policy/types.ts` পড়ে মিলিয়ে দেখা
  হয়েছে — কোনো mismatch নেই।
- `pepDecisionObserver` export circular-import risk যাচাই করা হয়েছে:
  `routes/finance.ts` → `middlewares/auth.ts` — এই দিকটাই আগে থেকে ছিল
  (`requireAuth`/`getRequestUser` ইতিমধ্যে ওখান থেকে import হতো); উল্টো
  দিকে `middlewares/auth.ts` কখনো `routes/*.ts` import করে না।
- ম্যানুয়ালি reasoning করে দেখা হয়েছে: `FINANCE_OWNER_SENTINEL_NONE = -1`
  কখনো কোনো real `usersTable.id`-র সাথে মিলবে না (Postgres serial শুরু হয়
  ১ থেকে, negative কখনো issue হয় না) — তাই sentinel trick রেসেস-প্রুফ।
