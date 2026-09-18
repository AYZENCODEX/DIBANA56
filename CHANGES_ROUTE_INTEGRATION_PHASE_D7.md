# Route Integration Roadmap — Season D, Phase D7: consistency sweep — audit-trail wiring (verification + ১টা gap বন্ধ)

## Scope
Roadmap-এর D7: D2/D3/D6-এ যা "raw-SQL/token-scoped but PDP-invisible" হিসেবে
confirm হয়েছিল, সেগুলোতে C27-এর precedent প্রয়োগ — কোনো SQL/behavior
বদলায় না, শুধু `authorize()`-স্টাইল audit call যোগ হয় যাতে decision
`pepDecisionObserver`-এ কেন্দ্রীয়ভাবে দেখা যায়।

এই ফেজটা লেখা শুরু হয়েছিল একটা assumption নিয়ে যে D7 এখনো শুরুই হয়নি
(কোনো `CHANGES_ROUTE_INTEGRATION_PHASE_D7.md` ছিল না)। কোডবেস সরাসরি পড়ে
দেখা গেলো সেটা ভুল — `finance.ts` আর `teams.ts`-এ D7-এর audit wiring
ইতিমধ্যেই প্রায় সম্পূর্ণভাবে প্রয়োগ করা ছিল (কোড কমেন্টে "D7" নাম করেই),
শুধু নিজের changelog ফাইলটা কখনো লেখা হয়নি — ঠিক D4-এর plugins.ts বাগের
মতোই একটা "doc বনাম code" ফাঁক, কিন্তু উল্টো দিকে (এবার code আগে, doc
পরে)। তাই এই ফেজের কাজ দুই ভাগে হলো: (১) যা ইতিমধ্যে আছে সেটা লাইন-বাই-
লাইন verify করা, (২) যা verify করতে গিয়ে সত্যিকার gap পাওয়া গেছে সেটা
ফিক্স করা।

## (১) যা ইতিমধ্যে সঠিকভাবে প্রয়োগ করা ছিল — verify করা হলো

### `finance.ts` — ৩২-এর মধ্যে ৩১টা wired, ১টা ইচ্ছাকৃতভাবে বাদ (সঠিক সিদ্ধান্ত)
D2-এর bucket ১-এর ৩২টা route-ই `auditFinanceOwnership()` (module-load-time
per-resource-type engine, `makeFinanceOwnerResource()` দিয়ে unfiltered
re-fetch) দিয়ে audit-wired পাওয়া গেছে — একটা বাদে: `PUT
/finance/currencies/:currency`। এটা bug না — এই route-এর `:currency`
composite-key upsert-এর conflict target-ই `(userId, currency)`, তাই এখানে
আলাদা কোনো "অন্য কারো row" হতে পারে এমন resource-id নেই (নিজের ফাইলের D7
header comment-এ যে "tautological audit এড়ানো"-র যুক্তি দেওয়া আছে, এই
route ঠিক সেই ব্যতিক্রম শ্রেণীতেই পড়ে)। কোনো কোড বদলানো হয়নি।

### `finance-invoices.ts` — কিছুই বাকি নেই
D2-এর ১১টা route-এর মধ্যে ৬টা (bucket ৪) আগে থেকেই inline `authorize()`
দিয়ে real enforcement + audit visibility দুটোই পায়। বাকি ৫টা (৪টা public/
token + ১টা self-scoped payer-write) কোনোটারই আলাদা "owner" fact নেই যা
audit করার মতো (token-ই একমাত্র credential, অথবা caller নিজের
`payerUserId`-এ লেখে) — `finance.ts`-এর currency-route-এর মতোই একই
exclusion যুক্তি প্রযোজ্য। D2-এর নিজস্ব "৪০টা candidate" গণনায় এই ৫টা
ধরা ছিল, কিন্তু হাতে-verify করে দেখা গেলো এগুলোর জন্য কোনো non-tautological
audit বানানোই সম্ভব না — তাই বাদ দেওয়াই সঠিক।

