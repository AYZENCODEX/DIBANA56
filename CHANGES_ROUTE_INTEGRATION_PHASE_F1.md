# Route Integration Roadmap — Phase F1: Public Route Audit Wiring

## Scope
`FINDINGS_PHASE_F1_PUBLIC_ROUTE_AUDIT.md`-এ scope করা ২০টা public/token-
possession route-এ (receipt/:token, invoices/public/:token, /r/:code,
emergency-access confirm/view, ইত্যাদি) একটা নতুন `requirePublicAudit()`
primitive দিয়ে audit-trail visibility যোগ করা — কোনো real authorization
check যোগ না (এগুলোর কোনো ownership/role fact নেই চেক করার মতো, access
আগে থেকেই URL token possession দিয়ে গেটেড), শুধু প্রতিটা request-এর একটা
observable PDP-shaped decision (requestId, reason code, `onDecision` hook)
যোগ করা — বাকি সব route যেটা পায়।

## আর্কিটেকচার ব্লকার যেটা প্রথম draft ভেঙে দিত (এবং কীভাবে ফিক্স হলো)

আসল `requirePublicAudit()` draft `requirePolicy()` (তাই `authorize()` →
`PolicyEngine.evaluate()`)-এর উপর বানানো ছিল, বাকি সব PEP helper-এর মতো।
কিন্তু `policy-engine.ts`-এর `resolveRequestOrEarlyDecision()`-এর একটা
হার্ড, ইচ্ছাকৃত invariant আছে: `subject === null` মানেই কোনো registered
rule চলার আগেই `UNAUTHENTICATED` deny — আর এই বাকেটের প্রতিটা route-এই
`req.user` নাই (`requireAuth` নেই বলেই তো এই বাকেট), মানে `subject`
সবসময় `null`। আসল draft হিসেবে wire করলে প্রতিটা লাইভ public route
(receipt view, emergency-access confirm, SMS webhook) ৪০১ দিয়ে ভেঙে
যেত — audit trail যোগ হওয়ার বদলে।

