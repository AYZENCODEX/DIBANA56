# Route Integration Roadmap — Season C, Phase C7: Mechanical Sweep (batch 7, email accounts + wallets)

## যা আগে থেকেই ছিল
Phase C6-এর same "combined-where" audit (`grep -rl "and(eq("`) থেকে বাকি
থাকা candidate-দের মধ্যে এই ফেজে দুটো আরও ফাইল নেওয়া হলো:
`routes/email-accounts.ts` আর `routes/wallets.ts` — দুটোই `requireAuth`
দিয়ে `req.user` populate করে (তাই আগের ফেজগুলোর মতোই `requireOwnership()`
straightforward-ভাবে বসানো যায়), আর দুটোই একাধিক `:id`-based route নিয়ে
নিজের একটা সঙ্গত batch গঠন করে।

### `routes/email-accounts.ts`
৬টা route নিজের `and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId))`
দিয়ে scope করত: `GET /email-accounts/:id`, `PUT /email-accounts/:id`,
`DELETE /email-accounts/:id`, `POST /email-accounts/:id/fetch-inbox`,
`POST /email-accounts/:id/fetch-body`,
`GET /email-accounts/:id/stored-messages`। তিনটা ভিন্ন response shape:
GET/PUT → `404 { error: "Not found" }`; fetch-inbox/stored-messages →
`404 { error: "Account not found" }`; fetch-body → `404 { error: "Account
not found or not configured" }`; DELETE → কখনো 404 দেয় না, সবসময়
`{ ok: true }` (silent no-op, ঠিক Phase C6-এর `notifications.ts`-এর মতো)।

### `routes/wallets.ts`
৮টা `:id`-based route পাওয়া গেছে, এর মধ্যে ৬টা এই ফেজে migrate করা হলো
(বাকি ২টা নিচে ব্যাখ্যা করা "কেন phrase routes বাদ" অংশে): `PATCH
/wallets/:id`, `DELETE /wallets/:id`, `POST /wallets/:id/sync`, `POST
/wallets/:id/send` + `POST /wallets/:id/withdraw` (দুটোই একই
`handleWithdraw` handler শেয়ার করে), আর `GET /wallets/:id/deposits`।
প্রতিটাই নিজের `and(eq(walletsTable.id, id), eq(walletsTable.userId,
authUser.userId))` দিয়ে scope করে, একই `404 { error: "Wallet not
found" }` রিটার্ন করে।

## যেটা যোগ করা হলো (Phase C7)
Phase B1/C1-C6-এর same pattern: প্রতিটা ফাইলে module-load-time
`ResourceRefBuilder` (DB থেকে `:id`-র real owner পড়ে, client-supplied
কিছু trust করে না) + একটা throwaway `requireOwnership()` middleware,
shared `pepDecisionObserver` (Phase A3/B1) দিয়ে wired।

| ফাইল | Route | নতুন `action` | `onDeny` response (অপরিবর্তিত) |
|---|---|---|---|
| `email-accounts.ts` | `GET /email-accounts/:id` | `email_account.read` | `404 { error: "Not found" }` |
| `email-accounts.ts` | `PUT /email-accounts/:id` | `email_account.update` | `404 { error: "Not found" }` |
| `email-accounts.ts` | `DELETE /email-accounts/:id` | `email_account.delete` | `200 { ok: true }` |
| `email-accounts.ts` | `POST /email-accounts/:id/fetch-inbox` | `email_account.fetch_inbox` | `404 { error: "Account not found" }` |
| `email-accounts.ts` | `POST /email-accounts/:id/fetch-body` | `email_account.fetch_body` | `404 { error: "Account not found or not configured" }` |
| `email-accounts.ts` | `GET /email-accounts/:id/stored-messages` | `email_account.stored_messages.read` | `404 { error: "Account not found" }` |
| `wallets.ts` | `PATCH /wallets/:id` | `wallet.update` | `404 { error: "Wallet not found" }` |
| `wallets.ts` | `DELETE /wallets/:id` | `wallet.delete` | `404 { error: "Wallet not found" }` |
| `wallets.ts` | `POST /wallets/:id/sync` | `wallet.sync` | `404 { error: "Wallet not found" }` |
| `wallets.ts` | `POST /wallets/:id/send`, `POST /wallets/:id/withdraw` | `wallet.withdraw` | `404 { error: "Wallet not found" }` |
| `wallets.ts` | `GET /wallets/:id/deposits` | `wallet.deposits.read` | `404 { error: "Wallet not found" }` |