### `teams.ts` — কম্পাউন্ড "leader OR X" শেপের দুটোই wired
D6 যে ২টা সত্যিকার compound route রেখে গিয়েছিল (`DELETE
/teams/:id/members/:memberId` — leader OR self, `DELETE
/teams/:id/messages/:messageId` — leader OR author), দুটোতেই leader-অর্ধেক
এখন `teamLeaderEngine`-এর মাধ্যমে audit-only `authorize()` কল পাচ্ছে (কোড
কমেন্টে স্পষ্ট "D7" ট্যাগ করা)। বাকি bucket খ.৪-এর ৩টা (`role_change`,
message-update, transfer-ownership) pure owner-shape — কোনো "leader OR"
অংশ নেই, তাই আগে থেকেই পুরোপুরি PDP-enforced, audit-only wiring-এর দরকার
নেই। bucket খ.৩-এর ৬টা self-scoped route (favorite/join-request/leave/
notifications) — `finance.ts`-এর currency-route-এর মতোই কোনো আলাদা owner
fact নেই, সঠিকভাবে বাদ।

## (২) যে gap পাওয়া গেছে — `projects.ts`-এর ৭টার মধ্যে ২টা unwired ছিল

D3-এর bucket ঘ ("membership/owner-scoped raw-SQL", ৭টা route) পুরোপুরি
unwired পাওয়া গেছে — `finance.ts`/`teams.ts`-এর মতো কোনো D7 কোড এখানে
ছিলই না। হাতে প্রতিটা route পড়ে দেখা গেলো এই ৭টা একরকম না:

- **৫টার কোনো non-tautological audit সম্ভব না** (`GET
  /projects/:id/enrolled-entities`, `/enrollments`,
  `/enrollments/overview`, `/entity-tasks`, `/roi-summary`) — এগুলোর
  URL-`:id` একটা project id, যেটা কারো "owned" resource না; query-তে
  caller-এর নিজের `req.user!.userId` সরাসরি বেক করা, কোনো আলাদা
  client-controllable entity-id নেই যেটা compare করার মতো। Deliberately
  বাদ রাখা হলো, `finance.ts`-এর currency-route exclusion-এর সমতুল্য
  যুক্তিতেই।
- **২টাতে সত্যিকার client-supplied entity id আছে যা caller-এর নাও হতে
  পারত** — `GET /projects/entity/:vaultEntryId/overview` (`:vaultEntryId`)
  আর `POST /projects/:id/enroll` (body-supplied `vaultEntryId`/
  `kycEntryId`) — এই দুটোতে audit wiring **যোগ করা হয়েছে এই ফেজে**।

কোনো cross-tenant leak না (দুটো route-ই আগে থেকে filtered/checked SQL-এ
সঠিকভাবে scoped ছিল, C26/C34-এর "genuinely no check" bucket-এর মতো কিছু
না) — এটা D7-এর নিজস্ব "audit visibility যোগ করা, behavior না" কাজ।

### পরিবর্তন — `projects.ts`

`finance.ts`-এর D7 header block-এর ঠিক same posture: নতুন import
(`authorize`, `PolicyEngine`, `createResourceOwnershipRule`, `ResourceRef`),
দুটো audit-only engine (`vaultEntryAuditEngine`, `kycEntryAuditEngine`),
দুটো `ResourceRefBuilder`/helper যেগুলো id-টার real owner **unfiltered**
re-fetch করে (already-caller-filtered row পুনরায় ব্যবহার করলে audit
tautological হয়ে যেত — সেই একই কারণ `finance.ts`-এর header-এ documented,
`POST /projects/:id/enroll`-এ এটা বিশেষভাবে গুরুত্বপূর্ণ ছিল, কারণ route
ইতিমধ্যে caller-filtered SELECT দিয়ে `vaultEntry` fetch করে রেখেছিল —
সেটা reuse না করে আলাদা unfiltered read করা হয়েছে)।

