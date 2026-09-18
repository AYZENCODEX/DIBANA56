# Route Integration Roadmap — Season C, Phase C34: Delta re-audit

## এই ফেজের scope
মূল audit `routes/`-এর ১৩৮টা ফাইলের একটা snapshot-এর উপর হয়েছিল। এই ফেজে
roadmap-এর নিজের বলা দুইটা কাজ: (১) বর্তমান `routes/` ফাইল-সংখ্যা সেই
১৩৮-এর সাথে diff করা, (২) C26-এর lesson (শুধু URL `:id` না, body-তে আসা
id/array-ও দেখা) প্রয়োগ করে পুরো ফিল্টার আবার re-run করা।

## ১. File-count diff
```
$ ls artifacts/api-server/src/routes/*.ts | wc -l
138
```
বর্তমান snapshot-এও ঠিক **১৩৮টা** route ফাইল — মূল audit-এর সংখ্যার
সাথে হুবহু মিলে যায়। এই নির্দিষ্ট repo snapshot-এ (C19A-C33-এর সব কাজ এই
একই codebase-এর উপর প্রয়োগ করা হয়েছে, কোনো সমান্তরাল/বাইরের commit এই
রিপোতে merge হয়নি) নতুন কোনো route ফাইল যোগ হয়নি — এটাই এই ফেজের প্রথম,
সহজ ফলাফল: **০টা নতুন ফাইল**।

## ২. পুরো ফিল্টার re-run (bulk-family + broader body-id সুইপ)
নতুন script: `scripts/src/find-body-id-audit-candidates.ts` — এটা
future re-audit-এর জন্যও reusable (এককালীন hand-grep না)। দুইটা sweep:

**Sweep ১ — literal "bulk" naming** (C26-এর original filter): repo-তে
এখনো ঠিক **১০টা** route পাওয়া যায় (`ayzen-mailbox.ts` ১, `bulk.ts` ৪,
`vault-shares.ts` ৩, `vault.ts` ২) — এটা C26-এর নিজের audit-টেবিলের সাথে
হুবহু মেলে, কোনো নতুন bulk-route যোগ হয়নি।

**Sweep ২ — broader body-id সুইপ** (C26-এর lesson, নাম-ভিত্তিক না,
shape-ভিত্তিক): `req.body` ব্যবহার করে এমন ফাইল-গুলোয় সত্যিকারের
id-শেপড identifier (camelCase `fooId`/`fooIds`, snake_case
`foo_id`/`foo_ids`, বা একা `id`/`ids`) খোঁজা হয়েছে — ৯৩টা ফাইলে হিট
পাওয়া গেছে। **এটা একটা candidate list, pass/fail gate না** — প্রতিটা
হিট হাতে পড়ে বুঝতে হবে identifier-টা আসলেই client-supplied কিনা, নাকি
internal/derived (যেমন `polymarket.ts`-এর `extractTokenIds` বা
`resend-webhook.ts`-এর `appliedRuleIds` — কোনোটাই client input না)।

### Development-এর সময় ধরা পড়া bug (script নিজের)
প্রথম ভার্সনের identifier-filter ছিল case-insensitive suffix match
(`/ids?$/i`) — এটা `void`/`valid`/`invalid`/`paid`/`avoid`/`solid`-এর
মতো সাধারণ শব্দকেও "id-shaped" ধরে ফেলছিল (কারণ এরা শেষ হয় "id"/"aid"
দিয়ে), ফলে ১০৪টা ফাইল flag হয়েছিল, অনেকগুলোই false positive। TypeScript-এর
আসল naming convention (camelCase-এ capital `I` boundary, বা snake_case
`_id`) অনুযায়ী কড়া করার পরে সংখ্যা ৯৩-এ নামে, সব noise বাদ পড়ে। এটাই
এই ফেজের নিজস্ব ছোট QA — script যেটা বানানো হয়েছে সেটাও নিজেই re-check
করা হয়েছে।

## ৩. Manual review থেকে পাওয়া সত্যিকারের finding — teams.ts-এর দুইটা route

Sweep ২-এর candidate list হাতে review করার সময় `teams.ts`-এ C26-এর মতোই
shape-এর একটা real gap পাওয়া গেছে — **client-supplied `vaultEntryId`
(body field, URL `:id` না) কোনো ownership check ছাড়াই ব্যবহার হচ্ছিল**:

### Route ১: `POST /teams/:id/enroll-project`
আগে: `vaultEntryId` শুধু **exists কিনা** চেক করত (`WHERE id =
${vaultEntryId}`), **কার** সেটা তা চেক করত না। তারপর সেই id প্রতিটা
active team member-এর জন্য `project_enrollments` টেবিলে insert হত। মানে
team leader যেকোনো guessable/enumerable `vault_entries.id` পাঠিয়ে সেটা
প্রতিটা teammate-এর নামে "enrolled" দেখাতে পারত — অন্য কারো vault entry
হলেও।

