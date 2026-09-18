# Route Integration Roadmap — Season C, Phase C1: Mechanical Sweep (batch 1)

## যা আগে থেকেই ছিল
Phase A2/A3-এর পর `requireAuth`/`requireAdmin`/`requireRoles()`-backed প্রতিটা
route decision (role-membership) PDP-এর মধ্য দিয়ে যায় আর audit/telemetry-তে
ধরা পড়ে। কিন্তু `requireAuth`-এর পরে অনেক route নিজের হাতে একটা **দ্বিতীয়**,
route-specific check করত — "এই record-টা কি আমার, নাকি আমি admin" — যেটা
কখনো `requireAuth`/`requireAdmin`/`requireRoles()`-এর কোনো shim-এর আওতায়
পড়েনি (Phase A2 শুধু role-membership shim করেছিল, per-record ownership না)।
এই ফেজের আগে repo-জুড়ে grep করে (`userId !== `/`!== .*userId`) এমন ৭টা route
file পাওয়া গেছে: `events.ts` (false positive — presence broadcast, কোনো
authz check না), `finance-invoices.ts` (988 লাইন, নিজের ব্যাচ প্রাপ্য),
`passkey.ts`, `support.ts`, `tasks.ts`, `teams.ts` (1557 লাইন), আর
`vault-reauth.ts`। এই ফেজ (batch 1) সবচেয়ে ছোট, সবচেয়ে সরল-প্যাটার্নের
দুটো ফাইল থেকে শুরু করল: `support.ts` আর `tasks.ts`-এর `role !== "admin" &&
record.userId !== userId` shape-এর ৫টা route।

## যেটা যোগ করা হলো (Phase C1)

### নতুন rule: `createRoleOverrideRule()` (`lib/policy/resource/role-override-rule.ts`)
`support.ts`/`tasks.ts`-এর প্রতিটা hand-rolled check আসলে "owner, OR admin"
— `createResourceOwnershipRule()` (Phase 3A) একাই সেটা express করতে পারে না
(role নিয়ে কোনো মত নেই), আর `requireRole()`-এর নিজের rule (pep/middleware.ts)
role-mismatch-এ EXPLICIT DENY রিটার্ন করে বলেই ownership rule-এর পাশে বসালে
deny-overrides combining-এ একজন non-elevated OWNER-এর ALLOW-ও DENY হয়ে যেত
— ভুল ফলাফল একটা "OR" check-এর জন্য। `createRoleOverrideRule(allowRoles)`
হলো `requireRole()`-এর ঠিক same rule, শুধু role না মিললে **ABSTAIN** (কখনো
DENY না) — `rbac-rule.ts`/`ownership-rule.ts`/`any-permission-rule.ts`-এর
same posture। `createResourceOwnershipRule()` + `createRoleOverrideRule(["admin"])`
— দুটো একসাথে register করলে যেকোনো একটা ALLOW করলেই যথেষ্ট, কোনোটাই অন্যটাকে
veto করতে পারে না। `lib/policy/resource/index.ts` barrel থেকে re-export করা
হলো।

### Route handler-এর ভেতরে **inline** `authorize()` কল — নতুন middleware না
`support.ts`-এর `GET /support/tickets/:id`/`POST /support/tickets/:id/messages`
আর `tasks.ts`-এর তিনটা `/tasks/submissions/:id/receipt*` route — প্রতিটাতেই
handler-এর ভেতরে ALREADY একটা "record না পেলে 404" চেক প্রথমে ছিল, তারপর
ownership/role চেক। যদি এই দুটো চেককে একটা router-level middleware দিয়ে
প্রতিস্থাপন করা হতো (Phase B1-এর `requireOwnership()`-এর মতো), তাহলে "record
নেই" কেস-টার জন্যও middleware-টাই আগে চলত — support.ts/tasks.ts-এর existing
behavior-এ "record নেই" (404) আর "owner না" (403) আলাদা status code, তাই
sentinel-ownerId trick (Phase B1 যেটা finance.ts-এ ব্যবহার করেছিল, যেখানে
দুটো কেসই আগে থেকেই একই 404-এ collapse হতো) এখানে কাজ করত না — 404 হয়ে
যেত 403। তাই এই ফেজ `lib/policy/pep/authorize.ts`-এর `authorize()` ব্যবহার
করল — এই ফাইলের নিজের হেডারই এটাকে "mid-handler, a conditional check that
shouldn't gate the whole route" primitive হিসেবে documented করে রেখেছে।
প্রতিটা route-এ handler নিজের "record না পেলে 404" চেক **অপরিবর্তিত** প্রথমে
রাখল, তারপর ঠিক যেখানে হাতে-লেখা `if (... !== ... && role !== "admin")`
ছিল, সেই একই জায়গায় একটা `authorize()` কল বসল — `decision.effect !== "ALLOW"`
হলে ঠিক আগের মতোই status code/body রেন্ডার করে।

| Route | নতুন `action` | নতুন response gate |
|---|---|---|
| `GET /support/tickets/:id` | `support.ticket.read` | `403 { error: "Forbidden" }` (অপরিবর্তিত) |
| `POST /support/tickets/:id/messages` | `support.ticket.reply` | `403 { error: "Forbidden" }` (অপরিবর্তিত) |
| `POST /tasks/submissions/:id/receipt` | `task.submission_receipt.create` | `403 { error: "Not your submission" }` (অপরিবর্তিত) |
| `DELETE /tasks/submissions/:id/receipt` | `task.submission_receipt.revoke` | `403 { error: "Not your submission" }` (অপরিবর্তিত) |
| `POST /tasks/submissions/:id/receipt/email` | `task.submission_receipt.email` | `403 { error: "Not your submission" }` (অপরিবর্তিত) |

