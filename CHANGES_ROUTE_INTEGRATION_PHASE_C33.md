# Route Integration Roadmap — Season C, Phase C33: Pattern documentation + CI lint guard

## এই ফেজের scope
C19A-C32 পর্যন্ত ~৪০টা route gate হয়েছে, কিন্তু প্রতিটা phase manual audit
আর convention-এর উপর ভর করে করা হয়েছে — কোথাও লেখা ছিল না নতুন `:id`
route-এ `requireOwnership()` ব্যবহার করা *বাধ্যতামূলক*। এই ফেজে roadmap-এর
নিজের বলা দুইটা জিনিস করা হয়েছে:

1. `lib/policy/`-এ একটা pattern doc — কখন resource builder লাগবে, কীভাবে
   লিখতে হবে, `onDeny` কীভাবে বেছে নিতে হবে।
2. একটা lightweight CI lint script — নতুন ungated `:id` route detect করলে
   flag করে, পুরনো gap ঠিক করার জন্য না, নতুন গুলো জমা হওয়া আটকানোর জন্য।

## নতুন ফাইল

### ১. `artifacts/api-server/src/lib/policy/OWNERSHIP_GATING_GUIDE.md`
পুরো pattern-টা এক জায়গায়:
- **Step 1** — কখন `ResourceRefBuilder` লাগবে (single-owner vs dual-role
  vs admin-only vs public-token vs bulk) — কখন এটা কোডিং প্রশ্ন না, design
  decision (C28/C29-এর reference)।
- **Step 2** — builder লেখার নিয়ম: একটাই DB call, malformed-id আর
  not-found দুটোই একই sentinel-এ resolve হবে, schema guess না করে আসল
  column পড়া, দুইটা DB-shape (drizzle `.select().limit(1)` vs raw
  `db.execute(sql\`...\`)`) কোনটা কখন। Dual-role resource-এর জন্য
  `ayzenMailPartyResource`-এর OR-fold pattern।
- **Step 3** — wiring: thin local wrapper, `onDecision: pepDecisionObserver`
  সবসময় pass করা, কখন export করতে হবে (শুধু দ্বিতীয় ফাইল একই
  table/owner shape reuse করলে) বনাম file-local রাখা (default)।
- **`onDeny` বেছে নেওয়া** — তিনটা shape, প্রতিটার real example সহ:
  explicit 404 (বেশিরভাগ route), silent no-op (value-history.ts-এর
  `res.json([])`, kyc.ts-এর `{success:true}`), compound/role-aware deny
  (ayzen-mail.ts-এর ৪-arg `onDeny`, sentinel দিয়ে কোন case disambiguate
  করে)। মূল নিয়ম: gate করার আগে route-এর বর্তমান deny behavior পড়ে সেটাই
  হুবহু রাখা, "improve" করা না — এই সিরিজের প্রতিটা phase-এর নিজের rule।
- একটা pre-PR checklist।

### ২. `scripts/src/check-ownership-gate-coverage.ts`
TypeScript compiler API দিয়ে (network/DB/`node_modules` লাগে না, শুধু
syntax parse — `check-all.ts`-এর মতোই) `routes/*.ts`-এর প্রতিটা
`router.<verb>("path", ...)` call স্ক্যান করে যেখানে `path`-এ `:param`
আছে। প্রতিটার জন্য check করে middleware chain-এ সরাসরি একটা PEP wiring
call (`requireOwnership`/`requirePermission`/`requirePolicy`/`requireRole`/
`requireStepUp`/`requireApproval`/`authorizeMany`) আছে কিনা, অথবা একটা
thin wrapper call আছে যেটার নিজের body-তে সেই call আছে। এই wrapper lookup
**repo-wide**, শুধু same-file না — কারণ `value-history.ts`
`local-accounts.ts`-এর `requireLocalAccountOwnership` সরাসরি import করে
কল করে, `exchange-api.ts` `kyc.ts`-এর `requireKycEntryOwnership` করে; একটা
same-file-only check এই দুটোকেই ভুলভাবে "unwired" flag করত (development-এর
সময় এই exact bug ধরা পড়েছে আর ঠিক করা হয়েছে, নিচে দেখুন)।

**Baseline mechanism** — যেহেতু আজকের codebase-এ ইতিমধ্যে বহু ungated
`:id` route আছে (কিছু genuinely gate করা দরকার — future phase-এর কাজ;
কিছু admin-only/public/decision-pending, gate করার দরকারই নেই), সব
কিছু আজই fail করানো ভুল হত — এই phase-টার scope এইসব ফিক্স করা না। তাই
`--update-baseline` flag একটা `ownership-gate-baseline.json` জেনারেট করে
যেটা আজকের সব unwired route accept করে নেয় ("grandfather")। ভবিষ্যতে
run — baseline-এ **নেই** এমন কোনো নতুন unwired route পেলেই fail করে,
পুরনো গুলোয় কিছু বলে না। Baseline-এর কোনো entry পরে wired হয়ে গেলে সেটা
stale হিসেবে report হয় (fail করে না, শুধু info), `--update-baseline`
আবার চালালে সেটা baseline থেকে বাদ পড়ে যায় — মানে baseline সময়ের সাথে
শুধু ছোটই হতে পারে, যতক্ষণ না কেউ ইচ্ছাকৃতভাবে নতুন gap যোগ করে (এই
script যেটা ধরার জন্যই বানানো)।

