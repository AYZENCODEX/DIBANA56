# Route Integration Roadmap — Season C, Phase C35: Season close-out

## এই ফেজের scope
C1 থেকে C34 পর্যন্ত পুরো Season C (আর তার ভিত্তি Season A/B)-এর একটা
single reference table — ফাইল → resource → owner column → phase →
deny-body pattern — যাতে ভবিষ্যতে কেউ কোনো নির্দিষ্ট resource-এর
ownership গেট কোথায় দেখতে হলে এক জায়গায় পায়। তারপর pending
decision-এর status check, আর শেষে "Season D দরকার কিনা" সিদ্ধান্ত।

## Pending decision status
Roadmap C35-এর নিজের instruction ছিল "C28/C29-এর decision এখনো pending
থাকলে owner-এর কাছে explicit escalate করা"। চেক করে দেখা গেছে —
**দুটোই ইতিমধ্যে resolved**:
- **C28** (`content.ts`) — owner sign-off পাওয়া গেছে, implement হয়ে
  গেছে (admin-only write, public read)।
- **C29** (`project-dates.ts`) — owner sign-off পাওয়া গেছে, implement
  হয়ে গেছে ("intentional public, কোনো gate লাগবে না")।

তাই এই ফেজে নতুন কোনো escalation করার দরকার নেই — backlog-এ কোনো
decision-gated item C18-এর মতো ফেলে রাখা নেই।

---

## Season A/B/C — সম্পূর্ণ reference table

**Legend — Deny pattern:**
- **404-explicit** — নির্দিষ্ট `{error: "..."}`/`{message: "..."}` বডি সহ 404
- **403-explicit** — নির্দিষ্ট বডি সহ 403 (owner-vs-nonexistent আলাদা করে দেখায়)
- **silent-200** — কোনো error না, quiet no-op (`{success:true}`/`{ok:true}`/খালি array), pre-existing behavior হিসেবে preserved
- **compound** — id অনুযায়ী ভিন্ন status (dual-role/role-aware deny, যেমন ayzen-mail.ts)
- **role-based** — `requireOwnership()` না, `requireAdmin`/role-check (single-owner shape প্রযোজ্য না)
- **audit-only** — pure documentation/comment, কোনো code/behavior বদলায়নি

