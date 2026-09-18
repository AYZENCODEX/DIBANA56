# Route Integration Roadmap — Season C, Phase C3: Mechanical Sweep (batch 3, `finance-invoices.ts`)

## যা আগে থেকেই ছিল
Phase C1/C2 নিজেদের "এখনো যা বাকি" অংশে `finance-invoices.ts` (988 লাইন)
আর `teams.ts` (1557 লাইন)-কে "বড়, নিজের batch প্রাপ্য" বলে দুইবার touch না
করে রেখে দিয়েছিল। এই ফেজ (batch 3) `finance-invoices.ts` করল।

`support.ts`/`tasks.ts`/`passkey.ts`/`vault-reauth.ts`-এর মতো grep পুনরায়
চালানো হলো (`userId !== `/`!== .*userId`), কিন্তু ফলাফল আগের দুই ব্যাচের
চেয়ে কম সম্পূর্ণ বেরোলো — এই ফাইলে ownership বেশিরভাগ জায়গায় SQL-এ combined
(`where(and(eq(id), eq(userId)))`), C2-র নিজের `passkey.ts` PATCH/DELETE-এর
মতো, `!==` শেপ না। ফাইলটা হাতে পুরোটা পড়ে **চারটা আলাদা ownership প্রশ্ন**
পাওয়া গেল:

1. এই payment method-টা কি আমার (`payment-methods/:id`)
2. এই invoice-টা কি আমার — creditor হিসেবে (`invoices/:id`, আর একটা
   payment agreement যে invoiceId-কে point করে সেটাও)
