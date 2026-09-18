# Route Integration Roadmap — Season C, Phase C4: Mechanical Sweep (batch 4, `teams.ts`)

## যা আগে থেকেই ছিল
Phase C1 নিজের "এখনো যা বাকি" অংশে `finance-invoices.ts` (988 লাইন) আর
`teams.ts` (1557 লাইন)-কে "বড়, নিজের batch প্রাপ্য" বলে দুইবার (C1, C2)
touch না করে রেখে দিয়েছিল। Phase C3 প্রথমটা করেছে। এই ফেজ (batch 4)
`teams.ts` করল — Season C-এর শেষ চিহ্নিত বড় ফাইল।

`support.ts`/`tasks.ts`/`passkey.ts`/`vault-reauth.ts`/`finance-invoices.ts`-এর
মতো grep পুনরায় চালানো হলো (`userId !== `/`!== .*userId`) — ৮টা hit
পাওয়া গেল, কিন্তু এই ফাইলের ফলাফল আগের সব batch-এর চেয়ে গুণগতভাবে ভিন্ন।

## এই ফাইলটা কেন আলাদা — একটা নতুন সীমাবদ্ধতা প্রথমবার সামনে এলো

আগের প্রতিটা batch-এর ownership প্রশ্ন ছিল হয় (ক) একটা single global
`ownerId`/`userId` column-এর সাথে `subject.userId`-এর তুলনা, অথবা (খ) তার
সাথে একটা **global** `subject.role` bypass (admin) — দুটোই
`createResourceOwnershipRule()` + `createRoleOverrideRule()` দিয়ে সরাসরি
মডেল করা যায়, কারণ `RoleOverrideRule` যেটা দেখে সেটা `subject.role` —
ব্যবহারকারীর platform-wide role।

`teams.ts`-এর বেশিরভাগ authorization অবশ্য গড়ে উঠেছে একটা **per-team**
"leader" role-এর উপর — `team_members` টেবিলের একটা row, প্রতি রিকোয়েস্টে
আলাদাভাবে লুকআপ করা হয় (`SELECT role FROM team_members WHERE team_id = ...
AND user_id = ...`)। এটা `subject`-এর নিজের কোনো property না — এটা একটা
নির্দিষ্ট (team, user) জোড়ার সম্পর্কে একটা fact। বর্তমান engine-এ এটা মডেল
করার কোনো rule type নেই: `createRoleOverrideRule([...])` জিজ্ঞেস করে "এই
subject-এর global role কি তালিকায় আছে", "এই subject কি **এই নির্দিষ্ট
resource-এর** leader" না। এটা একটা নতুন per-resource membership/role rule
দাবি করে যা এই ফেজের scope-এর বাইরে — roadmap নিজেই যে নীতি বলে
(resource/ownership-rule.ts-এর নিজের header-এ 3A কেন শুধু ownerId +
locked-এ সীমাবদ্ধ রাখা হয়েছিল তার একই কারণ): ভবিষ্যতের ফেজ আগেভাগে
implement করা যাবে না।

তাই এই ফেজের নীতি: প্রতিটা hand-rolled `role !== "leader"` check **হুবহু
অপরিবর্তিত** থাকল। যেখানে check-টা সম্পূর্ণভাবে একটা `ownerId`-শেপ তুলনা
(কোনো per-team role জড়িত না), সেটা PDP-তে গেল। যেখানে check-টা compound
("leader OR owner") — সেখানে শুধু ownerId-শেপ অংশটা PDP-তে গেল, `role !==
"leader"` অংশটা হাতে-লেখা রয়ে গেল, দুটো মিলিয়ে আগের মতোই একই boolean
ফলাফল দেয়। এটা Phase C1-এর "owner OR admin" shim-এর একটা সংকীর্ণ সংস্করণ —
সেখানে পুরো check-টাই এক engine-এ (দুটো rule দিয়ে) ফিট করত, এখানে তার
অর্ধেকটাই করে।

## ৮টা grep hit-এর classification