| Phase | ফাইল | Resource / Builder | Owner column | Deny pattern |
|---|---|---|---|---|
| A1 | (cross-cutting) | OIDC access token acceptance — `getUserFromToken()` | — | — |
| A2 | (cross-cutting) | RBAC-PEP shim — `requireAdmin`/`requireDev`/`requireRoles()` → PDP | — | role-based |
| A3 | (cross-cutting) | Telemetry hookup — `requireRole()` audit trail | — | — |
| B1 | `finance.ts` | Parties / Ledger entries / Repayments | `userId` | 404-explicit |
| B3 | `admin-policy-console.ts`, `admin-rbac-console.ts`, `admin-resource-console.ts`, `authorization-telemetry.ts` | Admin consoles (dogfooding PDP) | — | role-based |
| C1 | `support.ts`, `tasks.ts` | "owner, OR admin" shape, 5 routes — `createRoleOverrideRule()` | `userId` | 404-explicit / role-based hybrid |
| C2 | `passkey.ts`, `vault-reauth.ts` | Credential/challenge ownership, no admin-bypass | `userId` | 404-explicit |
| C3 | `finance-invoices.ts` | 4 distinct ownership questions in one file | `userId` (varies by question) | 404-explicit |
| C4 | `teams.ts` | Per-team membership (`team_members WHERE team_id AND user_id`) — not a simple `ownerId` column | subject-derived, not row `ownerId` | 404-explicit (mechanical sweep portion only — see C34 for a later gap in this same file) |
| C5 | `marketplace-azn.ts`, `marketplace-game.ts`, `marketplace-usdt.ts`, `marketplace-vault.ts` | Marketplace listings | `sellerId`/`seller_id` | 404-explicit |
| C6 | `api-keys.ts` + 18 more (combined-where shape) | Various — first phase to catch `and(eq(id), eq(userId))` SQL shape, not just `!==` | `userId` | 404-explicit / silent-200 (`notifications.ts`) |
| C7 | `email-accounts.ts`, `wallets.ts` | Email accounts, wallets | `userId` | 404-explicit (`email_account.read/update`), silent-200 (`email_account.delete` → `{ok:true}`) |
| C8 | `vault-entity-links.ts`, `emergency-access.ts` | Vault entity links (reuses `vaultEntryResource` for one route), emergency contacts/grants | `userId` / `ownerUserId` | 404-explicit |
| C9 | `projects.ts` | Project enrollments | `userId` | silent-200 (never 404s, even pre-existing) |
| C10 | `ayzen-mailbox.ts` (part 1) | Folders/labels/templates/rules | `userId` | 404-explicit, uniform `{error:"<Thing> not found"}` |
| C11 | `ayzen-mailbox.ts` (part 2) | Message resource — read/tag half | `userId` | 404-explicit, mostly `{error:"Message not found"}` |
| C12 | `ayzen-mailbox.ts` (part 3) | Message resource — folder-transition/send-lifecycle half | `userId` | 404-explicit + compound (`409 UNDO_WINDOW_EXPIRED` race case) |
| C13 | `ayzen-mailbox.ts` (part 4) | `PATCH /mailbox/bulk` — array of ids, NOT single-resource | `userId` | `authorizeMany()` (bulk pattern, reference implementation) |
| C14 | `email-compose.ts`, thread-routes | **Real auth bug found + fixed** (missing `requireAuth`, not just missing ownership) | `userId` | 404-explicit |
| C15 | `local-accounts.ts` | Local accounts (new file for series — never in original 138-file inventory) | `userId` | mixed: 404-explicit, silent-200 (`DELETE`, `GET .../points`), and one route with **no check at all** pre-fix (`POST .../points`) |
| C16 | `local-accounts.ts` (deferred routes), `marketplace.ts` | Category/point sub-resources; marketplace listings/orders | `userId` / `seller_id` | silent-200 (categories/points), 404-explicit (listings/orders) |
| C17 | `marketplace-bundles.ts`, `marketplace-offers.ts`, `marketplace-reviews.ts`, `marketplace-cart.ts` | Bundles, offers, reviews, cart | `seller_id`/`buyer_id` (role-specific per route) | 404-explicit |
| C18 | `marketplace-alerts.ts`, `marketplace-spot.ts` | Alerts, spot orders/staking | `userId`/`user_id` | 404-explicit |
| C19A | `kyc.ts`, `kyc-data-entities.ts`, `game-entries.ts`, `earn-links.ts`, `nft-subscriptions.ts` | KYC entries, KYC data entities, game entries, earn links, NFT subscriptions | `user_id` (raw SQL, legacy table) | mixed: 404-explicit, silent-200 (`DELETE /kyc-entries/:id`), **no-check-at-all pre-fix** (`earn-links.ts`) |
| C19B | `exchange-api.ts` | Reuses `kycEntryResource`/`requireKycEntryOwnership` (first cross-file export in the series) | `user_id` | silent-200, unconditional `{success:true}` |
| C20 | *(no CHANGES doc found in this repo snapshot — number possibly skipped or doc not provided)* | — | — | — |
| C21 | `entities.ts`, `value-history.ts` | Reuses `vaultEntryResource` | `userId` | mixed: 404-explicit (most), 403-explicit (`roi` read/update), silent-200 (`value-history`'s `GET .../value-history`) |
| C22 | `value-history.ts` (local-accounts routes) | Reuses `requireLocalAccountOwnership` cross-file (same cross-file pattern as C19B) | `userId` | silent-200 (`value-history`), 404-explicit (`POST .../value`) |
| C23 | `vault-shares.ts` | Vault share records | `userId` | 404-explicit |
| C24 | `ayzen-mail.ts` | First **dual-role** owner shape — `to_user_id` OR `from_user_id` | `to_user_id`/`from_user_id` (OR-fold) | compound (`DELETE`: 403 non-party vs 404 nonexistent), silent-200 (`PATCH .../read`) |
| C25 | `security.ts`, `two-factor.ts` | Magic codes, two-factor "other" methods | `userId`/`user_id` | 404-explicit (`two-factor` PATCH), silent-200 (both DELETEs) |
| C26 | `bulk.ts` | `POST /projects/bulk-enroll` `entityIds` — **real ownership bug, unfiltered client-supplied array** | `userId` (`vault_entries.user_id`) | fixed: was **no check at all** on the `entityIds` path (the `entitySerials` path was already correctly scoped); now pre-filtered `WHERE user_id = ${userId} AND id IN (...)`, non-owned ids silently dropped (same silent-drop precedent as the rest of the series) |
| C27 | `bulk.ts` (3 remaining routes), `vault-shares.ts` (3 routes), `vault.ts` (`bulk-tag`, `bulk-action`) | Not a bug — policy-engine **consistency** sweep. All 8 routes were already correctly DB-scoped (raw SQL/Drizzle `WHERE ... AND user_id/owner_id`), just outside the `authorizeMany()`/`pepDecisionObserver` audit trail every other migrated route has | `userId`/`user_id`/`owner_id` (already correct pre-phase) | no deny-body change at all — pure audit-trail addition; three new `PolicyEngine` instances (`vaultEntryBulkOwnershipEngine`, `localAccountBulkOwnershipEngine`, `walletBulkOwnershipEngine`) + `vaultShareBulkOwnershipEngine`/`vaultShareCandidateOwnershipEngine` + `vaultBulkOwnershipEngine`, each calling `authorizeMany()` purely for audit (return value discarded, pre-existing SQL still decides what's touched) |
| C28 | `content.ts` | Project memory / generated content — **no owner column exists** (shared platform catalog, not per-user) | — (role-based, not ownership) | role-based (`requireAdmin` on 4 write routes; 3 GET routes unchanged) |
| C29 | `project-dates.ts` | `GET /projects/:id/dates` — decision: intentionally public | — | audit-only (comment added, zero behavior change) |
| C30 | `vault.ts` (core CRUD) | `vaultEntryResource` — `GET`/`PATCH`/`DELETE /vault/:id` | `userId` | 404-explicit (`GET`/`PATCH`), silent-200-adjacent (`DELETE` uses `message` key, not `error`) |
| C31 | `vault.ts` (peripheral, 11 routes) | Same `vaultEntryResource` | `userId` | mostly 404-explicit `{error:"Vault entry not found"}`; 2 routes use `{message:"Trashed vault entry not found"}` |
| C32 | `scripts/src/test-route-ownership-regression.ts` | Automated regression suite — 28 routes across the two exported builders | — | — (test-only, no production change) |
| C33 | `lib/policy/OWNERSHIP_GATING_GUIDE.md`, `scripts/src/check-ownership-gate-coverage.ts` | Pattern doc + CI lint guard (URL `:id` routes only, baseline-gated) | — | — (tooling, no production change) |
| C34 | `teams.ts` (`enroll-project`, `tasks/:taskId/enroll`) | **Real ownership bug found** — body-supplied `vaultEntryId`, invisible to C33's `:id`-only lint | `userId` | 404-explicit (`enroll-project`, upgraded from exists-only to owner-check), silent-drop (`tasks/:taskId/enroll`, previously **no check at all**) |
| | | | `scripts/src/find-body-id-audit-candidates.ts` (reusable candidate finder for future re-audits) | — | — |

**নোট — C20:** এই phase-এর CHANGES doc এই repo snapshot-এ নেই, আর কোনো
ট্রেস (code-comment, অন্য phase-এর reference) পাওয়া যায়নি — সম্ভবত
ফেজ-নম্বর ইচ্ছাকৃতভাবে skip করা হয়েছিল (এই সিরিজে একাধিকবার
re-numbering/merging হয়েছে, C19-এর A/B split-ই তার প্রমাণ)। C26/C27-এর
doc পরে সরবরাহ করা হয়েছে, উপরের টেবিলে reflect করা হলো।

---

## Audit methodology-এর reusable summary
পুরো সিরিজ জুড়ে তিনটা distinct filter ব্যবহার হয়েছে, প্রতিটা আলাদা class
ধরে:
1. **`userId !== `/`!== .*userId` grep** (C1-C5) — hand-rolled `if`
   check শেপ।
2. **`and(eq(...` grep** (C6 থেকে) — combined-where SQL শেপ, আগেরটা যা
   মিস করত।
3. **`:id`-শেপড URL param + PDP wiring presence** (C33-এর
   `check-ownership-gate-coverage.ts`, AST-based, CI-gated, baseline
   দিয়ে grandfathered)।
4. **body-array/body-id শেপ** (C26-এর manual "bulk" grep দিয়ে শুরু,
   C34-এ `find-body-id-audit-candidates.ts`-এ broadened আর reusable
   বানানো হয়েছে)।

এই চারটা filter মিলিয়ে routes/-এর ownership-gap-এর প্রায় সব known shape
কভার করে। যেকোনো ভবিষ্যৎ re-audit এই চারটাই আবার চালানো উচিত — কোনো
একটা বাদ দিলে সেই class-এর bug আবার চোখ এড়িয়ে যেতে পারে (ঠিক যেমন C34
নিজেই দেখাল, C33-এর URL-only filter body-id bug ধরতে পারেনি)।

---

## Season D দরকার কিনা — সিদ্ধান্ত

Roadmap-এর নিজের প্রশ্ন ছিল: এই audit methodology `routes/`-এর বাইরে
অন্য কোনো লেয়ারে (GraphQL/websocket, বা `lib/policy/` নিজের ভেতরের
admin-facing endpoint) দরকার কিনা।

**যাচাই করা হয়েছে:**
- **GraphQL** — এই কোডবেসে কোনো GraphQL layer পাওয়া যায়নি (`package.json`-এ
  `graphql`/`apollo`/`graphql-yoga` কোনো dependency নেই, `routes/`-এ কোনো
  `.graphql`/schema ফাইল নেই)। প্রযোজ্য না।
- **WebSocket** — `events.ts`-এ presence broadcast আছে (C1-এই "false
  positive, কোনো authz check না" হিসেবে flagged, প্রকৃতপক্ষে এটা শুধু
  read-only presence data, কোনো resource mutation না) — কিন্তু এটা এই
  codebase-এর একমাত্র realtime স্তর বলে মনে হচ্ছে, নিজস্ব ownership-gap
  ক্লাস তৈরি করার মতো surface area নেই এখন পর্যন্ত।
- **`lib/policy/`-এর নিজের admin-facing endpoint** — B3 (admin
  consoles) আর C33-এর tooling ইতিমধ্যে এই layer-টা আলাদাভাবে cover করে
  (dogfooding + lint guard), Season C-এর মূল scope (`routes/`)-এর বাইরে
  গিয়ে আলাদা প্যাটার্নে।

**সিদ্ধান্ত: এখনই Season D খোলার দরকার নেই।** GraphQL/WebSocket কোনো
নতুন surface না, আর `lib/policy/` নিজের admin console-গুলো আগে থেকেই
আলাদা ফেজে (B3) cover হয়ে গেছে। যদি ভবিষ্যতে GraphQL/WebSocket layer
যোগ হয় (নতুন product feature হিসেবে), তখন এই ফাইলের "Audit
methodology-এর reusable summary" সেকশনের চারটা filter শুরুর বিন্দু
হিসেবে reuse করা যাবে — একটা নতুন Season হিসেবে না, বরং normal feature
review-এর অংশ হিসেবে (ঠিক যেভাবে C15 `local-accounts.ts`-কে "নতুন
ফাইল, fresh sweep দরকার" হিসেবে ধরেছিল, কোনো নতুন Season খোলা ছাড়াই)।

---

## Season C — চূড়ান্ত সারসংক্ষেপ
- **৩৪টা phase** (C1-C34, C20 বাদে যেটার ট্রেস নেই), **২টা** real
  security bug পাওয়া গেছে ও ফিক্স হয়েছে (C26-এর `bulk-enroll`, C34-এর
  `teams.ts`-এর দুইটা route), **২টা** owner-decision-gated ফেজ (C28,
  C29) দুটোই resolved, **২টা** process/tooling ফেজ (C32 regression
  suite, C33 pattern-doc+lint-guard) যেগুলো ভবিষ্যতের জন্য গার্ড রেখে
  গেছে, **১টা** delta re-audit (C34) যেটা নিজেই আরেকটা bug খুঁজে পেয়েছে
  — প্রমাণ করে delta-audit ধাপটা যথেষ্ট মূল্যবান ছিল, খালি হাতে ফেরেনি।
- File-count diff (C34): ১৩৮ == ১৩৮, নতুন কোনো route ফাইল যোগ হয়নি।
- **সিরিজ বন্ধ করা যায়** — কোনো owner-decision pending নেই, কোনো known
  unaddressed real bug নেই। Baseline-এর ৩৪০টা unwired param route-এর
  মধ্যে ১১০টা role/admin-gated আর ২৪টা public/token-possession বলে
  আগের turn-এ classify করা হয়েছিল (মোট ১৩৪টা — insecure না, শুধু
  `requireOwnership()`-family-র বাইরে); বাকি ২০৬টা "auth-only, no PDP"
  bucket-এর মধ্যে একটা (`tasks.ts`-এর `logProjectReward`) এই ফেজে চেক
  করে safe পাওয়া গেছে, বাকি ২০৫টা এখনো hand-review বাকি — এটা future
  hygiene backlog, security-blocking না (প্রতিটাই `requireAuth`-এর
  পেছনে, শুধু policy-engine audit trail-এর বাইরে)।

---

## Addendum (Phase D8 কর্তৃক যোগ করা) — Season D আসলে খোলা হয়েছিল

উপরের "Season D দরকার কিনা" সিদ্ধান্তটা GraphQL/WebSocket/admin-console
layer-এর প্রশ্নে সঠিক থেকে গেছে (কোনোটাই নতুন surface হয়ে ওঠেনি)। কিন্তু
এই ফেজেরই নিজের "চূড়ান্ত সারসংক্ষেপ"-এ উল্লেখ করা বাকি ২০৫টা "auth-only,
no PDP" route hand-review — সেই backlog পরে সত্যিই একটা Season D হিসেবে
খোলা হয়েছে (`ROADMAP_ROUTE_INTEGRATION_PHASE_D1_D8.md`), যদিও সিদ্ধান্তটা
ভিন্ন layer/surface না, বরং এই একই `routes/` scope-এর ভেতরের একটা
pre-existing backlog close করার জন্য। এই addendum সেই Season D-এর
disposition-টা এই ফাইলের own stated purpose ("single reference table")
মেনে এখানেই যোগ করে।

### Season D — ফাইল → disposition (D1-D8)

| Phase | ফাইল/scope | Route সংখ্যা | মূল ফলাফল |
|---|---|---|---|
| D1 | `teams.ts` triage | ৫৭ | ৪ inline-role (bucket ক), ৫১ membership-shape (bucket খ, ৪টা উপ-প্যাটার্নে ভাগ), ২ flagged (owner-decision, D5-এ resolved) |
| D2 | `finance.ts` + `finance-invoices.ts` triage | ৪৬ | ৩২ raw-SQL owner-scoped, ৭ public/token, ১ public+self-scoped-write, ৬ already inline-`authorize()`-PDP-routed |
| D3 | `projects.ts` + `tasks.ts` triage | ৩৮ | ৯ role-middleware, ৯ public, ৯ self-scoped, ৭ membership/owner raw-SQL, ৩ already-PDP; **১টা real বাগ ফিক্স** (`GET /projects/:id/members` — unauthenticated email/userId leak, sibling admin route-এর সাথে মিলিয়ে `requireRoles("admin","moderator")` যোগ করা হলো) |
| D4 | Long-tail (৭০ ফাইল) triage | ১৯৯ | ১০৯ role/permission-gated, ৫৮ raw-SQL/already-PDP, ২৫ public/token, ৬ login-gate-only, ২ flagged (owner-decision, D5-এ resolved); **১টা real বাগ ফিক্স** (`plugins.ts`-এর `/admin/plugins` GET+PATCH — কোনো auth-ই ছিল না, প্ল্যাটফর্ম-ওয়াইড plugin enable/disable including 2FA off করার ক্ষমতা; `requireAdmin` যোগ করা হলো) |
| D5 | Owner-decision roundup | ৪ (D1-এর ২ + D4-এর ২) | `teams.ts` mission create/update → leader-gate যোগ (behavior change, owner sign-off); `events.ts` presence + `tools.ts` streak → login-gate যোগ (ownership না, শুধু authenticated হতে হবে) |
| D6 | `createGroupMembershipRule()` | নতুন PDP rule + `teams.ts`-এর ৪২ route | `team_members`-ভিত্তিক per-team role/membership fact-এর জন্য নতুন reusable rule (`lib/policy/resource/group-membership-rule.ts`) — C4-এর নিজস্ব "এই শেপ `requireOwnership()`-এ ফিট করে না" পর্যবেক্ষণকে সম্মান করেই, তার পাশে একটা নতুন rule-type যোগ করা হলো, বিদ্যমান কিছু বদলানো ছাড়াই |
| D7 | Audit-trail consistency sweep | ৫৮ candidate, ৪২ আগে থেকেই wired, ২ নতুন audit-wired, ১৪ ইচ্ছাকৃতভাবে বাদ | কোনো SQL/behavior বদলায়নি — শুধু `pepDecisionObserver`-এ কেন্দ্রীয় audit visibility (`finance.ts`, `finance-invoices.ts`, `teams.ts`-এর কম্পাউন্ড bucket, `projects.ts`-এর ২টা client-supplied-entity-id route) |
| D8 | Lint script fix + baseline shrink + close-out | বেসলাইন ৩৪০ → ১৫৪ | তিনটা detection gap বন্ধ (bare role middleware, `requireRoles` factory, inline `authorize()`/role-check) — ১৮৬টা route এখন সঠিকভাবে "wired" দেখায়, কোনোটাই আগে অনিরাপদ ছিল না, শুধু script-এর shape-blindness ছিল |

### Season D — সংক্ষিপ্ত সারাংশ
- **৩৪০টা route triage করা হয়েছে** (D1-D4, ১৩৮ ফাইল) — Season C-এর
  বেসলাইনের সবটাই, শুধু মূল "২০৬-route auth-only backlog" না।
- **২টা real security বাগ পাওয়া গেছে ও সাথে সাথে ফিক্স হয়েছে**
  (D3-এর email/userId leak, D4-এর unauthenticated plugin-toggle) —
  Season C-এর C26/C34-এর precedent-এর সাথে সামঞ্জস্যপূর্ণ ("audit
  first, বাগ পেলে সাথে সাথে ফিক্স")।
- **৪টা owner-decision-gated ফেজ** — সবগুলোই D5-এ resolved (Season
  C-এর C28/C29-এর precedent)।
- **১টা নতুন reusable PDP rule** (D6) — Season D-এর নিজস্ব triage-এর
  আবিষ্কার (membership-shape যথেষ্ট বড়/repeated) থেকে সরাসরি উদ্ভূত,
  বিদ্যমান C4 সিদ্ধান্ত উল্টানো ছাড়াই।
- **১টা consistency sweep** (D7) — Season C-এর C27-এর precedent, কোনো
  SQL/behavior বদলায়নি।
- **Lint script-এর নিজের তিনটা detection gap বন্ধ** (D8) — Season
  C-এর C33-এর script-এর নিজস্ব সীমাবদ্ধতা, D1-D4-এর হাতে-verify করা
  findings থেকে সরাসরি চিহ্নিত হয়েছিল।
- **Baseline: ৩৪০ → ১৫৪** — বাকি ১৫৪টাই hand-verified নিরাপদ, শুধু
  `requireOwnership()`/`authorizeMany()` PDP family-র বাইরের shape
  (raw-SQL owner-scoping, public/token-possession, self-scoped
  write/read, login-gate-only, audit-only wiring) — বিস্তারিত
  `CHANGES_ROUTE_INTEGRATION_PHASE_D8.md`-এ।
- **সিরিজ বন্ধ করা যায়** — Season D-তেও কোনো owner-decision pending নেই,
  কোনো known unaddressed real বাগ নেই।

## Addendum (Phase E7 কর্তৃক যোগ করা) — Season E

D8-এর নিজস্ব close-out ১৫৪-route backlog রেখে গিয়েছিল, "কোনোটাই blocking
না... future hygiene backlog" বলে। `ROADMAP_ROUTE_INTEGRATION_PHASE_
E1_E7.md` সেই backlog নিয়ে কী করা যায় তার পরিকল্পনা করেছিল — Season D-এর
মতো "সব গেট করো" দিয়ে না, বরং কোনগুলো wire করা আসলে মূল্য যোগ করে সেটা
বেছে নিয়ে। এই addendum সেই Season E-এর disposition এই ফাইলের own stated
purpose ("single reference table") মেনে এখানেই যোগ করে, ঠিক D8 নিজে
Season D-এর জন্য যেমন করেছিল।

### Season E — ফাইল → disposition (E1-E7)

| Phase | ফাইল/scope | Route সংখ্যা | মূল ফলাফল |
|---|---|---|---|
| E1 | `finance.ts`: book + entry-derived group | ১৩ promoted | বিদ্যমান resource builder/factory reuse করে audit-only থেকে real `requireOwnership()`-এ promote; একটা ordering ফাঁদ ডকুমেন্ট করা হয়েছে |
| E2 | `finance.ts`: বাকি audit-only group | ১৮ promoted | `finance.ts` পুরোপুরি D7 audit-only-মুক্ত; `auditFinanceOwnership()` helper আর ৯টা `*AuditEngine` const dead code হিসেবে সরানো হলো |
| E3 | `projects.ts`: raw-SQL/audit-only group | ২ promoted | `POST /projects/:id/enroll`-এর `vaultEntryId` অর্ধেক promote; `kycEntryId` অর্ধেক (optional body field, router-level gate ফিট করে না) ইচ্ছাকৃতভাবে audit-only থেকে গেল |
| E4 | `teams.ts`: D7-এর leader-অর্ধেক audit-only routes | ০ promoted (৬ triaged) | সবকটা re-confirmed genuinely self-scoped — D6-এর সিদ্ধান্ত সঠিক প্রমাণিত হলো, কোনো code change লাগেনি |
| E5 | নতুন resource-builder: `vault-attachments.ts` + `ayzen-mailbox.ts` re-triage | ৫ promoted (৫ re-confirmed self-scoped) | `vault-attachments.ts`-এর জন্য নতুন `ResourceRefBuilder`; `ayzen-mailbox.ts`-এর ৫টা (thread/contacts/senders/problematic-recipients) genuinely self-scoped প্রমাণিত হলো, `makeAyzenMailboxOwnerResource()` তাই বানানো হয়নি |
| E6 | Long-tail triage: বাকি ~৩৪ ফাইল, ~৮০ route | ৭ promoted (৮২ reviewed, ইচ্ছাকৃতভাবে unwired) | ৩টা genuine gap পাওয়া গেছে বিদ্যমান/সহজে-shared builder দিয়ে (`marketplace-offers.ts`, `vault-snapshot.ts`-এর নতুন builder, `exchange-api.ts`); বাকি সব public/cross-user-by-design/self-scoped/compound-shape/ইতিমধ্যে-reserved (Phase B2-এর জন্য `wallets.ts`) হিসেবে ডকুমেন্ট করা হলো |
| E7 | Close-out: baseline final shrink + Season E addendum | বেসলাইন ১৫৪ → ৮৯ | `auditProjectsOwnership()` এখনো live caller আছে (`kycEntryId` enrollment path) বলে সরানো হয়নি — শুধু `auditFinanceOwnership()`-ই (E2) dead code হয়ে সরানো হয়েছিল |

### Season E — সংক্ষিপ্ত সারাংশ
- **৪৫টা route promote হয়েছে** (E1 ১৩ + E2 ১৮ + E3 ২ + E4 ০ + E5 ৫ +
  E6 ৭) audit-only/raw-SQL-only থেকে real, blocking
  `requireOwnership()`/`authorizeMany()` PDP enforcement-এ।
- **কোনো real security বাগ পাওয়া যায়নি এই সিজনে** — D3/D4-এর মতো না;
  প্রতিটা "unwired" entry আগে থেকেই raw-SQL-scoped নিরাপদ ছিল বা
  genuinely ownership-শেপ ছিল না, শুধু PDP audit trail-এ ছিল না।
- **১টা নতুন `ResourceRefBuilder`** (E5, `vault-attachments.ts`-এর জন্য)
  আর **১টা নতুন `ResourceRefBuilder`** (E6, `vault-snapshot.ts`-এর জন্য) —
  দুটোই বিদ্যমান single-owner shape-এর mechanical repeat, নতুন rule-type
  লাগেনি (D6-এর `createGroupMembershipRule()`-এর বিপরীতে)।
- **২টা বিদ্যমান builder পুনর্ব্যবহার করা হয়েছে exported করে** (E6:
  `marketplaceListingResource`, আর `kyc.ts`-এর ইতিমধ্যে-exported
  `kycEntryResource` — যেটা exchange-api.ts-এ আরেকবার reuse হলো) — D-সিজনের
  `vaultEntryResource`/`kycEntryResource` reuse precedent-এর ধারাবাহিকতা।
- **৩টা "strict id" wrapper** (E6: `vault-snapshot.ts`-এর ৫টা route +
  `exchange-api.ts`) — Phase C11-এর precedent অনুসরণ করে, pre-existing
  `400 "Invalid ... id"` বনাম `404 "not found"` split অবিকৃত রাখতে।
- **auditFinanceOwnership() সরানো হয়েছে (E2), auditProjectsOwnership()
  সরানো হয়নি** — পরেরটার এখনো একটা live caller আছে (`projects.ts`-এর
  `kycEntryId` enrollment path, E3 নিজেই deferred করেছিল E7-এ, কোনো
  E4-E6 ফেজ সেই caller টাচ করেনি)। D-সিজনের "caller না হারানো পর্যন্ত না
  সরানোর" নিয়মের ধারাবাহিকতা।
- **Baseline: ১৫৪ → ৮৯** — phase-by-phase: E1 ১৫৪→১৪১, তারপর E2 শুরুর
  সময় স্বাধীনভাবে মাপা সংখ্যা ছিল ১২১ (E1-এর নিজস্ব ১৪১-এর সাথে না মিলিয়ে
  — এই gap-টা এই addendum লেখার সময় ব্যাখ্যা করা যায়নি, ফাইলে ফ্ল্যাগ করে
  রাখা হলো, কোনো অনুমান ছাড়াই), E2 ১২১→১০৩, E3 ১০৩→১০১, E4 ১০১→১০১
  (অপরিবর্তিত), E5 ১০১→৯৬, E6 ৯৬→৮৯। প্রতিটা সংখ্যা তার নিজস্ব ফেজের
  CHANGES ডকে, real `tsx scripts/src/check-ownership-gate-coverage.ts`
  রান থেকে verified।
- **বাকি ৮৯টা** — সবকটাই hand-verified, একটা নির্দিষ্ট, ডকুমেন্টেড কারণে
  ইচ্ছাকৃতভাবে বাদ: public/token-possession, cross-user-by-design action,
  self-scoped own-row (আলাদা resource-id নেই), compound/multi-outcome
  shape যা একটা single `ownerId` check-এ ফিট করে না, বা explicitly অন্য
  named phase-এর জন্য reserved (`wallets.ts`-এর `/phrase` জোড়া, Phase B2)।
  বিস্তারিত প্রতিটা phase-এর নিজস্ব CHANGES ডকে।
- **সিরিজ বন্ধ করা যায়** — Season E-তে কোনো owner-decision pending নেই,
  কোনো known unaddressed real বাগ নেই। একমাত্র open item: E1→E2-এর
  মাঝের অব্যাখ্যাত ১৪১→১২১ gap-টা — নিরাপত্তার দিক থেকে নিরীহ (সংখ্যাটা
  *কমেছে*, কোনো নতুন unwired route যোগ হয়নি; script প্রতিটা রান-এ কোনো
  *নতুন* gap ধরত), কিন্তু কেউ ভবিষ্যতে এই history দেখলে যেন প্রশ্নটা
  আবার তুলতে পারে, তাই এখানে লেখা রইলো, চাপা না দিয়ে।