### Sentinel — একই `-1` trick, প্রতিটা ফাইলে নিজের নামে
`EMAIL_ACCOUNT_OWNER_SENTINEL_NONE` / `WALLET_OWNER_SENTINEL_NONE` — Phase
B1/C6-এর same posture, `usersTable.id` কখনো negative না বলে sentinel
কখনো real owner-এর সাথে মেলে না, missing record একটা normal auditable
DENY-তে পড়ে, thrown wiring error না।

### `email-accounts.ts` — তিনটা ভিন্ন 404 body, একটা non-404, সবই preserve করা হয়েছে
`requireEmailAccountOwnership(action, notFoundBody)` একটা parameterized
helper — প্রতিটা call site নিজের exact pre-existing body পাস করে, যাতে
byte-for-byte parity থাকে (Phase B1-এর নীতি)। `DELETE`-এর জন্য এই shared
helper ব্যবহার না করে সরাসরি `requireOwnership()` inline call করা হলো
নিজের `onDeny`-সহ, কারণ এই একটা route-ই কখনো 404 দেয়নি (Phase C6-এর
`notifications.ts`-এর মতোই silent no-op, `{ ok: true }`) — শেয়ার্ড
404-only helper-টা এখানে ভুল শেপ হতো।

### `wallets.ts` — `send`/`withdraw`-এ existing middleware order বদলানো হয়নি
দুটো রুটই আগে `requireAuth, sensitiveWriteLimiter, handleWithdraw` chain-এ
ছিল। নতুন `requireWalletOwnership()` **`sensitiveWriteLimiter`-এর পরে**
বসানো হলো (আগে না) — ইচ্ছাকৃত: rate-limit accounting যেন এই ফেজের কারণে
না বদলায় (Rule: additive, ইতিমধ্যে থাকা middleware-এর order পাল্টানো না)।