| # | Location | শেপ | সিদ্ধান্ত |
|---|---|---|---|
| 1 | `DELETE /teams/:id` — `team.owner_id !== userId` | pure ownership (team owner) | ✅ in scope |
| 2 | `DELETE /teams/:id/members/:memberId` — `myRole !== "leader" && userId !== memberId` | compound: per-team leader (out of scope) + self-membership ownership (in scope) | ✅ আংশিক in scope |
| 3 | `PATCH /teams/:id/members/:memberId/role` — `leaderCheck.owner_id !== userId` | pure ownership (team owner) | ✅ in scope |
| 4 | `POST /teams/:id/enroll-project` লুপ — `memberId !== userId` | **false positive** — "নিজেকে notify কোরো না", কোনো authz gate না | ❌ out of scope |
| 5 | `POST /teams/:id/tasks/:taskId/enroll` লুপ — `memberId !== userId` | **false positive**, #4-এর same shape | ❌ out of scope |
| 6 | `POST /teams/:id/transfer-ownership` — `team.owner_id !== userId` | pure ownership (team owner) | ✅ in scope |
| 7 | `DELETE /teams/:id/messages/:messageId` — `message.user_id !== userId && role !== "leader"` | compound: message authorship (in scope) + per-team leader (out of scope) | ✅ আংশিক in scope |
| 8 | `PATCH /teams/:id/messages/:messageId` — `existing.user_id !== userId` | pure ownership (message author, কোনো leader override নেই) | ✅ in scope |

#4/#5 ঠিক Phase C1-এর `events.ts` আর Phase C2-র `login/verify` exclusion-এর
মতো — grep pattern মিলে গেছে কিন্তু আসলে কোনো authorization প্রশ্নই না
(একটা loop-এর ভেতরে "requester নিজেকে notification পাঠাবে না" এই চেক)।
Untouched, শুধু কোনো নতুন কমেন্ট যোগ হয়নি কারণ এই দুটো জায়গায় authz-এর
সাথে সম্পর্কহীনতা কোডেই স্পষ্ট (notification পাঠানোর ঠিক আগে)।

## যেটা যোগ করা হলো (Phase C4)

### দুটো call shape, আগের batch-গুলোই যা establish করেছিল
- **`DELETE /teams/:id`**: `requireAuth` + id-parse ছাড়া ownership
  decision-এর আগে হ্যান্ডলারের আর কিছু চলে না — router-level
  `requireOwnership()` (Phase B1-র প্যাটার্ন) সরাসরি বসানো হলো।
- বাকি সবগুলো (role-change, transfer-ownership, member self-removal,
  message delete/edit): এর আগে একটা body-shape validation (400), অন্য কোনো
  resource-এর existence check (404), অথবা already-fetched row-এর নিজস্ব
  column ব্যবহারের প্রয়োজন — router-level middleware বসালে ordering
  বদলে যেত (Phase C1/C2/C3-এর same hazard)। এই route-গুলো inline
  `authorize()` ব্যবহার করল, ঠিক যেখানে ownership decision-টা আগে থেকেই
  হচ্ছিল সেই জায়গায়।

### Resource lookup — DB থেকে real owner অথবা URL-এর নিজস্ব identity, কখনো client-supplied ownerId trust না করে
`teamResource` (`teams.owner_id`) প্রতিবার fresh DB read করে — কোনো নতুন
Drizzle table নেই এই ফাইলে (সব `db.execute(sql...)`), তাই lookup-টাও এই
ফাইলের নিজস্ব `sql` tagged-template শৈলীতে লেখা হয়েছে (auto-parameterized),
পুরনো `sql.raw(...)` কলগুলো (এই ফেজ যেগুলো touch করেনি) থেকে আলাদা।
Member self-removal-এর resource-এর কোনো আলাদা DB lookup লাগেনি — একটা
`team_members` row-এর owner-ই হলো URL-এ উল্লেখিত member id (এমন কোনো
আলাদা, spoofable "কে এই membership-এর মালিক" field নেই যেটা fetch করতে
হবে — original কোডও কখনো এমন কিছু query করেনি)। Message route দুটো
already-fetched row-এর নিজস্ব `user_id` reuse করল (Phase C3-এর
payer-ownership routes #11–13-র মতো direct-replacement shape, নতুন
কোনো query ছাড়া)।

