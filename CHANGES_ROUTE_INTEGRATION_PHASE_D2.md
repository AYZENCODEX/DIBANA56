# Route Integration Roadmap — Season D, Phase D2: `finance.ts` + `finance-invoices.ts` triage (৪৬ route)

## Scope
D1-এর ঠিক পরের ব্যাচ — `finance.ts` (৩৫টা flagged param route) +
`finance-invoices.ts` (১১টা)। Roadmap-এর নিজস্ব sizing note ৩৬টা
অনুমান করেছিল (heuristic); হাতে-verify করা বেসলাইন সংখ্যা আসলে **৪৬**
— পার্থক্যটা প্রত্যাশিত (roadmap নিজেই স্বীকার করেছিল সংখ্যাগুলো
প্রাথমিক অনুমান)। প্রতিটা route নিজে পড়ে classify করা হয়েছে, D1-এর
same methodology।

## ফলাফল সংক্ষেপে

| Bucket | সংখ্যা |
|---|---|
| Raw-SQL/Drizzle owner-scoped (`and(eq(id), eq(userId))` শেপ — Season B1/C3-এর ঘোষিত pattern) | ৩২ |
| Public/token-possession (unauthenticated by design, কোনো PII/ownership leak নেই) | ৭ |
| Public/token + login-required self-scoped write (payer নিজের claim জমা দেয়) | ১ |
| ইতিমধ্যে inline `authorize()`-এ PDP-routed (Phase C3), শুধু router-মিডলওয়্যার আর্গুমেন্ট না বলে script "unwired" দেখায় | ৬ |
| **মোট** | **৪৬** |

কোনো bucket (গ) — সত্যিই কোনো check নেই — পাওয়া যায়নি। roadmap-এর
নিজস্ব predicton ঠিক প্রমাণিত হলো: finance-এর pattern historically
(B1, C3) raw-SQL/Drizzle `and(eq(id), eq(userId))` শেপ, PDP-এর বাইরে
কিন্তু নিরাপদ।

---

## Bucket ১ — Raw-SQL/Drizzle owner-scoped, ৩২টা (`finance.ts`)

সবগুলোই একই শেপ: `db.select/update/delete(...).where(and(eq(<table>.id,
id), eq(<table>.userId, authUser.userId)))`, অথবা GET-এর ক্ষেত্রে
`assertEntryOwnership()` হেল্পার (যেটা একই শেপ একটা ফাংশনে wrap করে)।

`DELETE /finance/books/:id`, `PUT /finance/books/:id`,
`PUT /finance/books/:id/set-default`, `PUT /finance/accounts/:id`,
`DELETE /finance/accounts/:id`, `PUT /finance/assets/:id`,
`DELETE /finance/assets/:id`, `PUT /finance/goals/:id`,
`DELETE /finance/goals/:id`, `POST /finance/goals/:id/contribute`,
`PUT /finance/recurring/:id`, `DELETE /finance/recurring/:id`,
`DELETE /finance/budgets/:id`, `PUT /finance/currencies/:currency`
(টোকেন-না, ডেটা-ফিল্ড — composite `(userId, currency)` conflict-target
দিয়ে scoped), `GET /finance/journal/:id`, `DELETE /finance/journal/:id`,
`PUT /finance/report-schedules/:id`, `DELETE
/finance/report-schedules/:id`, `GET /finance/entries/:id/attachments`,
`POST /finance/entries/:id/attachments`, `GET
/finance/entries/:id/attachments/:attachmentId`, `DELETE
/finance/entries/:id/attachments/:attachmentId`, `POST
/finance/entries/:id/receipt`, `DELETE /finance/entries/:id/receipt`,
`GET /finance/entries/:id/amortization`, `POST
/finance/entries/:id/amortization/generate`, `PUT
/finance/amortization/:id/pay`, `GET /finance/assets/:id/depreciation`,
`POST /finance/assets/:id/depreciation/generate`, `PUT
/finance/depreciation/:id/post`, `GET
/finance/entries/:id/invoice-lines`, `PUT
/finance/entries/:id/invoice-lines`

দুটো জায়গায় আগে থেকেই documented bug-fix comment পাওয়া গেছে (এই ফেজে
নতুন কিছু করার দরকার নেই, শুধু কনফার্ম করা হলো ফিক্স এখনো জায়গায়
আছে):
- `DELETE /finance/assets/:id` — child-table (`financeAssetOwnersTable`)
  ownership-check-এর আগে delete হয়ে যেত (অন্য কারো asset-এর owner-ভাঙন
  guess করে destroy করা যেত); এখন owner-confirm-first।
