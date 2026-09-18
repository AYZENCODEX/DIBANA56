# Route Integration Roadmap — Season E, Phase E1: `finance.ts` book + entry-derived groups, audit-only → enforcing

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_En.md`-এর E1 — Season D-এর ১৫৪-route
"future hygiene backlog"-এর প্রথম batch: `finance.ts`-এর ১৩টা route, যেগুলো
D7-এ `auditFinanceOwnership()`-এর মাধ্যমে audit-only wiring পেয়েছিল
(`.decision.effect` কখনো চেক হয় না, কখনো block করে না), সেগুলোকে B1-এর
আসল, blocking `requireOwnership()` gate-এ promote করা হলো।

**কোনো SQL/behavior বদলায়নি** — প্রতিটা route-এর pre-existing
`and(eq(<table>.id, id), eq(<table>.userId, authUser.userId))` /
`assertEntryOwnership()` scoping ঠিক আগের মতোই আছে (Rule: don't remove a
working system)। যা বদলেছে তা শুধু: (১) ownership decision এখন request
পৌঁছানোর আগেই router-level middleware হিসেবে block করে, audit-only
discard-এর বদলে, আর (২) `check-ownership-gate-coverage.ts` এখন এই
route-গুলোকে সঠিকভাবে "wired" হিসেবে চেনে।

## কেন এই দুটো group প্রথমে

D2 (Season D)-এর triage-এ `finance.ts`-এর ৩২টা raw-SQL-scoped route পাওয়া
গিয়েছিল, D7 সবগুলোকে audit-only visibility দিয়েছিল। এর মধ্যে ১৩টা এই ফেজে
promote করার জন্য বেছে নেওয়া হয়েছে দুটো কারণে:

1. **Book group (৩ route)** — `financeBookResource` আর তার
   `ResourceRefBuilder` ইতিমধ্যেই `makeFinanceOwnerResource()` দিয়ে বানানো
   ছিল, শুধু audit engine-এ আটকে ছিল। প্রতিটা route-এর নিজস্ব 404 message
   একই ("Not found") — party group-এর মতোই simple bijection।
2. **Entry-derived group (১০ route: attachments ৪, receipt ২,
   amortization ২, invoice-lines ২)** — এগুলো `financeLedgerEntryResource`/
   `requireFinanceLedgerEntryOwnership()` re-use করে, যেটা B1 থেকেই
   router-level blocking middleware হিসেবে বিদ্যমান আর ফাইলের শুরুর দিকে
   ঘোষিত (কোনো ordering সমস্যা নেই) — আর প্রতিটার নিজস্ব 404 message একই
   ("Entry not found")। সবচেয়ে কম ঝুঁকিপূর্ণ, সবচেয়ে বড় batch।

বাকি ১৮টা (asset, goal, recurring, budget, account, journal, report-schedule,
amortization/depreciation-on-their-own-id groups) ইচ্ছাকৃতভাবে এই ফেজে বাদ —
প্রতিটার নিজস্ব `*Resource`/`*AuditEngine` জোড়া bookgroup-এর মতো routes-এর
*পরে* ঘোষিত, তাই promote করতে হলে E1-এর মতোই ordering সমস্যা সামলাতে হবে
(নিচের "ordering ফাঁদ" নোট দেখুন) — সেগুলো E2+-এ, একবারে একটা group।

## একটা ordering ফাঁদ যা প্রতিটা future promotion-এ মনে রাখতে হবে

`auditFinanceOwnership()`-এর inline call handler body-র *ভেতরে* থাকায়
lazily (request-time-এ) evaluate হয় — তাই `financeBookResource` ইত্যাদি
resource builder-গুলো module-এর নিচের দিকে (লাইন ~৩০০+) ঘোষণা করা নিরাপদ
ছিল, যদিও তাদের ব্যবহারকারী route (`router.put("/finance/books/:id", ...)`)
ফাইলের অনেক আগে (লাইন ~১৩১)। `requireOwnership()`-কে router-level
middleware হিসেবে ব্যবহার করলে তা route-registration সময়ে (module
top-to-bottom eval, `router.put(...)` কল হওয়ার মুহূর্তে) invoke হয় —
সেই মুহূর্তে resource builder const-টা এখনো initialize না হয়ে থাকলে
temporal-dead-zone `ReferenceError` ছোড়ে।

Book group-এর জন্য এই ফাঁদ এড়াতে `financeBookResource`-এর declaration
(`makeFinanceOwnerResource("finance.book", financeBooksTable)`) ফাইলের
নিচের ব্লক থেকে সরিয়ে party/entry ownership factory-দুটোর পাশে আনা হয়েছে —
এটা নিরাপদ কারণ `makeFinanceOwnerResource` নিজে একটা hoisted `function`
declaration (`const` না), তাই তার নিজের textual position-এর আগে কল করা
যায়, যতক্ষণ `FINANCE_OWNER_SENTINEL_NONE` (যেটা তার নিজের আগেই declare করা)
আগে থেকে initialize থাকে। Entry-derived group-এর কোনো সমস্যা হয়নি কারণ
`financeLedgerEntryResource`/`requireFinanceLedgerEntryOwnership()` আগে
থেকেই (B1 থেকে) ফাইলের শুরুর দিকে ঘোষিত ছিল।

## পরিবর্তনের বিস্তারিত

### Book group
- নতুন `requireFinanceBookOwnership(action)` factory, `financePartyResource`/
  `requireFinancePartyOwnership()`-এর ঠিক পাশে যোগ করা হয়েছে, একই shape:
  `requireOwnership(action, financeBookResource, { onDecision:
  pepDecisionObserver, onDeny: (res) => res.status(404).json({ error: "Not
  found" }) })`।
- `PUT /finance/books/:id`, `PUT /finance/books/:id/set-default`,
  `DELETE /finance/books/:id` — router-level middleware হিসেবে যোগ, inline
  `auditFinanceOwnership()` কল সরানো।
- পুরনো `financeBookResource`/`financeBookAuditEngine` (যেগুলো audit-only
  engine-এর সাথে ঘোষিত ছিল) সরিয়ে ফেলা হয়েছে — `financeBookResource` উপরে
  নতুন জায়গায় স্থানান্তরিত, `financeBookAuditEngine` পুরোপুরি বাদ (আর কোনো
  caller নেই)।

### Entry-derived group
- `GET/POST /finance/entries/:id/attachments`,
  `GET/DELETE /finance/entries/:id/attachments/:attachmentId`,
  `POST/DELETE /finance/entries/:id/receipt`,
  `GET/POST /finance/entries/:id/amortization[/generate]`,
  `GET/PUT /finance/entries/:id/invoice-lines` — সবগুলোতে বিদ্যমান
  `requireFinanceLedgerEntryOwnership(action)` router-level middleware
  হিসেবে যোগ করা হয়েছে, inline `auditFinanceOwnership()` কল সরানো। প্রতিটা
  handler-এর নিজস্ব `assertEntryOwnership()`/inline SQL-scoped check
  অপরিবর্তিত রাখা হয়েছে (defense-in-depth, B1-এর party/entry pattern যেমন
  রেখেছিল)।
- এখন কোনো caller না থাকায় `financeLedgerEntryAuditEngine` (D7-এর audit-only
  engine) সরানো হয়েছে; তার উপরের কমেন্টও আপডেট করা হয়েছে।
- `auditFinanceOwnership()` হেল্পার নিজে এখনো আছে — বাকি ১৮টা route (asset,
  goal, recurring, budget, account, journal, report-schedule,
  amortization/depreciation-on-own-id) এখনো এটা ব্যবহার করে; পুরো helper
  বাদ দেওয়া হবে শুধু যখন সব caller migrate হয়ে যাবে (E-এর শেষ ফেজে,
  cleanup হিসেবে)।

## যাচাই
- TypeScript compiler API দিয়ে সরাসরি syntax-parse (`ts.createSourceFile`)
  — ০ parse error, edit-এর প্রতিটা ধাপের পরে re-check করা হয়েছে।
- `tsx scripts/src/check-ownership-gate-coverage.ts` globally-installed
  `typescript`/`tsx` দিয়ে সত্যিই চালানো হয়েছে (D8-এর মতোই local
  `node_modules/typescript` সিমলিংক, শুধু module resolution-এর জন্য —
  কোনো repo ফাইল বদলায়নি):
  - Book group promote করার পরে: "3 baseline entries no longer match an
    unwired route" — `--update-baseline` চালিয়ে **১৫৪ → ১৫১**।
  - Entry-derived group promote করার পরে: "10 baseline entries no longer
    match" — `--update-baseline` চালিয়ে **১৫১ → ১৪১**।
  - প্রতিটা ধাপের পরে re-run ক্লিন পাস করেছে ("OK — no new unwired param
    routes")।
- **Real `tsc --noEmit`/DB-connected integration sandbox-এ চালানো যায়নি**
  — D6/D7/D8-এর নিজস্ব সীমাবদ্ধতার মতোই (`@workspace/db`/`express`-এর জন্য
  কোনো installed `node_modules` নেই, নেটওয়ার্ক নেই)। merge-এর আগে বাস্তব
  টুলচেইনে `pnpm --filter @workspace/api-server typecheck` (বা সমতুল্য)
  চালানো উচিত।

## ফলাফল
| আইটেম | সংখ্যা |
|---|---|
| Promote হওয়া route (audit-only → enforcing) | ১৩ (book ৩ + entry-derived ১০) |
| Baseline shrink | ১৫৪ → ১৪১ |
| SQL/behavior change | ০ — শুধু enforcement point আগে সরানো হয়েছে |
| বাকি `finance.ts` candidate (E2+) | ১৮ (asset, goal, recurring, budget, account, journal, report-schedule, amortization/depreciation own-id) |
| বাকি `finance.ts` non-candidate (unchanged) | ৪ (public token ২, self-scoped currency ১, public sms-webhook token ১) |
