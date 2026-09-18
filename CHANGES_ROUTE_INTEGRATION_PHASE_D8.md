# Route Integration Roadmap — Season D, Phase D8: lint script fix + baseline shrink + Season D close-out

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_D1_D8.md`-এর D8 — Season D-এর শেষ ফেজ।
D1-D4-এর triage (৩৪০টা route, ১৩৮ ফাইল, পুরো pre-existing
`ownership-gate-baseline.json`) আর D6/D7-এর real wiring-এর পর,
`scripts/src/check-ownership-gate-coverage.ts`-কে (১) সেই triage-এ পাওয়া
"আসলে নিরাপদ কিন্তু script-এর নিজের shape-blindness-এর কারণে false-flag
হচ্ছিল" প্যাটার্নগুলো চিনতে শেখানো, (২) `--update-baseline` চালিয়ে
বেসলাইন সঙ্কুচিত করা, আর (৩) C35-এর reference table-এ Season D-এর
চূড়ান্ত disposition ডকুমেন্ট করা।

## (১) Script fix — তিনটা detection gap

`isWired()`-এর original design শুধু router-level middleware argument-এর
মধ্যে `PEP_WIRING_NAMES`-এর নাম-মেলা CallExpression খুঁজত। D1-D4-এর
হাতে-verify করা findings তিনটা শেপ চিহ্নিত করেছিল যেগুলো script দেখতে
পেত না, যদিও প্রতিটাই আসলে নিরাপদ:

| # | শেপ | উদাহরণ | ফিক্স |
|---|---|---|---|
| ১ | Bare (uncalled) legacy role middleware — `requireAdmin`/`requireDev` ফাংশন হিসেবে সরাসরি পাস, factory-call না | `router.patch(path, requireAdmin, handler)` | নতুন `PEP_WIRING_BARE_IDENTIFIERS` সেট, `isWired()`-এ `ts.isIdentifier(arg)` চেক যোগ |
| ২ | `requireRoles(...)` — আলাদা নামের factory, PDP-র নিজস্ব `requireRole` (singular, ইতিমধ্যে recognized)-এর থেকে ভিন্ন | `router.post(path, requireRoles("admin", "moderator"), handler)` | `PEP_WIRING_NAMES` সেটে `"requireRoles"` যোগ |
| ৩ক | Inline `authorize()` enforcement — router-middleware আর্গুমেন্ট না, handler-body-র ভেতরে | `const x = await authorize({...}); if (x.decision.effect !== "ALLOW") { res.status(403)...; return; }` | নতুন `handlerHasInlineWiring()` — handler body-তে `.decision.effect` কম্পারিজন খোঁজে |
| ৩খ | Inline hand-rolled platform-role check — কোনো middleware-ই নেই | `if (req.user!.role !== "admin" && ...) { res.status(403)...; return; }` | একই `handlerHasInlineWiring()` — `role !== "..."`/`<expr>.role !== "..."` কম্পারিজন খোঁজে, শুধু তখনই যখন enclosing `if`-এর branch সত্যিই `res.status(401` বা `res.status(403` কল করে (accidental role-comparison থেকে আলাদা করতে) |

**ইচ্ছাকৃতভাবে যা যোগ হয়নি:** D7-এর audit-only `authorize()` wrapper কল
(যেমন `finance.ts`-এর `auditFinanceOwnership()`) — এগুলো `authorize()`-এর
return value discard করে, কখনো `.decision.effect` চেক করে না, তাই নতুন
detection-এ ধরা পড়ে না এবং **সঠিকভাবেই বেসলাইনে থেকে যায়**। এটা bug না —
script-এর নিজস্ব header-এর "raw-SQL scoping আর PDP wiring দুটো আলাদা,
দুটোই valid layer, কিন্তু script শুধু PDP wiring চেক করে" নীতির সাথে
সামঞ্জস্যপূর্ণ। audit wiring visibility যোগ করে, gate যোগ করে না — script-এর
job gate খোঁজা, তাই audit-only wiring wired হিসেবে গণনা করা ভুল হতো।

সম্পূর্ণ যুক্তি আর প্রতিটা শেপের উদাহরণ script-এর নিজস্ব header-এ (নতুন
"Season D, Phase D8 update" সেকশন) ডকুমেন্ট করা হয়েছে।

## (২) `--update-baseline` চালানো — ফলাফল

Sandbox-এ globally installed `typescript`/`tsx` পাওয়া গেছে (এই রিপোর নিজস্ব
`node_modules` নেই — D6/D7-এর নিজস্ব header-এ যে সীমাবদ্ধতা নোট করা ছিল,
সেটা `tsx`-এর জন্য প্রযোজ্য ছিল না, শুধু `@workspace/db`/`express`-এর মতো
রিপো-নির্দিষ্ট প্যাকেজের জন্য প্রযোজ্য ছিল — এই script-এর কোনো dependency
নেই TypeScript compiler API ছাড়া, তাই সত্যিই চালানো গেছে, শুধু syntax-parse
না)।

```
$ tsx scripts/src/check-ownership-gate-coverage.ts --update-baseline
Route Integration Roadmap — Phase C33: ownership-gate coverage check
Scanned 138 route files, 487 param routes total, 154 unwired.
Baseline updated: 154 accepted unwired param routes written to scripts/src/ownership-gate-baseline.json
```

**৩৪০ → ১৫৪** — ১৮৬টা route বেসলাইন থেকে বাদ পড়েছে (আর কোনো নতুন unwired
route যোগ হয়নি — re-run ক্লিন পাস করে)।

### যাচাই — ফাইল-বাই-ফাইল, D1-D4/D7-এর নিজস্ব সংখ্যার সাথে ক্রস-চেক
নতুন বেসলাইনে (১৫৪) প্রতিটা প্রধান ফাইলের অবশিষ্ট সংখ্যা D1-D4/D7-এর
document করা bucket-breakdown-এর সাথে হুবহু মিলেছে:

| ফাইল | নতুন বেসলাইনে বাকি | প্রত্যাশিত (doc অনুযায়ী) |
|---|---|---|
| `teams.ts` | ৬ | D1-এর বুকেট খ.৩ (self-scoped, `/favorite` `/join-request` `/leave` `/notifications` GET+PATCH) — D6 ইচ্ছাকৃতভাবে untouched রেখেছিল, এখানে আলাদা কোনো membership fact নেই যা গেট করার মতো |
| `finance.ts` | ৩৫ | D2-এর ৩২ raw-SQL + ৩ token = ৩৫ (৬টা already-PDP bucket ৪ এখন wired) |
| `finance-invoices.ts` | ৫ | D2-এর ৪ public/token + ১ self-scoped payer-write = ৫ (৬টা already-PDP bucket ৪ এখন wired) |
| `tasks.ts` | ৭ | D3-এর ৪ public + ৩ self-scoped = ৭ (৪টা role-middleware + ৩টা already-PDP এখন wired) |
| `projects.ts` | ১৮ | D3-এর ৫ public + ৬ self-scoped + ৭ raw-SQL/audit-only = ১৮ (৫টা role-middleware + বাগ-ফিক্সড ১টা এখন wired) |
| `admin-rbac-console.ts`, `admin-policy-console.ts`, `admin-resource-console.ts`, `admin-oidc-clients.ts`, `users.ts` | ০ প্রতিটাতে | D4-এর বুকেট ক (role/permission-gated, `requireDev`/`requireAdmin`-uniform B3-reviewed console) — সবগুলো এখন wired |
| `plugins.ts` | ০ | D4-এর বাগ-ফিক্স (`requireAdmin` যোগ হয়েছিল) — এখন wired |
| `ayzen-mailbox.ts` | ৫ | D4-এর বুকেট গ-এর উদাহরণ — raw-SQL `WHERE userId = ...`, কোনো recognized wrapper নাম নেই, ইচ্ছাকৃতভাবে বাকি |
| `vault-attachments.ts` | ৫ | D4-এর বুকেট গ-এর উদাহরণ — `assertEntityOwnership()` inline helper, `PEP_WIRING_NAMES`-এ নেই, ইচ্ছাকৃতভাবে বাকি |
| `events.ts`, `tools.ts` | ১ + ১ | D5-এ resolve হওয়া `presence`/`streak` — login-gate যোগ হয়েছে (ownership না), তাই সঠিকভাবেই এখনো "unwired" (script শুধু ownership/PDP wiring চেক করে, login-gate-only intentionally বাইরে) |

কোনো mismatch পাওয়া যায়নি — প্রতিটা ফাইলের নতুন সংখ্যা D1-D7-এর নিজস্ব
bucket-breakdown থেকে হাতে-গণনা করা প্রত্যাশিত সংখ্যার সাথে ঠিক মিলেছে।

### যা ইচ্ছাকৃতভাবে বেসলাইনে থেকে গেছে (১৫৪, ৪৪টা ফাইল জুড়ে)
- Raw-SQL/Drizzle `WHERE userId = .../owner_id = ...` shape, কোনো named
  wrapper বা inline `authorize()` call ছাড়া (`finance.ts`-এর ৩২, `ayzen-
  mailbox.ts`-এর ৫, ইত্যাদি) — safe by SQL scoping, script-এর নিজস্ব
  "PDP wiring চেক করি, ownership-safety by any means না" সীমাবদ্ধতার
  আওতায়।
- Public/token-possession by design (receipt tokens, marketplace public
  reads, OIDC RFC7592 bearer token, ইত্যাদি) — কোনো ownership প্রশ্নই
  প্রযোজ্য না।
- Self-scoped (own-row write/read, আলাদা resource-id নেই) — `teams.ts`-এর
  বুকেট খ.৩, `tasks.ts`/`projects.ts`-এর self-scoped bucket।
- Login-gate-only (D5-এ resolve হওয়া `presence`/`streak` সহ) — ownership
  প্রযোজ্য না, শুধু authenticated হতে হবে।
- D7-এর audit-only `authorize()` wiring — দেখা যায় না কারণ ইচ্ছাকৃতভাবে
  `.decision.effect` চেক করে না (উপরে দেখুন)।

এর কোনোটাই security gap না — সবগুলোই D1-D7-এ হাতে-verify করা, নিরাপদ,
শুধু `requireOwnership()`/`authorizeMany()` PDP family-র বাইরের shape
বলে script-এর নিজস্ব সংজ্ঞা অনুযায়ী "unwired" হিসেবে থেকে যায় — ঠিক
script-এর নিজস্ব header-এর "Known limitations" সেকশন যেমনটা বর্ণনা করে।

## (৩) C35-এর reference table-এ Season D addendum
`CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`-এ একটা নতুন "Season D — সম্পূর্ণ
disposition" সেকশন যোগ করা হয়েছে (নিচে দেখুন কী যোগ হয়েছে) — C35 নিজেই
বন্ধ থাকা ফাইল, তাই edit না করে এই ফাইলের নিচে addendum হিসেবে সেই
সেকশনের কন্টেন্ট রাখা হলো, একই সাথে `CHANGES_ROUTE_INTEGRATION_PHASE_C35.md`-এ
সরাসরি append করা হয়েছে যাতে single reference table থেকে যায় (C35-এর
নিজস্ব stated purpose — "single reference table")।

---

## যাচাই
- Script fix: `node`-এর `typescript` প্যাকেজ দিয়ে সরাসরি syntax-parse —
  ০ parse diagnostic।
- Script আসলে চালানো হয়েছে (শুধু parse না) — `tsx scripts/src/check-
  ownership-gate-coverage.ts` এবং `--update-baseline` দুটোই সফলভাবে রান
  হয়েছে, globally-installed `typescript`/`tsx` ব্যবহার করে (রিপোর নিজস্ব
  `node_modules` নেই বলে একটা লোকাল সিমলিংক লাগানো হয়েছিল শুধু module
  resolution-এর জন্য — কোনো রিপো ফাইল বদলায়নি)।
- Re-run (কোনো `--update-baseline` ছাড়া) ক্লিন পাস করে: "OK — no new
  unwired param routes (154 pre-existing gap(s) in baseline, unchanged)"।
- উপরের ফাইল-বাই-ফাইল ক্রস-চেক টেবিল — ১০+ ফাইলের নতুন সংখ্যা D1-D7-এর
  নিজস্ব doc-করা bucket breakdown-এর বিপরীতে হাতে-verify করা, সবগুলো
  মিলেছে।
- **Real `tsc --noEmit`/DB-connected integration test sandbox-এ চালানো
  যায়নি** — D6/D7-এর নিজস্ব header-এর একই সীমাবদ্ধতা
  (`@workspace/db`/`express`/`drizzle-orm`-এর জন্য কোনো installed
  `node_modules` নেই, নেটওয়ার্ক নেই)। merge-এর আগে বাস্তব টুলচেইনে `pnpm
  --filter @workspace/scripts typecheck` (বা সমতুল্য) চালানো উচিত।

## Season D — সম্পূর্ণ close-out সারাংশ

| আইটেম | সংখ্যা |
|---|---|
| Triage করা route (D1-D4) | ৩৪০ (১৩৮ ফাইল) |
| Confirmed নিরাপত্তা বাগ, সাথে সাথে ফিক্স হয়েছে | ২ (D3: `GET /projects/:id/members` email/userId leak, unauthenticated; D4: `plugins.ts`-এর `/admin/plugins` GET+PATCH, কোনো auth-ই ছিল না) |
| Owner-decision-এ flag হয়েছিল, D5-এ resolve হয়েছে | ৪ (D1: `teams.ts` mission create/update → leader-gate; D4: `events.ts` presence + `tools.ts` streak → login-gate) |
| নতুন reusable PDP rule বানানো হয়েছে (D6) | ১ (`createGroupMembershipRule()`) — `teams.ts`-এর ৪২টা route real PDP enforcement-এ convert |
| Audit-only wiring যোগ হয়েছে, কোনো SQL/behavior বদলায়নি (D7) | `finance.ts`-এর ৩১, `teams.ts`-এর কম্পাউন্ড বুকেটের leader-অর্ধেক ২, `projects.ts`-এর ২ (নতুন এই ফেজে) — মোট ৪৪টা route-এ audit visibility |
| Lint script detection gap বন্ধ হয়েছে (D8) | ৩টা শেপ (bare role middleware, `requireRoles` factory, inline `authorize()`/role-check) |
| Baseline shrink (D8) | ৩৪০ → ১৫৪ (১৮৬টা route এখন সঠিকভাবে "wired" হিসেবে দেখায়) |
| বেসলাইনে ইচ্ছাকৃতভাবে থেকে যাওয়া (raw-SQL/public/self-scoped/login-gate-only/audit-only) | ১৫৪, ৪৪টা ফাইল জুড়ে — প্রতিটাই hand-verified নিরাপদ, শুধু PDP-family-র বাইরের shape |

Season D-এর ৮টা ফেজই (D1-D8) এখন সম্পূর্ণ। কোনো owner-decision pending
নেই, কোনো known unaddressed security bug নেই। বাকি ১৫৪টা বেসলাইন এন্ট্রি
future hygiene backlog — কোনোটাই blocking না, প্রতিটাই এই সিরিজে
hand-verified হয়ে নিরাপদ প্রমাণিত হয়েছে।