- `PUT /finance/amortization/:id/pay` ও `POST
  /finance/payment-agreements/:id/verify` (নিচে দেখুন) — non-atomic
  read-then-write race ফিক্স, `GREATEST(0, amount - paid)` SQL-এ atomic
  subtraction।

## Bucket ২ — Public/token-possession, ৭টা

Unauthenticated by design, URL-এর unguessable token-ই একমাত্র
credential (routes নিজেরাই মন্তব্যে confirm করে) — response-এ শুধু
"safe to hand to anonymous" ফিল্ড (`fmtPublicReceipt`-এর নিজস্ব comment
দেখুন), কোনো userId/internal note/অন্য entry leak হয় না:

`finance.ts`: `GET /finance/receipt/:token`, `GET
/finance/receipt/:token/pdf`, `POST /finance/ai/sms-webhook/:token`
(SMS-forwarding app যেহেতু Bearer header পাঠাতে পারে না, token-ই একমাত্র
gate — `financeSmsWebhookToken` কলামে lookup)।

`finance-invoices.ts`: `GET /finance/invoices/public/:token`, `GET
/finance/invoices/public/:token/pdf`, `GET
/finance/payment-agreements/public/:token`, `GET
/finance/payment-agreements/public/:token/evidence-pdf`।

## Bucket ৩ — Public/token + login-required self-scoped write, ১টা

`POST /finance/invoices/public/:token/submit-payment` — token
invoice-টা identify করে (creditor-এর ownership প্রশ্ন না), `requireAuth`
শুধু payer-কে account থাকতে বাধ্য করে যাতে claim-টা তার নিজের
`payerUserId`-এ attribute করা যায়। Creditor-এর কোনো ডেটা mutate হয় না
এই কলে — নিরাপদ by construction, ownership-gate দরকার নেই কারণ
resource-টাই "যে কেউ token জানলে" অ্যাক্সেসযোগ্য হওয়ার কথা।

## Bucket ৪ — ইতিমধ্যে PDP-wired via inline `authorize()` (Phase C3), ৬টা (`finance-invoices.ts`)

teams.ts-এর D1-এ যেমন পাওয়া গিয়েছিল, এখানেও একই কারণ — router-level
মিডলওয়্যার আর্গুমেন্ট না হয়ে handler-এর ভেতরে inline `authorize()` কল,
তাই lint script-এর `PEP_WIRING_NAMES` matching miss করে:

- `PUT /finance/payment-methods/:id` (`finance.payment_method.update`)
- `PUT /finance/invoices/:id/line-items`
  (`finance.invoice.line_items.update`)
- `POST /finance/payment-agreements/public/:token/passkey/options`
  (`finance.payment_agreement.passkey_options` — payer-ownership)
- `POST /finance/payment-agreements/public/:token/passkey/verify`
  (দুইটা আলাদা `authorize()` কল — payer-ownership +
  in-memory-challenge-ownership)
- `POST /finance/payment-agreements/:id/verify`
  (`finance.payment_agreement.verify` — invoice-এর creditor-ownership)
- `POST /finance/payment-agreements/:id/dispute`
  (`finance.payment_agreement.dispute` — একই creditor-ownership শেপ)

সবক'টাই একটা module-load-time `financeInvoicesOwnershipEngine`
(PolicyEngine + `createResourceOwnershipRule()`) শেয়ার করে — teams.ts-এর
`teamsOwnershipEngine`-এর ঠিক same posture।

---

## এখনো যা বাকি
- D7 (contingent, audit-trail sweep): এই ৩২ + ৭ + ১ = ৪০টা raw-SQL/
  token route-এর কোনোটাতেই `pepDecisionObserver`-এ কেন্দ্রীয় audit
  visibility নেই (শুধু বাকেট ৪-এর ৬টা inline-`authorize()` route-এই
  আছে)। C27-এর precedent অনুযায়ী এগুলো audit-only wiring পাওয়ার
  candidate — SQL/behavior কিছু বদলাবে না।
- D8: bucket ৪-এর ৬টা route lint script-এর inline-`authorize()`-
  detection fix পেলে বেসলাইন থেকে বাদ পড়বে (D1-এর teams.ts-এর ৫টার
  সাথে combined)।
- কোনো owner-decision-pending item নেই এই ফেজে (D1-এর mission-route-এর
  মতো কোনো ambiguous case পাওয়া যায়নি)।