- `GET /projects/entity/:vaultEntryId/overview`: `vaultEntryId` ownership
  audit, action `project.entity_overview.read`।
- `POST /projects/:id/enroll`: `vaultEntryId` ownership audit (action
  `project.enroll`) সবসময়; `kycEntryId` দেওয়া থাকলে সেটাও আলাদাভাবে audit
  (action `project.enroll.kyc_entry`) — route-এর নিজস্ব দুটো আলাদা
  ownership-check-এর প্রতিটার জন্য একটা করে audit call, ঠিক যেভাবে
  route-এর নিজস্ব 404-logic দুটো আলাদা জিনিস verify করে।

কোনো SQL/response বদলায়নি — প্রতিটা audit call route-এর pre-existing
check-এর ঠিক পরে বসেছে, return value discard করা।

## যাচাই
- চারটা এডিট করা/নতুন ফাইলই (`projects.ts` + তিনটা আগে verify করা ফাইল)
  TypeScript syntax parse-এ ০ diagnostic (`tsc --noEmit`, unresolved-
  import noise বাদে — সেই একই sandbox limitation D6-এর নিজস্ব header যা
  নোট করেছিল)।
- `projects.ts`: brace `{}` ৪০১/৪০১, paren `()` ১০৮৬/১০৮৬ — balanced।
- সব import (`authorize`, `PolicyEngine`, `createResourceOwnershipRule`,
  `ResourceRef`) সরাসরি `lib/policy/`-এর নিজ নিজ ফাইলে গিয়ে export
  confirm করে মেলানো হয়েছে, `finance.ts`-এর ঠিক same import path।
- কোনো নাম-সংঘর্ষ নেই (`vaultEntryOwnerResource`/
  `vaultEntryAuditEngine`/`kycEntryOwnerResource`/`kycEntryAuditEngine`/
  `auditProjectsOwnership`/`PROJECTS_OWNER_SENTINEL_NONE` — প্রতিটা ফাইলে
  একবারই define হয়েছে)।
- `finance.ts`/`teams.ts`-এর বিদ্যমান wiring-এর প্রতিটা কল-সাইট আলাদা করে
  পড়ে, D2/D3/D6-এর claim-এর সাথে মিলিয়ে confirm করা হয়েছে — কোনোটাই
  fabricated বা partial না পাওয়া গেছে (`finance.ts`-এর currency-route
  ব্যতিক্রম বাদে, যেটা নিজেই সঠিক সিদ্ধান্ত)।
- Real DB-connected ইন্টিগ্রেশন টেস্ট চালানো যায়নি (sandbox-এ
  `node_modules` নেই, D6-এর নিজস্ব header-এর একই সীমাবদ্ধতা) — merge-এর
  আগে বাস্তব টুলচেইনে `pnpm --filter @workspace/api-server typecheck`
  চালানো উচিত।

## D7 close-out সারাংশ

| ফাইল | Candidate routes | Wired (আগে থেকে) | Wired (এই ফেজে) | ইচ্ছাকৃতভাবে বাদ (tautological/no owner-fact) |
|---|---|---|---|---|
| `finance.ts` | ৩৫ (৩২ owner-scoped + ৩ token) | ৩১ | ০ | ৪ (১ currency + ৩ token) |
| `finance-invoices.ts` | ১১ | ৬ (আগে থেকেই real PDP) | ০ | ৫ (৪ token + ১ self-scoped write) |
| `teams.ts` (compound bucket খ.৪) | ৫ | ২ (leader-half audit) + ৩ (আগে থেকেই real PDP) | ০ | ০ |
| `projects.ts` (bucket ঘ) | ৭ | ০ | ২ | ৫ (project-id না owned resource) |
| **মোট** | **৫৮** | **৪২** | **২** | **১৪** |

Season D-এর D1–D7 এখন সবগুলো ফেজেই কোড আর changelog মিলে যায়। বাকি শুধু
D8 (lint script fix + baseline shrink + close-out addendum) — এটাই এখন
Season D-এর শেষ পদক্ষেপ।