**Fix**: exists-check-কে owner-check-এ upgrade করা হয়েছে
(`AND user_id = ${userId}` যোগ করে) — ঠিক C26-এ ব্যবহৃত একই pattern।

### Route ২: `POST /teams/:id/tasks/:taskId/enroll`
আগে: `vaultEntryId`-এর **কোনো check-ই ছিল না** — সরাসরি
`task_submissions.entity_ids`-এ প্রতিটা enrolled member-এর জন্য লেখা
হত। এই route-টা enroll-project-এর চেয়েও বেশি open ছিল।

**Fix**: একই owner-check pattern প্রয়োগ করা হয়েছে, কিন্তু deny শেপ ভিন্ন
— পুরো request block না করে non-owned/nonexistent id-কে silently drop
করা হয় (`entityIdsJson` তখন `null` থাকে, বাকি enrollment স্বাভাবিকভাবে
চলে) — এই সিরিজের নিজের precedent (value-history.ts/kyc.ts-এর silent
no-op deny) অনুসরণ করে, কারণ এই route-এর pre-existing behavior-ই
non-blocking ছিল (কোনো check না থাকায় সবসময় "সফল" হত), তাই পুরো
enrollment fail করানো নতুন behavior যোগ করা হত — শুধু bad id-টা silently
বাদ দেওয়া সেই pre-existing "non-blocking" চরিত্র রক্ষা করে।

### যাচাই
- `logProjectReward` (`tasks.ts`)-ও একই sweep-এ candidate হিসেবে ধরা
  পড়েছিল (`entityIds` body field থেকে আসা) — হাতে চেক করে দেখা গেছে এটা
  আসলে **নিরাপদ**: reward attribution query নিজেই
  `WHERE project_id = ... AND user_id = ${userId} AND vault_entry_id IN
  (...)` দিয়ে filtered — non-owned entity id দিলে সেটা কোনো row-ই match
  করবে না। False positive, কোনো fix লাগেনি — কিন্তু এটাও নথিভুক্ত করা
  হলো যাতে ভবিষ্যতে কেউ আবার একই জায়গা re-audit না করে।
- Fix-এর পরে `teams.ts` TypeScript AST parse করে ০ syntax diagnostic,
  bracket balance অপরিবর্তিত সমান (৮২২/৮২২ `{}`, ১৫৩০/১৫৩০ `()`)।
- C33-এর `check-ownership-gate-coverage.ts` আবার চালিয়ে দেখা হয়েছে —
  সংখ্যা অপরিবর্তিত (৪৮৭ param route, ৩৪০ unwired) — প্রত্যাশিতই, কারণ
  এই দুইটা route-এর কোনোটাই URL `:id` না (একটা `:id` টিম-এর নিজের, যেটা
  role-check দিয়ে গেটেড), তাই C33-এর script-এর scope-এই পড়ে না — এটাই
  ঠিক এই ফেজের নিজের কারণ: C33 এই class-এর bug দেখতেই পারে না, এজন্যই
  C34 আলাদা phase হিসেবে দরকার ছিল।
- এই sandbox-এ real Postgres না থাকায় route হাতে/HTTP দিয়ে চালিয়ে
  confirm করা সম্ভব হয়নি — কোড-লেভেল diff + parse-check-ই যা করা গেছে।

## নতুন ফাইল
- `scripts/src/find-body-id-audit-candidates.ts` — reusable candidate
  finder (report-only, exit code সবসময় ০, CI gate না)। `package.json`-এ
  `route-integration:find-body-id-audit-candidates` script যোগ হয়েছে।

## Edited ফাইল
- `artifacts/api-server/src/routes/teams.ts` — দুইটা route fix (উপরে
  বর্ণিত)।
- `scripts/package.json` — নতুন script entry।

## যা বাকি
- Sweep ২-এর ৯৩টা ফাইলের বাকি candidate-গুলো এখনো হাতে review করা হয়নি
  (`teams.ts` আর `tasks.ts`-এর `logProjectReward` ছাড়া) — এইটাই পরবর্তী
  re-audit pass-এর কাজ। `find-body-id-audit-candidates.ts` সেই কাজটা
  repeatable করে রাখল, কিন্তু judgment call (client-supplied vs
  internal/derived, already-safe vs genuine gap) প্রতিটাতেই হাতে করা
  লাগবে — এটা এই ফেজের নিজের scope-এর বাইরে (সময়-সীমাবদ্ধ, C26-এর মতো
  একটা bug খুঁজে-ফিক্স-verify করাটাই এই ফেজের বাস্তবসম্মত scope ছিল)।
- Roadmap নিজেই বলে: "নতুন কিছু পাওয়া গেলে সেটাই C35-এর আগে শেষ code
  phase হবে" — এই ফেজে সত্যিই নতুন কিছু (teams.ts-এর ২টা route) পাওয়া
  গেছে এবং ফিক্স করা হয়েছে, তাই C35 (closeout) এখন এই ফেজের উপরে দাঁড়িয়ে
  এগোতে পারে।