## কেন `wallets.ts`-এর phrase routes (`POST`/`GET /wallets/:id/phrase`) বাদ
এই দুটো route-এ আগে থেকেই একটা assurance/step-up gate আছে (entity-PIN
verify থেকে ইস্যু করা single-use reveal token, `GET` route-এর নিজের
comment: "Same fix as GET /vault/:id/seed... requireAuth alone previously
was enough to pull a plaintext mnemonic"). Roadmap-এর নিজের ভাষায় এই
"assurance + ownership" combo Season B-এর Phase B2 (Vault: `requireStepUp()`
+ ownership)-এর জন্য specifically সংরক্ষিত — একটা mechanical sweep না,
একটা judgment call: ownership check assurance check-এর আগে বসালে একজন
non-owner/no-token caller-এর প্রথম দেখা error বদলে যায় (আগে reveal-token
মিসিং হলে `403 REVEAL_TOKEN_REQUIRED` দেখত ownership নির্বিশেষে; ownership
gate আগে বসালে non-owner সবসময় আগেই `404` পেত, token থাকুক বা না থাকুক)।
এই ধরনের reordering decision Phase B2-এর কাজ, C-সিরিজের মেকানিক্যাল স্কোপের
বাইরে — তাই ইচ্ছাকৃতভাবে untouched।

### Resource lookup — client-supplied কিছু trust করা হয়নি
দুটো `ResourceRefBuilder`-ই `:id` দিয়ে সরাসরি DB থেকে real owner পড়ে
(`emailAccountsTable.userId`/`walletsTable.userId`) — Phase B1/C1-C6-এর
same trust-boundary posture।

## এই ফেজে যা সরানো হয়নি
- প্রতিটা route-এর existing hand-rolled `and(eq(table.id, id), eq(table.userId, userId))`
  scoping আর তাদের নিজস্ব side-effect (IMAP connect, seed-phrase decrypt,
  on-chain balance sync, `usersTable.walletCount` update, primary-wallet
  reassignment ইত্যাদি) — সব অপরিবর্তিত।
- `email-accounts.ts`-এর `POST /email-accounts/test-config` — এটাও একটা
  `accountId` ownership check করে, কিন্তু route-level `:id` param না
  (optional `body.accountId`, inline already-checked) — এই ফেজের
  `ResourceRefBuilder` shape (`req.params.id`-নির্ভর) এখানে খাটে না,
  আলাদা wiring লাগত; scope-এর বাইরে রাখা হলো।
- `wallets.ts`-এর `GET /wallets` (list, `userId=` query দিয়ে admin
  override — কোনো single-resource ownership প্রশ্ন না), `POST /wallets`
  (create, নতুন resource-এর owner সবসময় creator নিজে), `GET
  /wallets/stats`, `GET /wallets/gas-price`, `GET /wallets/deposits`
  (এই তিনটার কোনোটাই `:id`-based না) — সবই list/create/self-scoped shape,
  Phase B1-এর "list/create বাদ" যুক্তি প্রযোজ্য।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral:
owner-এর existing success path প্রতিটা route-এ অপরিবর্তিত; non-owner/
nonexistent id প্রতিটা route-এ ঠিক আগে যা রিটার্ন করত তাই এখনো করে (একই
status code, একই body, `email-accounts.ts`-এর `DELETE`-সহ) — শুধু এখন
সেই deny/no-op-এর পেছনে একটা real, audited `AuthorizationDecision` আছে।

## যা টেস্ট করা হয়েছে
- দুটো এডিট করা ফাইলেই bracket/brace/paren balance স্ক্রিপ্ট দিয়ে চেক করা
  হয়েছে — `email-accounts.ts`: `{}` 143/143, `()` 297/297, `[]` 21/21;
  `wallets.ts`: `{}` 301/301, `()` 656/656, `[]` 49/49 — সব শূন্যে মেলে।
- Phase C6-এর মতোই এই sandbox-এ `node_modules`/`tsc` install নেই, তাই
  standalone type-check চালানো যায়নি — তার বদলে প্রতিটা নতুন import সোর্স
  ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep করে যাচাই করা হয়েছে
  (`requireOwnership`/`ResourceRefBuilder`/`pepDecisionObserver`/
  `requireAuth`/`getRequestUser` — সবগুলোই Phase C6-এ যেখানে verify করা
  হয়েছিল ঠিক সেই একই export, নতুন কিছু না)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner → gate
  ALLOW → আগের handler logic অপরিবর্তিত চলে। non-owner/nonexistent id →
  gate abstain → default-deny → `onDeny`-তে বসানো ঠিক pre-existing
  response।
- `wallets.ts`-এর `send`/`withdraw` route দুটোয় বিশেষভাবে verify করা
  হয়েছে যে `sensitiveWriteLimiter` এখনো `requireWalletOwnership()`-এর
  আগে চলে (middleware array-তে position অপরিবর্তিত)।
- `email-accounts.ts`-এর `DELETE`-এ verify করা হয়েছে যে নতুন gate কোনো
  নতুন 404 চালু করেনি — non-owner/nonexistent id এখনো ঠিক আগের মতো
  `200 { ok: true }` পায়, `onDeny` সেটাই render করে।

## এখনো যা বাকি
`ayzen-mailbox.ts` (২০০০+ লাইন, একাধিক resource type — folders, labels,
templates, rules, messages — প্রতিটার নিজের ownership shape, একটা
dedicated phase দরকার), `vault-entity-links.ts`, `projects.ts`
(project enrollment/rating/pnl-receipt — একাধিক resource type একই
ফাইলে), `emergency-access.ts` (grant approval workflow — শুধু ownership
না, admin-review/approval shape থাকতে পারে, Phase B3-স্টাইল বিবেচনা
লাগতে পারে) — এই ফাইলগুলো এখনো Phase C6-এর "combined-where" audit থেকে
migrate হয়নি, ভবিষ্যতের ব্যাচের জন্য candidate। `polymarket.ts` (Phase
C6-এ ব্যাখ্যা করা, `req.user` populate করে না) আর `wallets.ts`-এর phrase
routes (Phase B2-এর জন্য সংরক্ষিত) — দুটোই ইচ্ছাকৃতভাবে বাইরে।