3. এই payment agreement-টা কি আমার — কিন্তু **payer** হিসেবে (public
   Payment Agreement passkey flow — একই টেবিলের `payerUserId` column,
   #2-এর `userId`-এর চেয়ে ভিন্ন, ভিন্ন semantics)
4. এই in-memory passkey challenge-টা কি আমার — ঠিক Phase C2-র
   `passkey.ts` register/verify challenge check-এর same shape

এই ফাইলে কোনো admin bypass কোথাও নেই (Phase C1-এর `support.ts`/`tasks.ts`-এর
বিপরীতে) — প্রতিটাই "owner, full stop", ঠিক Phase C2-র মতো। তাই
`createResourceOwnershipRule()` একাই যথেষ্ট গোটা ফাইলে —
`createRoleOverrideRule()` লাগেনি, register করা হয়নি।

## যেটা যোগ করা হলো (Phase C3)

### দুটো call shape, Phase C1/C2-ই যা establish করেছিল সেটাই পুনরায় প্রয়োগ
যেখানে hand-rolled check-টাই auth-এর পরে হ্যান্ডলারের **প্রথম** কাজ (আগে
কোনো validation না, অন্য কোনো resource-এর existence check না) — সেখানে
router-level `requireOwnership()` middleware (Phase B1-র `finance.ts`
pattern) সরাসরি ব্যবহার করা হলো। যেখানে তার আগে অন্য কিছু চলে — একটা
body-shape validation (400), একটা **ভিন্ন** resource-এর existence check
(404), বা এমন একটা side-effecting write যা :id-র ownership নির্বিশেষে
চলে (payment-method-এর `isDefault` reset) — সেখানে router-level middleware
বসালে সেটা ওই বিদ্যমান ধাপের **আগে** চলত, non-owner-এর জন্য কোন
response/side-effect আগে দেখা যায় সেটা বদলে যেত — ঠিক Phase C1/C2 যে
ordering hazard `support.ts`/`tasks.ts`/`passkey.ts`-এর জন্য কাজ করে বের
করেছিল। সেই route-গুলো inline `authorize()` ব্যবহার করল, ঠিক যেখানে
ownership আগে থেকেই decide হতো সেই জায়গায়, একই posture।

| # | Route | Shape | নতুন `action` | Response gate (অপরিবর্তিত) |
|---|---|---|---|---|
| 1 | `DELETE /finance/payment-methods/:id` | router-level `requireOwnership()` | `finance.payment_method.delete` | `404 { error: "Payment method not found" }` |
| 2 | `GET /finance/invoices/:id` | router-level `requireOwnership()` | `finance.invoice.read` | `404 { error: "Invoice not found" }` |
| 3 | `GET /finance/invoices/:id/pdf` | router-level `requireOwnership()` | `finance.invoice.read_pdf` | `404 { error: "Invoice not found" }` |
| 4 | `POST /finance/invoices/:id/send` | router-level `requireOwnership()` | `finance.invoice.send` | `404 { error: "Invoice not found" }` |
| 5 | `DELETE /finance/invoices/:id` | router-level `requireOwnership()` | `finance.invoice.cancel` | `404 { error: "Invoice not found" }` |
| 6 | `POST /finance/invoices/:id/reopen` | router-level `requireOwnership()` | `finance.invoice.reopen` | `404 { error: "Invoice not found" }` |
| 7 | `PUT /finance/payment-methods/:id` | inline `authorize()`, add-new-keep-old (`isDefault` reset side-effect আগে চলে, unchanged) | `finance.payment_method.update` | `404 { error: "Payment method not found" }` |
| 8 | `PUT /finance/invoices/:id/line-items` | inline `authorize()`, add-new-keep-old (`lineItems` shape validation আগে চলে, unchanged) | `finance.invoice.line_items.update` | `404 { error: "Invoice not found" }` |
| 9 | `POST /finance/payment-agreements/:id/verify` | inline `authorize()`, add-new-keep-old (agreement existence — ভিন্ন resource — আগে চলে, unchanged) | `finance.payment_agreement.verify` | `404 { error: "Invoice not found" }` |
| 10 | `POST /finance/payment-agreements/:id/dispute` | inline `authorize()`, add-new-keep-old (`reason` validation + agreement existence আগে চলে, unchanged) | `finance.payment_agreement.dispute` | `404 { error: "Invoice not found" }` |
| 11 | `POST /finance/payment-agreements/public/:token/passkey/options` | inline `authorize()`, **direct replacement** (already-fetched `agreement.payerUserId` reuse, নতুন query লাগেনি) | `finance.payment_agreement.passkey_options` | `403 { error: "This payment agreement doesn't belong to your account." }` |
| 12 | `POST /finance/payment-agreements/public/:token/passkey/verify` (payer ownership) | inline `authorize()`, direct replacement | `finance.payment_agreement.passkey_verify` | `403 { error: "..." }` (same) |
| 13 | `POST /finance/payment-agreements/public/:token/passkey/verify` (challenge ownership — দ্বিতীয়, আলাদা প্রশ্ন) | inline `authorize()`, direct replacement (existence hand-rolled থাকল, শুধু ownership-এর অংশটা PDP-তে) | `finance.payment_agreement.passkey_challenge.verify` | `400 { error: "Challenge expired or invalid. Try again." }` |

### router-level বনাম inline বেছে নেওয়ার যুক্তি, route-ভিত্তিক
- **#1–6**: `requireAuth` আর id-parse ছাড়া ownership lookup-এর আগে হ্যান্ডলারের
  আর কিছু চলে না — router-level `requireOwnership()` নিরাপদে বসানো যায়,
  ঠিক `finance.ts`-এর Phase B1 parties/ledger-entries রুটগুলোর মতো (handler
  নিজের existing combined-where query/404 **অপরিবর্তিত** রেখে দেয়, এখন
  technically unreachable defensive fallback হিসেবে — একদম B1/C1/C2-এর
  established পদ্ধতি)।
- **#7 (`PUT /payment-methods/:id`)**: `isDefault` truthy হলে requester-এর
  **নিজের** অন্য payment method-গুলোর `isDefault` রিসেট হয় — এটা :id-র
  ownership নির্বিশেষে চলে (existing quirk, এই ফেজ touch করেনি)।
  Router-level middleware বসালে non-owner-এর জন্য এই side-effect-টাই আর
  ঘটত না (middleware আগেই 404 দিয়ে দিত) — সেটা একটা real behavior change,
  তাই inline `authorize()` বসানো হলো ঠিক reset-এর **পরে**, existing
  combined-where update-এর **আগে** — reset-টা এখনো unconditional, অপরিবর্তিত।
- **#8 (line-items)**: `lineItems` array-shape validation (400) সবসময় প্রথমে
  চলে, তারপর ownership। Inline `authorize()` ওই validation-এর পরেই বসানো
  হলো, তারপর existing filtered SELECT অপরিবর্তিত রাখা হয়েছে (defensive)।
- **#9/#10 (verify/dispute)**: `:id`-টা payment agreement-এর id, কিন্তু
  আসল ownership প্রশ্নটা তার **linked invoice**-এর উপর। Agreement-এর
  existence check (404 "Payment agreement not found") একটা সম্পূর্ণ ভিন্ন
  resource-এর প্রশ্ন — C1-এর নিজের নীতি অনুযায়ী ("record না পেলে 404 —
  ownership-এর অংশ না") hand-rolled-ই থাকল। তারপর invoice-এর real owner
  একটা নতুন, unfiltered SELECT দিয়ে পড়া হলো (`agreement.invoiceId`-র
  বিপরীতে, client-supplied কিছু trust না করে), `authorize()` কল হলো, তারপর
  existing filtered SELECT+404 **অপরিবর্তিত** রাখা হলো (defensive, B1-এর
  posture-এর মতোই)। `dispute`-এ আলাদাভাবে `reason` validation (400) agreement
  fetch-এরও আগে চলে — সেটাও অপরিবর্তিত, ownership check-এর কোনো প্রভাব
  তার উপর নেই।
- **#11–13 (public passkey flow)**: এখানে hand-rolled check-টা নিজেই একটা
  simple boolean comparison, ইতিমধ্যে-fetch-করা DB-sourced field-এর
  উপর (`agreement.payerUserId`, `entry.userId`) — কোনো "final enforcement"
  DB write না, শুধু পরের ধাপ গেট করে। ঠিক Phase C2-র `vault-reauth.ts`-এর
  `cred.userId !== userId` কেসের same shape — তাই নতুন কোনো query ছাড়াই
  সরাসরি `authorize()`-এ replace করা হয়েছে, একই response message রেখে।
  #13 (challenge ownership) #11/#12 (payer ownership) থেকে সম্পূর্ণ আলাদা
  একটা দ্বিতীয় প্রশ্ন — Phase C2-র `passkey.ts` register/verify-এর মতোই,
  `!entry` (existence) hand-rolled থাকল, শুধু `entry.userId !== ...`-এর
  অংশটা PDP-তে গেল, দুটো কেসই আগের same combined error message দেয়।

### Resource lookup — সবসময় DB থেকে real owner, sentinel trick (B1/C1/C2-এর মতোই)
`FINANCE_INVOICE_OWNER_SENTINEL_NONE` (`-1`, `usersTable.id`-এর কখনো না-হওয়া
মান) — `FINANCE_OWNER_SENTINEL_NONE`/`PASSKEY_OWNER_SENTINEL_NONE`/
`VAULT_REAUTH_OWNER_SENTINEL_NONE`-এর same posture: না-থাকা row/entry-ও
PDP-তে একটা normal, auditable DENY (`NO_MATCHING_POLICY`) হিসেবে পৌঁছায়,
কোনো 500 না — response body আগের মতোই।

### একটাই shared engine, module-load-time
`financeInvoicesOwnershipEngine` — প্রতিটা inline `authorize()` কল (routes
#7–13) এই একটা engine শেয়ার করে (Phase C2-র `passkeyOwnershipEngine`-এর
মতো, একটা ফাইলে একাধিক resource type/action থাকলেও একটাই engine — rule
type-agnostic, শুধু `subject.userId === resource.ownerId` compare করে)।
Router-level রুট #1–6 নিজেদের `requireOwnership()` কল নিজে নিজেই একটা
throwaway engine বানায় (Phase B1-র নিজস্ব pattern, `finance.ts`-এর মতো) —
আলাদা কিছু বানাতে হয়নি। দুটোই `pepDecisionObserver` (Phase A3) দিয়ে wired —
এই ১৩টা decision এখন প্রথমবারের মতো `authorization_audit_log`-এ row হয় আর
`authorization-telemetry`-তে গণনা হয়।

## Backend

| ফাইল | পরিবর্তন |
|---|---|
| `routes/finance-invoices.ts` | `PolicyEngine`/`createResourceOwnershipRule`/`authorize`/`requireOwnership`/`ResourceRefBuilder`/`pepDecisionObserver`/`Request`/`Response` import; `FINANCE_INVOICE_OWNER_SENTINEL_NONE`, `financePaymentMethodResource`, `financeInvoiceResource`, `requireFinancePaymentMethodOwnership()`, `requireFinanceInvoiceOwnership()`, module-level `financeInvoicesOwnershipEngine`; ৬টা route-এ router-level middleware; ৭টা route-এ inline `authorize()` (৪টা add-new-keep-old, ৩টা direct replacement)। কোনো route-এর response shape/status code বদলায়নি। |

## এই ফেজে যা সরানো হয়নি
- `payment-methods`/`invoices`/`payment-agreements`-এর existing
  combined-where update/delete/select query-গুলো — এখনো আছে, এখনো আসল
  enforcement; নতুন `authorize()` কল/middleware একটা দ্বিতীয়, পর্যবেক্ষণযোগ্য
  স্তর, replace না (routes #11–13 বাদে, যেখানে hand-rolled check-টা নিজেই
  কোনো DB write ছিল না বলে সরাসরি replace করা নিরাপদ ছিল)।
- `PATCH`-শেপের কোনো নতুন validation বা status-check যোগ হয়নি — সবই আগের
  মতোই, শুধু ownership decision-টা এখন PDP-র মধ্য দিয়ে যায়।

## এখনো যা বাকি (Season C-এর পরের batch-এর কাজ)
- `teams.ts` (1557 লাইন) — বড়, নিজের batch (Phase C4) প্রাপ্য, এই ফেজে touch
  করা হয়নি (Phase C1-এই বাদ দেওয়া হয়েছিল)।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral —
প্রতিটা route-এর জন্য response শেষ পর্যন্ত অপরিবর্তিত (same status code,
same body, same owner-only logic, একই order-এ same side-effects), শুধু
ভেতরে এখন PDP জড়িত।

## যা টেস্ট করা হয়েছে
- এডিট করা ফাইলের bracket/brace/paren balance স্ক্রিপ্ট দিয়ে চেক করা
  হয়েছে — `{}` 415/415, `()` 1046/1046, `[]` 78/78, সব শূন্যে মেলে।
- `tsc --noEmit --skipLibCheck --ignoreConfig` ফাইলের উপর চালানো হয়েছে —
  বাকি থাকা প্রতিটা error module-resolution-জনিত (`express`/`@workspace/db`/
  `drizzle-orm`/`@simplewebauthn/server`/ইত্যাদি, node_modules install না
  থাকায়) অথবা pre-existing implicit-any (`req`/`res`/ইত্যাদি,
  `@types/node`/`@types/express` ছাড়া) — ঠিক আগের ফেজগুলোর মতোই বেসলাইন
  noise। নতুন যোগ করা কোনো identifier (`authorize`, `PolicyEngine`,
  `createResourceOwnershipRule`, `requireOwnership`, `pepDecisionObserver`,
  `financePaymentMethodResource`, `financeInvoiceResource`,
  `requireFinancePaymentMethodOwnership`, `requireFinanceInvoiceOwnership`,
  `financeInvoicesOwnershipEngine`, `FINANCE_INVOICE_OWNER_SENTINEL_NONE`)
  নিয়ে কোনো error ওঠেনি।
- প্রতিটা import সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep
  করে যাচাই করা হয়েছে (`requireOwnership` → `lib/policy/pep/middleware.ts`,
  `authorize` → `lib/policy/pep/authorize.ts`, `ResourceRefBuilder` →
  `lib/policy/pep/types.ts`, `PolicyEngine` → `lib/policy/policy-engine.ts`,
  `createResourceOwnershipRule` → `lib/policy/resource/ownership-rule.ts`,
  `pepDecisionObserver` → `middlewares/auth.ts`)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner →
  ownership rule ALLOW → আগের success path। non-owner বা নাই-এমন
  id/token/challenge → ownership rule abstain (sentinel বা real mismatch)
  → default-deny (`NO_MATCHING_POLICY`) → আগের একই error status/body।
  #7/#8-এ pre-existing validation/side-effect এখনো ownership-এর আগে চলে,
  ordering অপরিবর্তিত। #9/#10-এ agreement-existence hand-rolled 404 এখনো
  invoice-ownership-এর আগে। #13-এ challenge-existence hand-rolled 400
  এখনো ownership-check-এর আগে, দুটোই একই error message দেয়।
