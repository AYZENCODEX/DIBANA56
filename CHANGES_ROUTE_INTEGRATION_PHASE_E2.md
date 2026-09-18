# Route Integration Roadmap — Season E, Phase E2: `finance.ts` বাকি ১৮টা group, audit-only → enforcing

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_E1_En.md`-এর E2 — E1-এর পরে `finance.ts`-এ
বাকি থাকা ১৮টা route (asset ২, goal ৩, recurring ২, budget ১, account ২,
journal ২, report-schedule ২, amortization-pay ১, depreciation
read+generate+post ৩) — প্রতিটার নিজস্ব `*Resource`/`*AuditEngine` জোড়া
ইতিমধ্যেই module-এ ছিল (D7), শুধু `auditFinanceOwnership()`-এর মাধ্যমে
audit-only হিসেবে আটকে ছিল — এই ফেজে সেগুলো E1-এর book group-এর মতোই আসল,
blocking `requireOwnership()`-এ promote করা হলো।

**কোনো SQL/behavior বদলায়নি** — প্রতিটা route-এর pre-existing
`and(eq(<table>.id, id), eq(<table>.userId, authUser.userId))` scoping ঠিক
আগের মতোই আছে। যা বদলেছে: (১) ownership decision এখন router-level
middleware হিসেবে request handler-এ পৌঁছানোর আগেই block করে, (২)
`check-ownership-gate-coverage.ts` এখন এই route-গুলোকে "wired" হিসেবে চেনে।

## E1-এর থেকে একটা পার্থক্য: fixed না, parametrized `onDeny`

E1-এর book/party factory-গুলো একটা single, ফিক্সড `onDeny` বেক করেছিল কারণ
সেই group-এর প্রতিটা route একই deny body শেয়ার করত। এখানে তা সত্যি না:

| Resource | Route | Pre-existing deny |
|---|---|---|
| `finance.account` | PUT | `404 "Not found or is a system account"` |
| `finance.account` | DELETE | `404 "Not found"` |
| `finance.asset` | PUT/DELETE | `404 "Not found"` |
| `finance.asset` | depreciation read/generate | `404 "Asset not found"` |
| `finance.goal` | PUT/contribute | `404 "Goal not found"` |
| `finance.goal` | DELETE | ছিল না — unconditional `{ success: true }` |
| `finance.recurring_rule` | PUT | `404 "Not found"` |
| `finance.recurring_rule` | DELETE | ছিল না — unconditional `{ success: true }` |
| `finance.budget` | DELETE | ছিল না — unconditional `{ success: true }` |
| `finance.journal_entry` | GET/DELETE | `404 "Not found"` (দুটোই একই) |
| `finance.report_schedule` | PUT | `404 "Not found"` |
| `finance.report_schedule` | DELETE | ছিল না — unconditional `{ success: true }` |
| `finance.amortization` | pay | `404 "Not found"` |
| `finance.depreciation` | post | `404 "Not found"` |

তাই `requireFinanceAssetOwnership`/`Goal`/`RecurringRule`/`Budget`/
`Account`/`ReportSchedule` — এই ছয়টা factory `onDeny` কে parameter হিসেবে
নেয় (OWNERSHIP_GATING_GUIDE.md Step 3-এর general template), আর
`requireFinanceJournalEntryOwnership`/`Amortization`/`Depreciation` — এই
তিনটা E1-এর book/party প্যাটার্নের মতোই ফিক্সড `onDeny` বেক করে, কারণ
প্রতিটার ভেতরের সব route একই deny message শেয়ার করে।

দুটো ছোট helper যোগ হয়েছে:
- `financeNotFoundDeny(message)` — একটা কনফিগারযোগ্য 404 বডি ফেরত দেয়।
- `financeSilentSuccessDeny` — `200 { success: true }` ফেরত দেয়, goal/
  recurring/budget/report-schedule-এর DELETE route-গুলোর জন্য, যেগুলোর
  pre-existing scoped delete আগে থেকেই একটা non-owned id-তে কিছু না করে
  চুপচাপ success রিপোর্ট করত (GUIDE-এর "silent no-op" deny shape — নতুন
  behavior না, শুধু আগে থেকে যা হতো সেটাই এখন request handler-এ পৌঁছানোর
  *আগে* ঘটে)।

## Cleanup — dead code সরানো

E2-এর পরে সব `*AuditEngine` const (account/asset/goal/recurring/budget/
journal/report-schedule/amortization/depreciation) আর `auditFinanceOwnership()`
হেল্পার নিজে dead code হয়ে গিয়েছিল (আর কোনো caller নেই) — সরিয়ে ফেলা হয়েছে,
সাথে তখন আর ব্যবহৃত না হওয়া `authorize`/`PolicyEngine`/
`createResourceOwnershipRule`/`ResourceRef` import-গুলোও (Rule: don't leave
an unused construct behind once its last caller is gone, E1-এই যেমন বলা
ছিল)। `*Resource` builder-গুলো (`financeAssetResource` ইত্যাদি) অপরিবর্তিত
আছে — এখন সরাসরি নতুন `requireX Ownership()` factory-গুলোর মধ্য দিয়ে গেট
হিসেবে ব্যবহৃত হয়।

`PUT /finance/currencies/:currency` **ইচ্ছাকৃতভাবে** এই ফেজের বাইরে —
E1-এর নিজস্ব note অনুযায়ী genuinely self-scoped (userId+currency দিয়ে
upsert, আলাদা কোনো resource-id নেই যার ownership চেক করার মতো) — D6-এর
self-scoped rule অনুযায়ী untouched থাকাই সঠিক।

## যাচাই
- TypeScript compiler API দিয়ে সরাসরি syntax-parse — ০ parse diagnostic।
- `tsx scripts/src/check-ownership-gate-coverage.ts` (globally-installed
  `typescript`/`tsx`, সাময়িক local `node_modules/typescript` সিমলিংক দিয়ে,
  D8/E1-এর মতোই — কোনো repo ফাইল বদলায়নি):
  ```
  Scanned 138 route files, 487 param routes total, 103 unwired,
  20 public/token-audit-only (Phase F1, not counted as a gap).

  OK — no new unwired param routes (121 pre-existing gap(s) in baseline, unchanged).

  Note: 18 baseline entries no longer match an unwired route ...
    [ঠিক এই ফেজে promote করা ১৮টা রুট — একটাও কম-বেশি না]
  ```
  `--update-baseline` চালানো হয়েছে: **১২১ → ১০৩**। Re-run ক্লিন পাস করে।
- **Real `tsc --noEmit` চালানো যায়নি** — D6-D8/E1-এর নিজস্ব সীমাবদ্ধতা
  (`@workspace/db`/`express`-এর জন্য কোনো installed `node_modules` নেই)।
  merge-এর আগে বাস্তব টুলচেইনে `pnpm --filter @workspace/api-server
  typecheck` চালানো উচিত — বিশেষ করে `financeNotFoundDeny`/
  `financeSilentSuccessDeny`-র টাইপ শেপ real `express`/`ResourceRefBuilder`
  টাইপের বিপরীতে যাচাই করার জন্য, যা TS compiler API-এর নিছক syntax-parse
  দেখতে পারে না।

## ফলাফল
| আইটেম | সংখ্যা |
|---|---|
| Promote হওয়া route (audit-only → enforcing) | ১৮ |
| Baseline shrink | ১২১ → ১০৩ |
| SQL/behavior change | ০ |
| সরানো dead code | ৯টা `*AuditEngine` const, `auditFinanceOwnership()` হেল্পার, ৪টা এখন-অব্যবহৃত import |
| `finance.ts`-এর বাকি non-candidate (ইচ্ছাকৃতভাবে unchanged) | ১ (`PUT /finance/currencies/:currency`, self-scoped) |
| Baseline-এ `finance.ts`-এর বাকি entry | ০ |
