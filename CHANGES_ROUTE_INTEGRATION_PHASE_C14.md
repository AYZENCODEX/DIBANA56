# Route Integration Roadmap — Season C, Phase C14: email-compose.ts (real auth bug found + fixed) + thread-route close-out

## Part 1 — email-compose.ts: এটা শুধু "requireAuth wiring নেই" ছিল না, একটা real bug ছিল

C9/C10 থেকে শুরু করে প্রতিটা ফেজেই `email-compose.ts` কে "নিজের `requireAuth`
wiring নেই" বলে বাদ রাখা হয়েছিল, mechanical-sweep candidate না ধরে। এই ফেজে
সত্যিকার audit করতে গিয়ে দেখা গেল ব্যাপারটা শুধু "wiring নেই" তার চেয়ে খারাপ:

### যা পাওয়া গেছে
তিনটা route-ই (`POST /:id/send`, `GET /:id/inbox`, `POST /:id/test`)
`requireAuth` middleware ব্যবহার করত না — বরং handler-এর ভেতরে সরাসরি
`await getUserIdAsync(req)` কল করত। `getUserIdAsync()`
(`lib/auth-utils.ts`) token না থাকলে বা invalid হলে **`AuthError` throw
করে**, কোনো response রিটার্ন করে না — আর এই ফাইলে, বা গোটা codebase-এর
আর কোথাও, এই throw catch করার মতো কোনো global error middleware নেই।

ফলাফল: token ছাড়া বা expired token দিয়ে এই তিনটা route-এর যেকোনোটায় call
করলে ক্লায়েন্ট একটা clean `401` পেত না — বরং async Express handler-এর
ভেতরে একটা uncaught rejection হতো, যেটা (Express/Node version অনুযায়ী)
request-টাকে indefinitely hang করিয়ে রাখতে পারত অথবা raw stack trace সহ
crash করতে পারত। এটা একটা real reliability bug, শুধু "PDP-তে touch করে
না" টাইপ deferral না।

### যা ঠিক করা হলো
- তিনটা route-েই `requireAuth` middleware বসানো হলো (handler-এর ভেতরের
  `getUserIdAsync(req)` কল সরিয়ে `req.user!.userId` দিয়ে replace করা
  হলো) — এখন missing/invalid token ঠিক `email-accounts.ts`/বাকি সব
  route-এর মতোই clean `401 { error: "Unauthorized", code: "NO_TOKEN" |
  "INVALID_TOKEN" }` পায়। **এটা behavior-preserving refactor না — একটা
  ইচ্ছাকৃত fix, স্পষ্টভাবে flag করা হলো যাতে কেউ ভুল করে এটাকে "শুধু
  routing" না ভাবে।**
- `requireAuth` বসার সাথে সাথে `req.user` populate হওয়া শুরু করল, যেটা
  দিয়ে এখন `email-accounts.ts`-এর same shape-এর `requireOwnership()` gate
  বসানো সম্ভব হলো — এই টেবিলের (`emailAccountsTable`) জন্য
  `email-accounts.ts` আগে থেকেই migrate করা ছিল (Phase C7), তাই এই ফাইলটাও
  একই resource-এর ঠিক সেই gap পূরণ করল।
- `getAccount(userId, id)`-এর নিজস্ব `and(eq(id,id), eq(userId,userId))`
  query অপরিবর্তিত থেকে গেল — এই সিরিজের "PEP additive, handler-এর নিজস্ব
  logic touch করে না" নীতি অনুযায়ী; PEP gate ALLOW দিলে handler নিজের
  select-then-verify আগের মতোই আবার চালায়।
- একটা **local** `emailAccountResource` (আর `requireEmailAccountOwnership`)
  বানানো হলো এই ফাইলেই — `email-accounts.ts`-এর module-private
  `emailAccountResource` import না করে, কারণ এই সিরিজের বাকি সব ফেজ নিজের
  `ResourceRefBuilder`-কে নিজের ফাইলের ভেতরেই self-contained রাখে। তবে
  `type: "email_account"` string হুবহু `email-accounts.ts`-এর মতোই রাখা
  হলো, যাতে দুই ফাইলের decision-ই একই audit bucket-এ পড়ে।

| Route | নতুন `action` |
|---|---|
| `POST /email-accounts/:id/send` | `email_account.send` |
| `GET /email-accounts/:id/inbox` | `email_account.inbox.read` |
| `POST /email-accounts/:id/test` | `email_account.test_connection` |

তিনটা route-এরই pre-existing 404 body (`{ error: "Account not found" }`)
অপরিবর্তিত রাখা হলো `onDeny`-তে।

## Part 2 — Thread routes: formally close-out, নতুন pattern ডিজাইন না

`GET /ayzen-email/mailbox/thread/:threadId` আর `PATCH
/ayzen-email/mailbox/thread/:threadId/quick-action` — C11/C12/C13 তিনটা
ফেজেই "future phase-এর candidate" বলে রাখা হয়েছিল। এই ফেজে সিদ্ধান্ত
নেওয়া হলো: এগুলো ওই "future phase" না, বরং **এই mechanical-sweep
pattern-এর বাইরেই থেকে যাবে**, নিচের কারণে (আগে যা suspect করা হয়েছিল
সেটাই এবার নিশ্চিত করা হলো `lib/mail-threading.ts` পড়ে):