### ৩. `scripts/src/ownership-gate-baseline.json`
জেনারেট করা baseline — বর্তমানে **৩৪০টা** unwired param route (১৩৮টা
route ফাইল, মোট ৪৮৭টা param route-এর মধ্যে)। এই সংখ্যা roadmap-এর
"৭৬টা ফাইল কখনো audit হয়নি" claim-এর তুলনায় বড় শোনালেও প্রত্যাশিতই —
এই script কোনো exemption logic রাখেনি ইচ্ছাকৃতভাবে (admin-only route,
public-token route, non-ownership-shaped route — সবই raw structural
হিসেবে "unwired" ধরা পড়ে, GUIDE-এর Step 1-এ যেভাবে ব্যাখ্যা করা আছে)।
এগুলোর মধ্যে কোনগুলো আসলে gate করা দরকার সেটা আলাদা করে বের করা এই
phase-এর কাজ না — সেটাই C33-এর নিজের documented follow-up (নিচে দেখুন),
আর আংশিকভাবে C34 (delta re-audit)-এর কাজ।

## `package.json`
দুইটা নতুন script:
- `route-integration:check-ownership-gate-coverage` — চেক চালায় (CI-তে
  এটাই run হবে)।
- `route-integration:check-ownership-gate-coverage:update-baseline` —
  `--update-baseline` দিয়ে চালায়, নতুন flagged route review করার পরে
  deliberate commit-এ ব্যবহারের জন্য।

## Development-এর সময় পাওয়া ও ঠিক করা bug
প্রথম ভার্সনে wrapper lookup same-file-scoped ছিল — এটা
`value-history.ts`-এর দুইটা route (`GET /local-accounts/:id/value-history`,
`POST /local-accounts/:id/value`, দুটোই `local-accounts.ts`-এর
`requireLocalAccountOwnership` import করে ব্যবহার করে) আর
`exchange-api.ts`-এর route (`kyc.ts`-এর `requireKycEntryOwnership` import
করে) — মোট ৩টা আসলে-wired route-কে ভুলভাবে "unwired" ধরত। Wrapper-name →
called-names map-টাকে repo-wide দুই-pass বানিয়ে (আগে সব ফাইলের wrapper
জড়ো করে, তারপর route call resolve করে) ঠিক করা হয়েছে। Fix-এর পরে
`vault.ts`/`entities.ts`/`value-history.ts`/`kyc.ts`/`exchange-api.ts`/
`vault-entity-links.ts`-এর C19A-C32-এ gate হওয়া প্রতিটা route manually
আলাদা করে confirm করা হয়েছে — কোনোটাই baseline-এ নেই (সবগুলো সঠিকভাবে
"wired" হিসেবে ধরা পড়ে)।

## যাচাই
- Script real repo-র বিপরীতে চালানো হয়েছে: ১৩৮টা route file, ৪৮৭টা param
  route, ৩৪০টা unwired — baseline generate করা হয়েছে।
- একটা synthetic নতুন ungated route (`categories.ts`-এ সাময়িকভাবে যোগ
  করে) দিয়ে confirm করা হয়েছে script সঠিকভাবে fail করে, exact route/line
  report করে, revert করার পরে আবার clean pass করে।
- সব C19A-C32-এ gate হওয়া route (vault.ts-এর ১৪টা, entities.ts-এর ৫টা,
  value-history.ts-এর ৩টা [২টা vault + ২টা local-account shape,
  ওভারল্যাপ নেই], kyc.ts-এর ৪টা, exchange-api.ts-এর ১টা,
  vault-entity-links.ts-এর ১টা, local-accounts.ts-এর ৩টা) manually
  confirm করা হয়েছে — কোনোটাই flag হয়নি।
- TypeScript compiler API দিয়ে script নিজেই parse করে ০ syntax
  diagnostic confirm করা হয়েছে।
- এই sandbox-এ `node_modules` না থাকায় `typescript` package resolve
  করার জন্য test-এর সময় একটা temporary symlink ব্যবহার করা হয়েছিল
  (`node_modules/typescript` → global install) — এটা শুধু local
  verification-এর জন্য, ship করা কোনো ফাইলে নেই; আসল repo-তে root
  `package.json`-এর `typescript` devDependency + pnpm workspace hoisting
  এটা এমনিতেই resolve করবে, `check-all.ts` যেভাবে করে ঠিক তেমনই।

## যা বাকি
- Baseline-এর ৩৪০টা route-এর মধ্যে কোনগুলো আসলে gate করা দরকার (vs
  admin-only/public/non-ownership-shaped, যেগুলোর কিছু করার দরকার নেই)
  সেটা আলাদা করে বের করা — সেটা এই phase-এর scope-এর বাইরে, future
  phase-এর কাজ (GUIDE-এর Step 1 সেই triage-এর জন্য reference)।
- C32-এর নিজের "যা বাকি"-তে flagged ~৩০টা file-local builder export করা —
  এখনো pending, GUIDE-এর "export only when reused" rule অনুযায়ী।
- CI pipeline-এ script actually wire করা (এই phase শুধু script + baseline
  বানিয়েছে, `.github/workflows/` বা সমতুল্য কোথায় run হবে সেটা এই
  ফেজের বাইরে — infra/CI-config decision, owner-এর সাথে confirm করা
  দরকার)।