`TEAMS_OWNER_SENTINEL_NONE` (`-1`) — `FINANCE_OWNER_SENTINEL_NONE`/
`PASSKEY_OWNER_SENTINEL_NONE`/`FINANCE_INVOICE_OWNER_SENTINEL_NONE`-এর same
posture: না-থাকা team-ও PDP-তে একটা normal, auditable DENY হিসেবে
পৌঁছায়, 500 না — response body আগের মতোই (`!team || team.owner_id !==
userId` আগেও nonexistent আর non-owner দুটোর জন্যই একই error দিত)।

### একটাই shared engine, module-load-time; `createRoleOverrideRule()` ব্যবহার হয়নি
`teamsOwnershipEngine` — router-level `requireTeamOwnership()` বাদে বাকি
পাঁচটা inline `authorize()` কল এই একটা engine শেয়ার করে (Phase C2/C3-র
same single-engine-per-file পোস্টার)। `createRoleOverrideRule()` register
করা হয়নি — এই ফাইলে যে role-bypass আছে (`leader`) সেটা global
`subject.role` না, per-team fact, যা ওই rule মডেল করতে পারে না (উপরের
ব্যাখ্যা দ্রষ্টব্য)।

| # | Route | Shape | নতুন `action` | Response gate (অপরিবর্তিত) |
|---|---|---|---|---|
| 1 | `DELETE /teams/:id` | router-level `requireOwnership()` | `team.disband` | `403 { error: "Only team owner can disband" }` |
| 2 | `PATCH /teams/:id/members/:memberId/role` | inline `authorize()`, add-new-keep-old (`role`-শেপ validation আগে চলে, unchanged) | `team.member.role_change` | `403 { error: "Only owner can change roles" }` |
| 3 | `POST /teams/:id/transfer-ownership` | inline `authorize()`, add-new-keep-old (`newOwnerId` presence check আগে চলে, unchanged) | `team.transfer_ownership` | `403 { error: "Only the current owner can transfer ownership" }` |
| 4 | `DELETE /teams/:id/members/:memberId` | inline `authorize()`, **আংশিক** (শুধু self-ownership অর্ধেক; `myRole !== "leader"` হাতে-লেখা রইল) | `team.member.remove_self` | `403 { error: "Not allowed" }` |
| 5 | `DELETE /teams/:id/messages/:messageId` | inline `authorize()`, **আংশিক** (শুধু authorship অর্ধেক; `role !== "leader"` হাতে-লেখা, message existence 404 হাতে-লেখা) | `team.message.delete` | `403 { error: "Not allowed to delete this message" }` |
| 6 | `PATCH /teams/:id/messages/:messageId` | inline `authorize()`, direct replacement (existence 404 হাতে-লেখা) | `team.message.update` | `403 { error: "You can only edit your own messages" }` |

## এই ফেজে যা সরানো হয়নি
- প্রতিটা route-এর existing SQL query/delete/update — এখনো আছে, এখনো আসল
  enforcement; নতুন `authorize()`/`requireOwnership()` কল একটা দ্বিতীয়,
  পর্যবেক্ষণযোগ্য স্তর মাত্র (routes #1-এর router-level ছাড়া বাকিগুলো তো
  আগে থেকেই inline ছিল, এখন শুধু PDP দিয়ে যায়)।
- ফাইলের প্রতিটা `role !== "leader"` hand-rolled check (per-team role gate)
  — **একটাও touch করা হয়নি**। এটা এই ফেজের সবচেয়ে গুরুত্বপূর্ণ scope
  boundary — উপরের ব্যাখ্যা দ্রষ্টব্য।
- `/admin/teams`-এর অধীনে থাকা platform-wide `role !== "admin"/"operator"/
  "moderator"` inline check-গুলো — এগুলো `userId !==`/ownership শেপ না
  (grep-এ ধরাই পড়েনি), এই ফেজের scope-এর বাইরে। এগুলো আসলে RBAC-শেপ
  (global role membership), `middlewares/auth.ts`-এর
  `requireAdmin`/`requireRoles`-এর মতো — কিন্তু এই ফাইল সেগুলো import করে
  না, নিজের ভেতরে হাতে-লেখা `req.user!.role !== ...` করে। একটা ভবিষ্যৎ
  ফেজের প্রার্থী (এই ফাইলকে `requireRoles([...])`/`requireRole([...])`-এ
  সরানো), কিন্তু ownership-sweep-এর scope না — touch করা হয়নি।