`resolveThreadId()` external email-এর `Message-ID`/`References` header
থেকে `threadId` বানায় — এটা per-user unique guaranteed **না**। দুইজন
আলাদা AYZEN user একই external email thread-এ (যেমন দুজনেই CC-তে থাকা কোনো
mail chain) থাকলে তাদের মেইলবক্সে একই `threadId` থাকতে পারে। মানে
বর্তমান `and(eq(userId,userId), eq(threadId,threadId))` check টা এই
সিরিজের বাকি সব জায়গার মতো নিছক "convenience double-check" না — এটা
আসলে **load-bearing**: এটা সরিয়ে ফেললে অন্য ব্যবহারকারীর thread-এর
message leak হতে পারে।

এই সিরিজের `ResourceRefBuilder` abstraction (single id → single owner,
`.limit(1)` দিয়ে lookup) এই shape-এ বসালে বিপজ্জনক হতো: যদি একটা
`threadId`-তে দুইজন ভিন্ন owner-এর row থাকে, `.limit(1)` যেকোনো একটা row
তুলে আনবে — যেটা caller-এর নিজের owner নাও হতে পারে, ফলে ভুলভাবে deny বা
(worse) ভুলভাবে allow হওয়ার ঝুঁকি থাকে। `authorizeMany()`-ও এখানে ফিট
করে না, কারণ সেটাও প্রতিটা item-এর জন্য একটাই owner ধরে নেয় (Phase
C13-এর bulk case-এ প্রতিটা message row-এর একজনই owner, কিন্তু এখানে
একই threadId-র রো-গুলোর owner ভিন্ন ভিন্ন হতে পারে)।

**সিদ্ধান্ত:** এই দুটো route "list-membership existence" প্রশ্নের উত্তর
দেয় ("এই threadId-তে caller-এর অন্তত একটা owned row আছে কি?"), "single
resource-এর owner কে" প্রশ্নের না — সম্পূর্ণ ভিন্ন shape, যেটা এই
mechanical-sweep-এর কোনো existing primitive-এই সঠিকভাবে ফিট করে না। নতুন
একটা primitive জোর করে বানানোর চেয়ে (যেটা ভুল হওয়ার ঝুঁকি আছে), এই দুটো
route-কে আপাতত এই সিরিজের বাইরে **ইচ্ছাকৃতভাবে বাদ** রাখা হলো, দরকার হলে
আলাদা, dedicated design আলোচনার পরে হাত দেওয়া হবে — এটা আর কোনো future
C-phase-এর "TODO" না।

## এই ফেজে যা সরানো হয়নি
`email-compose.ts`-এর SMTP/IMAP business logic (nodemailer config, IMAP
fetch/parse, error message-এর hint text) হুবহু অপরিবর্তিত।

## Rollout
`email-compose.ts`-এর তিনটা route-এ **একটা real behavior change** আছে
(আগে যা বলা হয়েছে) — token ছাড়া/ভুল token দিয়ে call করলে আগে hang/crash
হতো, এখন clean `401` পাবে। owner-এর normal token দিয়ে করা successful
call-এর জন্য কোনো behavior change নেই। কোনো নতুন env var, migration
লাগেনি।

## যা টেস্ট করা হয়েছে
- `email-compose.ts`-এ bracket/brace/paren balance script চালানো
  হয়েছে — `{}` 66/66, `()` 120/120 — শূন্যে মেলে।
- `getUserIdAsync` এর কোনো actual কল আর ফাইলে অবশিষ্ট নেই কিনা grep করে
  যাচাই করা হয়েছে (শুধু explanatory comment-এ নাম আছে, কোড-এ নেই)।
- `routes/index.ts`-এ `email-compose` router mount হওয়ার লাইন খুঁজে
  নিশ্চিত করা হয়েছে যে এই ফাইলটা আসলে live traffic পায় (dead code না)।
- ম্যানুয়ালি verify করা হয়েছে: owner + valid token → gate ALLOW →
  handler-এর নিজস্ব `getAccount` query আগের মতোই চলে। Non-owner numeric
  id → gate deny → `{ error: "Account not found" }`, ঠিক আগের body।
  Missing/invalid token → এখন `requireAuth`-এর standard `401` (আগে যা
  broken ছিল)।

## এখনো যা বাকি
Thread routes দুটো — এখন formally excluded (উপরে ব্যাখ্যা করা হয়েছে),
কোনো ভবিষ্যৎ C-phase-এর pending item না। `vault.ts` family Season B-এর
Phase B2-এর জন্য সংরক্ষিত। বাকি ৬.৪% coverage-এর বাইরে বড় unaudited
resource ownership surface (`marketplace.ts`, `local-accounts.ts`,
`mcp-agents.ts`, `users.ts`, `ai-agent.ts` — কোনোটাতেই এখনো একটাও
explicit ownership wiring নেই) একটা future audit-এর candidate, `content.ts`-এর
missing-ownership gap (এই ফেজের বাইরে, আলাদাভাবে ফ্ল্যাগ করা হয়েছে)
সমেত।