`support.ts`-এর দুটো route একটা shared module-level engine
(`ticketOwnerOrAdminEngine`) রিইউজ করে, `tasks.ts`-এর তিনটা আরেকটা shared
engine (`submissionOwnerOrAdminEngine`) — দুটো আলাদা কারণ দুটো আলাদা resource
type (`support.ticket` বনাম `task.submission`), rule mix same। দুটোই
module-load-এ একবার বানানো (cheap, stateless — `adminRoleCheck`/`devRoleCheck`
আর Phase C1-এরই own admin-console engine-গুলোর same posture), দুটোই
`pepDecisionObserver` (Phase A3) দিয়ে wired — মানে এই ৫টা decision এখন
প্রথমবারের মতো `authorization_audit_log`-এ row হয় আর
`authorization-telemetry`-তে গণনা হয়।

### এই ফেজে যা সরানো হয়নি
প্রতিটা route-এর নিজের hand-rolled "record না পেলে 404" চেক অপরিবর্তিত —
এটা ownership/role প্রশ্নের অংশ না, existence-এর প্রশ্ন, PDP-র কাজ না।
`support.ts`/`tasks.ts`-এর বাকি route-গুলো (list/create/admin-only —
`requireAuth`/`requireAdmin` দিয়ে single-layer protected, কোনো দ্বিতীয়
hand-rolled check নেই) touch করা হয়নি — Phase A2/A3 ইতিমধ্যেই তাদের PDP-এর
মধ্য দিয়ে চালায়।

## Backend

| ফাইল | পরিবর্তন |
|---|---|
| `lib/policy/resource/role-override-rule.ts` | **নতুন** — `createRoleOverrideRule()`, `ROLE_OVERRIDE_POLICY_ID` |
| `lib/policy/resource/index.ts` | `./role-override-rule` re-export যোগ |
| `routes/support.ts` | `PolicyEngine`/`createResourceOwnershipRule`/`createRoleOverrideRule`/`authorize`/`pepDecisionObserver` import; module-level `ticketOwnerOrAdminEngine`; `GET /support/tickets/:id` আর `POST /support/tickets/:id/messages`-এর হাতে-লেখা ownership check `authorize()` কলে বদলানো — handler body/response shape অপরিবর্তিত |
| `routes/tasks.ts` | একই imports; module-level `submissionOwnerOrAdminEngine`; তিনটা `/tasks/submissions/:id/receipt*` route-এর হাতে-লেখা ownership check `authorize()` কলে বদলানো — handler body/response shape অপরিবর্তিত |

## এখনো যা বাকি (Season C-এর পরের batch-গুলোর কাজ)
- `passkey.ts`, `vault-reauth.ts` — একই "owner OR ..." shape-এর ownership
  check আছে (credential/challenge ownership), কিন্তু semantics একটু ভিন্ন
  (কোনো admin-bypass নেই, শুধু strict ownership — সম্ভবত `requireOwnership()`
  সরাসরি ফিট করবে, `createRoleOverrideRule()` লাগবে না) — batch 2।
- `finance-invoices.ts` (988 লাইন) আর `teams.ts` (1557 লাইন) — বড়, নিজের
  batch প্রাপ্য, এই ফেজে touch করা হয়নি।
- `events.ts` — grep hit ছিল কিন্তু false positive (presence broadcast
  helper-এর ভেতরের `!==`, কোনো authorization check না) — কোনো action
  দরকার নেই।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral:
প্রতিটা route-এর জন্য response শেষ পর্যন্ত অপরিবর্তিত (same status code,
same body shape, same owner-or-admin logic) — শুধু ভেতরে এখন PDP জড়িত,
তাই এই ৫টা decision এখন প্রথমবারের মতো `requestId`/audit row/telemetry
count পায়।

## যা টেস্ট করা হয়েছে
- এডিট করা দুটো route ফাইল আর দুটো নতুন/edited `lib/policy/resource/*`
  ফাইলের উপর standalone `tsc --noEmit --skipLibCheck --ignoreConfig`
  চালানো হয়েছে — বাকি থাকা প্রতিটা error module-resolution-জনিত
  (`express`/`@workspace/db`/`drizzle-orm`/ইত্যাদি — node_modules install
  না থাকায়, আগের ফেজগুলোর মতোই) অথবা এই ফাইলগুলোতে already-pre-existing
  implicit-any (`req`/`res` param, `@types/node`/`@types/express` ছাড়া) —
  নতুন কোনো সিম্বল (`authorize`, `PolicyEngine`, `createResourceOwnershipRule`,
  `createRoleOverrideRule`, `pepDecisionObserver`, `ticketOwnerOrAdminEngine`,
  `submissionOwnerOrAdminEngine`) নিয়ে কোনো error ওঠেনি।
- প্রতিটা import (`authorize` from `lib/policy/pep`, `createResourceOwnershipRule`/
  `createRoleOverrideRule` from `lib/policy/resource`, `PolicyEngine` from
  `lib/policy/policy-engine`, `pepDecisionObserver` from `middlewares/auth`)
  সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep করে যাচাই করা
  হয়েছে।
- Combining-algorithm reasoning হাতে করে verify করা হয়েছে: owner/non-admin
  → ownership rule ALLOW, role rule abstain → ALLOW (আগের মতোই)। non-owner/
  admin → ownership rule abstain, role rule ALLOW → ALLOW (আগের মতোই)।
  non-owner/non-admin → দুটোই abstain → default-deny (`NO_MATCHING_POLICY`)
  → `decision.effect !== "ALLOW"` → আগের 403 (আগের মতোই)। record না পেলে —
  handler-এর নিজের প্রথম চেক-ই এখনো এটা handle করে, `authorize()` পর্যন্ত
  কখনো পৌঁছায়ই না (আগের মতোই 404)।