- `POST /teams/:id/enroll-project`/`.../tasks/:taskId/enroll`-এর
  `memberId !== userId` — false positive, ব্যাখ্যা উপরে।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral —
প্রতিটা route-এর জন্য response শেষ পর্যন্ত অপরিবর্তিত (same status code,
same body, same owner-only/owner-or-leader logic, একই order-এ same
side-effects), শুধু ভেতরে এখন (ownership-শেপ অংশটুকু) PDP জড়িত।

## যা টেস্ট করা হয়েছে
- এডিট করা ফাইলের bracket/brace/paren balance স্ক্রিপ্ট দিয়ে চেক করা
  হয়েছে — `{}` 821/821, `()` 1516/1516, `[]` 192/192, সব শূন্যে মেলে।
- `tsc --noEmit --skipLibCheck --ignoreConfig` ফাইলের উপর চালানো হয়েছে —
  বাকি থাকা প্রতিটা error module-resolution-জনিত (`express`/`@workspace/db`/
  `drizzle-orm`/`imap-simple`/ইত্যাদি, node_modules install না থাকায়)
  অথবা pre-existing implicit-any (`req`/`res`/ইত্যাদি, `@types/node`/
  `@types/express` ছাড়া) — ঠিক আগের ফেজগুলোর মতোই বেসলাইন noise। নতুন
  যোগ করা কোনো identifier (`authorize`, `PolicyEngine`,
  `createResourceOwnershipRule`, `requireOwnership`, `ResourceRefBuilder`,
  `pepDecisionObserver`, `teamResource`, `requireTeamOwnership`,
  `teamsOwnershipEngine`, `TEAMS_OWNER_SENTINEL_NONE`) নিয়ে কোনো error
  ওঠেনি।
- প্রতিটা import সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep
  করে যাচাই করা হয়েছে (`requireOwnership` → `lib/policy/pep/middleware.ts`,
  `authorize` → `lib/policy/pep/authorize.ts`, `ResourceRefBuilder` →
  `lib/policy/pep/types.ts`, `PolicyEngine` → `lib/policy/policy-engine.ts`,
  `createResourceOwnershipRule` → `lib/policy/resource/ownership-rule.ts`,
  `pepDecisionObserver` → `middlewares/auth.ts`)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner →
  ownership rule ALLOW → আগের success path। non-owner বা নাই-এমন id →
  ownership rule abstain (sentinel বা real mismatch) → default-deny
  (`NO_MATCHING_POLICY`) → আগের একই error status/body। Compound
  routes-এ (#4, #5) leader-override এখনো ঠিক আগের মতো কাজ করে (JS
  boolean logic অপরিবর্তিত, শুধু একটা operand এখন PDP থেকে আসে)। #2/#3-এ
  pre-existing validation এখনো ownership-এর আগে চলে, ordering অপরিবর্তিত।
  #5/#6-এ message-existence hand-rolled 404 এখনো ownership-check-এর আগে।

## এখনো যা বাকি
Season C-র জন্য চিহ্নিত দুটো বড় ফাইলই (`finance-invoices.ts`,
`teams.ts`) এখন করা হয়ে গেছে। বাকি ছোট route-গুলোর mechanical sweep
(যদি কোনো `userId !==`/`!== .*userId` hit বাকি থাকে ১৩৮টা route-এর
মধ্যে) ভবিষ্যতের কোনো Phase C5+-এ, ছোট batch-এ চলতে পারে — এই ফেজ সেই
audit চালায়নি (শুধু `teams.ts`-এ ফোকাস করেছে)। `/admin/teams`-এর
platform-wide role check-গুলোকে `requireRoles()`/PDP-routed করার কাজ
এখনো বাকি (উপরে উল্লেখিত), এবং per-team "leader" role-কে PDP-তে সঠিকভাবে
মডেল করতে হলে একটা নতুন rule type (team-membership/role rule) লাগবে —
এই দুটোই Season C-এর mechanical-sweep scope-এর বাইরে, ভবিষ্যতের কোনো
আলাদা আলোচনার বিষয়।