একটা fake "anonymous" role-সহ Subject বানিয়ে গেট বাইপাস করাও reject করা
হয়েছে — `types.ts`-এর নিজের doc comment এটা explicitly বারণ করে
("`null` ... deliberately a distinct case from 'a Subject with no
permissions' so PIP/PDP code can't accidentally treat 'not logged in' as
just another role")।

**ফিক্স:** `requirePublicAudit()` এখন `requirePolicy()`/`authorize()`/
`PolicyEngine.evaluate()` কোনোটাই কল করে না। বরং:
1. `policyContextFromRequest()` দিয়ে context বানায় (বাকি সব route যেভাবে বানায়, same)
2. `buildAuthorizationRequest({ subject: null, ... })` দিয়ে সত্যিকারের
   `AuthorizationRequest` বানায় — এটা বৈধ, কারণ `buildAuthorizationRequest`
   নিজেই `subject: null`-কে "unauthenticated is a valid, distinct case"
   হিসেবে allow করে (শুধু `PolicyEngine.evaluate()`-এর early-decision gate
   এটাকে auto-deny করে, request-building নিজে না)
3. `allow()` দিয়ে সরাসরি একটা ALLOW decision স্ট্যাম্প করে
4. `onDecision` (route-এ পাস করা `pepDecisionObserver`) কল করে — same audit/telemetry pipeline
5. `req.authorization` সেট করে (`enforce()` যেভাবে করে, downstream কোড consistency-র জন্য)
6. Unconditionally `next()` কল করে — কোনো deny path নেই, by construction এটা কখনো ব্লক করতে পারে না

`subject: null` honestly রিপোর্ট করে — fake role না।

## Wiring — ২০টা রুট

| ফাইল | রুট | action label |
|---|---|---|
| emergency-access.ts | POST /emergency-access/confirm/:token | emergency_access.confirm |
| emergency-access.ts | GET /emergency-access/view/:token | emergency_access.view |
| tasks.ts | GET /tasks/submissions/receipt/:token | task_receipt.view |
| tasks.ts | GET /tasks/submissions/receipt/:token/pdf | task_receipt.pdf |
| projects.ts | GET /projects/pnl-receipt/:token | project_pnl_receipt.view |
| projects.ts | GET /projects/pnl-receipt/:token/pdf | project_pnl_receipt.pdf |
| finance.ts | GET /finance/receipt/:token | finance_receipt.view |
| finance.ts | GET /finance/receipt/:token/pdf | finance_receipt.pdf |
| finance.ts | POST /finance/ai/sms-webhook/:token | finance_sms_webhook.ingest |
| earn-links.ts | GET /r/:code | earn_link.redirect |
| local-accounts.ts | GET /local-accounts/receipt/:token | local_account_receipt.view |
| local-accounts.ts | GET /local-accounts/receipt/:token/pdf | local_account_receipt.pdf |
| local-accounts.ts | GET /local-accounts/category-receipt/:token | local_account_category_receipt.view |
| local-accounts.ts | GET /local-accounts/category-receipt/:token/pdf | local_account_category_receipt.pdf |
| vault.ts | GET /vault/receipt/:token | vault_receipt.view |
| vault.ts | GET /vault/receipt/:token/pdf | vault_receipt.pdf |
| finance-invoices.ts | GET /finance/invoices/public/:token | finance_invoice_public.view |
| finance-invoices.ts | GET /finance/invoices/public/:token/pdf | finance_invoice_public.pdf |
| finance-invoices.ts | GET /finance/payment-agreements/public/:token | finance_payment_agreement_public.view |
| finance-invoices.ts | GET /finance/payment-agreements/public/:token/evidence-pdf | finance_payment_agreement_public.evidence_pdf |

সবগুলোই `requirePublicAudit("<label>", { onDecision: pepDecisionObserver })`
— বাকি সব ownership-wired route যে `pepDecisionObserver` singleton
(`middlewares/auth.ts`) ব্যবহার করে, সেটাই।

**Scope-এর বাইরে (ইচ্ছাকৃতভাবে, `FINDINGS_PHASE_F1_PUBLIC_ROUTE_AUDIT.md`-এর bucket ৩ অনুযায়ী):**
`finance-invoices.ts`-এর ৩টা `requireAuth`-গেটেড রুট (submit-payment,
passkey/options, passkey/verify) আর `auth.ts`-এর login/step-up polling
route — এগুলোতে ইতিমধ্যে একটা real authenticated subject আছে,
`requirePublicAudit()` ভুল primitive হতো (মিথ্যা বলত যে কোনো ownership
প্রশ্ন নেই)। মার্কেটপ্লেস bucket (৪a/৪b) ও বাইরে — আলাদা review লাগবে।

## Coverage script (`scripts/src/check-ownership-gate-coverage.ts`) আপডেট

`requirePublicAudit`-কে **ইচ্ছাকৃতভাবে** `PEP_WIRING_NAMES`-এ যোগ করা
হয়নি — script-এর নিজস্ব D7 নীতি অনুযায়ী ("audit-only wiring adds
observability, not a gate, and this script's job is to find gates")।
এটা করলে ঠিক সেই confusion-টাই তৈরি হতো যেটা D7 এড়াতে চেয়েছিল।

তার বদলে একটা তৃতীয়, আলাদা bucket যোগ হয়েছে — `PEP_PUBLIC_AUDIT_NAMES`
+ `isPublicAudit()` + `RouteCall.publicAudit`। একটা route যেটা
`requirePublicAudit()` কল করে, সেটা এখন:
- `wired` (real gate) হিসেবে গণনা হয় না — honest থাকে
- কিন্তু `unwired`/baseline-এও থাকে না — কারণ এটা একটা reviewed, permanently-
  accepted "no gate needed, but observable" কেস, `requirePublicAudit(...)`
  কলটাই নিজে-নিজের প্রমাণ, আলাদা baseline entry দরকার নেই

## যাচাই — script সত্যিই চালানো হয়েছে

Sandbox-এ globally-installed `typescript`/`tsx` পাওয়া গেছে (D8-এর মতো —
রিপোর নিজস্ব `node_modules` নেই, শুধু module-resolution-এর জন্য একটা
সাময়িক local symlink বসানো হয়েছিল, verification শেষে সরিয়ে ফেলা হয়েছে,
কোনো repo ফাইল বদলায়নি)।

```
$ tsx scripts/src/check-ownership-gate-coverage.ts
Scanned 138 route files, 487 param routes total, 121 unwired,
20 public/token-audit-only (Phase F1, not counted as a gap).

OK — no new unwired param routes (121 pre-existing gap(s) in baseline, unchanged).

Note: 20 baseline entries no longer match an unwired route
(now wired, or removed) — run with --update-baseline to shrink the baseline:
  [ঠিক আমাদের wire করা ২০টা রুট, একটাও কম-বেশি না]
```

`--update-baseline` চালানো হয়েছে: **১৪১ → ১২১** (২০টা কমেছে, ঠিক এই ফেজে
wire করা ২০টা রুট — একটাও অপ্রত্যাশিত entry বাদ যায়নি বা যোগ হয়নি)। Re-run
ক্লিন পাস করে।

`pep/middleware.ts`-এর নতুন `requirePublicAudit()` ফাংশন আলাদাভাবে
TypeScript compiler API দিয়ে syntax-parse করা হয়েছে — ০ parse
diagnostic।

**Real `tsc --noEmit` চালানো যায়নি** — D6/D7/D8-এর নিজস্ব সীমাবদ্ধতা,
রিপোর `@workspace/db`/`express`/`drizzle-orm`-এর জন্য কোনো installed
`node_modules` নেই। merge-এর আগে বাস্তব টুলচেইনে `pnpm --filter
@workspace/api-server typecheck` চালানো উচিত।

## এখনো খোলা, তোমার সিদ্ধান্ত লাগবে (F1-এর scope না, কিন্তু এই কাজের সময় নজরে পড়েছে)
- `earn-links.ts`-এর `/r/:code` raw SQL বানায় manual quote-escaping দিয়ে
  (`code.replace(/'/g, "''")`), parameterized query না — SQL injection
  risk, আলাদা ফিক্স দরকার।
- `marketplace.ts`-এর `GET /marketplace/listings/:id/history` পুরো row
  (`SELECT *`) রিটার্ন করে `marketplace_activity_log` থেকে — internal
  column leak হতে পারে, schema check করা দরকার।
- Bucket ৩ (৪টা), bucket ৪a/৪b (১৭টা marketplace route) — `FINDINGS_PHASE_F1_PUBLIC_ROUTE_AUDIT.md`-তে যেমন ছিল, তেমনই খোলা।
