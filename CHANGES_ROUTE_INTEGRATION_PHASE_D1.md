# Route Integration Roadmap — Season D, Phase D1: `teams.ts` triage (৫৭ route)

## Scope
`ROADMAP_ROUTE_INTEGRATION_PHASE_D1_D8.md`-এর D1 — ২০৬-route "auth-only,
no PDP" backlোগের সবচেয়ে বড় ফাইল (`teams.ts`, ৫৭ route,
`ownership-gate-baseline.json`-এ hand-verify করা)। প্রতিটা route নিজে
পড়ে তিনটা bucket-এ classify করা হয়েছে: (ক) inline role-gated, (খ)
membership-shape (Season C4-এ যতটা রিভিউ হয়েছিল সেটা কনফার্ম করে), (গ)
সত্যিই কোনো check নেই। কোনো code change এই ফেজে বাধ্যতামূলক ছিল না —
bucket (গ)-তে সত্যিকারের কিছু পাওয়া গেলে সেটা সাথে সাথে ফিক্স হতো।

## ফলাফল সংক্ষেপে

| Bucket | সংখ্যা |
|---|---|
| (ক) Inline platform-role check (`role !== "admin"`/`"operator"`/`"moderator"`, `requireAdmin` মিডলওয়্যার ব্যবহার করে না) | ৪ |
| (খ) Membership-shape (`team_members` lookup — সদস্য/leader/self চেক) | ৫১ |
| ফ্ল্যাগড — ambiguous, decision দরকার (bucket গ না, কিন্তু bucket খ-ও ঠিক না) | ২ |
| **মোট** | **৫৭** |

কোনো bucket (গ) — "সত্যিই কোনো check নেই" — পাওয়া যায়নি। তাই এই ফেজে
কোনো immediate bug-fix হয়নি। ২টা route ফ্ল্যাগ করা হয়েছে, নিচে দেখুন —
সেগুলো bucket (গ)-এর মতো ক্লিয়ার-কাট cross-tenant leak না, তাই silently
ফিক্স না করে owner-decision-এর জন্য রাখা হলো (C28/C29-এর precedent)।

---

## Bucket (ক) — Inline platform-role check, ৪টা

সবগুলোই `requireAdmin`/`requireRole` মিডলওয়্যার ব্যবহার না করে হাতে-লেখা
`req.user!.role !== "..."` চেক। কোনো bug না — শুধু script-এর চোখে
"unwired" দেখায় কারণ `PEP_WIRING_NAMES`-এ এই প্যাটার্ন নেই। D8-এ script-এ
নতুন detection branch যোগ হলে এগুলো আর false-flag হবে না।

| Route | চেক |
|---|---|
| `DELETE /admin/teams/:id` | `role !== "admin" && role !== "operator"` |
| `GET /admin/teams/:id/members` | `role !== "admin" && role !== "operator" && role !== "moderator"` |
| `PATCH /admin/teams/:id` | `role !== "admin" && role !== "operator" && !isModerator` |
| `POST /admin/teams/:id/broadcast` | `role !== "admin" && role !== "operator"` |

## Bucket (খ) — Membership-shape, ৫১টা

সব ক'টাই `team_members WHERE team_id AND user_id [AND status='active']`
lookup দিয়ে caller টিমের সদস্য কিনা (আর কোথাও leader কিনা) verify করে।
তিনটা উপ-প্যাটার্ন:

**খ.১ — শুধু membership যথেষ্ট (যেকোনো active member):**
`GET /teams/:id`, `GET /teams/:id/stats`, `GET /teams/:id/leaderboard`,
`GET /teams/:id/member-progress`, `GET /teams/:id/activity`,
`GET /teams/:id/projects`, `GET /teams/:id/messages`,
`POST /teams/:id/messages`, `GET /teams/:id/vault`,
`POST /teams/:id/vault`, `GET /teams/:id/missions`,
`GET /teams/:id/missions/:missionId`, `GET /teams/:id/messages/pinned`,
`GET /teams/:id/announcements`, `GET /teams/:id/analytics/growth`,
`GET /teams/:id/members/:memberId`, `GET /teams/:id/email-accounts`,
`GET /teams/:id/email-accounts/:accountId/stored-messages`,
`POST /teams/:id/email-accounts/:accountId/fetch-inbox`,
`POST /teams/:id/email-accounts/:accountId/fetch-body` (১৯টা)

**খ.২ — leader role নির্দিষ্টভাবে দরকার:**
`PATCH /teams/:id`, `PATCH /teams/:id/avatar`,
`PATCH /teams/:id/visibility`, `POST /teams/:id/invite`,
`POST /teams/:id/invite-link`, `GET /teams/:id/join-requests`,
`PATCH /teams/:id/join-requests/:requestId`,
`PATCH /teams/:id/members/:memberId/note`,
`POST /teams/:id/announcements`,
`POST /teams/:id/messages/:messageId/pin`,
`DELETE /teams/:id/missions/:missionId`,
`POST /teams/:id/missions/:missionId/claim`, `GET /teams/:id/export`,
`GET /teams/:id/audit-log`, `POST /teams/:id/enroll-project`,
`POST /teams/:id/tasks/:taskId/enroll`,
`POST /teams/:id/email-accounts/test-config`,
`POST /teams/:id/email-accounts` (leader adds mailbox),
`PUT /teams/:id/email-accounts/:accountId`,
`DELETE /teams/:id/email-accounts/:accountId`,
`DELETE /teams/:id/messages/:messageId` (leader-OR-author, নিচে দেখুন)
(২১টা)

`enroll-project`/`tasks/:taskId/enroll`-এ client-supplied
`vaultEntryId` আগেই C34-এ owner-prefilter দিয়ে ফিক্স হয়ে গেছে (এই ফেজে
নতুন কিছু করার নেই, শুধু কনফার্ম করা হলো ফিক্সটা এখনো জায়গায় আছে)।

**খ.৩ — self-scoped (caller নিজের row-ই touch করে, membership check
আলাদা করে লাগে না কারণ query নিজেই `user_id = userId` দিয়ে scoped):**
`POST /teams/:id/favorite`, `POST /teams/:id/join-request`,
`POST /teams/:id/leave`, `PATCH /teams/:id/invites/respond`,
`PATCH /teams/:id/notifications`, `GET /teams/:id/notifications`
(৬টা)

**খ.৪ — Phase C4-তে ইতিমধ্যে explicitly PDP-routed (compound
"leader OR owner", কোড কমেন্টে confirm করা আছে, roadmap-এর নিজস্ব
context-এ যেটা উল্লেখ ছিল):**
`DELETE /teams/:id/members/:memberId` (leader OR self,
`team.member.remove_self` PDP action),
`PATCH /teams/:id/members/:memberId/role` (owner-শেপ,
`team.member.role_change`),
`DELETE /teams/:id/messages/:messageId` (leader OR author,
`team.message.delete`),
`PATCH /teams/:id/messages/:messageId` (author-only,
`team.message.update`),
`POST /teams/:id/transfer-ownership` (owner-শেপ,
`team.transfer_ownership`)
(৫টা — এই ৫টা `authorize()`-এর মাধ্যমে PDP-তে যায়, কিন্তু inline call
বলে lint script এখনো "unwired" দেখায়; D8-এর script fix-এর candidate)

মোট খ = ১৯ + ২১ + ৬ + ৫ = ৫১। ✓

---

## ফ্ল্যাগড — ২টা, decision দরকার (bucket গ না, কিন্তু bucket খ-ও ঠিক না)

### `POST /teams/:id/missions` ও `PATCH /teams/:id/missions/:missionId`

দুটো route-ই শুধু "active team member" চেক করে (`team_members` lookup,
role যাই হোক), **leader-ই কিনা সেটা চেক করে না** — অথচ:

- `POST /teams/:id/missions`-এর নিজস্ব comment header-ে লেখা আছে
  "create mission **(leader only)**"।
- একই ফাইলের বাকি mission-lifecycle route-গুলো (`DELETE
  /teams/:id/missions/:missionId`, `POST
  /teams/:id/missions/:missionId/claim`) স্পষ্টভাবে `role !== "leader"`
  চেক করে।

তার মানে এখন **যেকোনো active member** একটা মিশন তৈরি করতে পারে এবং
(`PATCH`-এর মাধ্যমে) তার `reward_amount`, `target_value`,
`current_value`, `status` স্বাধীনভাবে বদলাতে পারে — শুধু claim করার
সময় leader-gate লাগে (`POST .../claim`-এ `role !== "leader"` আছে)।

**এটা cross-tenant leak না** (অন্য কোনো টিমের ডেটা টাচ হয় না) — শুধু
নিজের টিমের ভেতরেই ইনটেন্ডেড role-boundary-র সাথে code-এর mismatch।
`reward_amount` grep করে দেখা গেছে এই কোডবেসে `team_missions.reward_amount`
claim করার সময় কোনো credit/wallet grant trigger করে না (`POST
.../claim` শুধু `claimed=TRUE` সেট করে) — তাই আপাতত সরাসরি financial
exploit না, কিন্তু ডেটা-integrity ইস্যু (member নিজে মিশন বানিয়ে/বদলে
"completed" দেখাতে পারে, leader ভুলভাবে claim করতে পারে ভেবে যে সত্যিকার
target পূরণ হয়েছে)।

**কেন silently ফিক্স করা হলো না:** intent টা সত্যিকার অস্পষ্ট —
হতে পারে design deliberately member-দের mission propose/update করতে
দেয় (collaborative tracking), আর শুধু leader claim gate-টাই আসল
নিরাপত্তা boundary হিসেবে ইচ্ছাকৃত। অথবা এটা header comment-এর সাথেই
সামঞ্জস্যহীন একটা bug। C26/C34-এর মতো "নিঃসন্দেহে cross-tenant bypass"
এটা না, তাই owner-এর sign-off ছাড়া বদলানো ঠিক হবে না (C28/C29-এর
decision-gated precedent অনুসরণ)।

**সুপারিশ (D5/owner-decision-এর জন্য):** যদি leader-only intent সঠিক
হয়, দুটো route-এই `role !== "leader"` চেক যোগ করা — ঠিক
`DELETE`/`claim`-এর প্যাটার্ন কপি করে। যদি member-propose intended হয়,
তাহলে অন্তত `PATCH`-এ কোন ফিল্ড member বনাম leader বদলাতে পারবে সেটা
আলাদা করা ভালো (যেমন member `current_value`-তে প্রগ্রেস রিপোর্ট করতে
পারবে, কিন্তু `reward_amount`/`status=completed` শুধু leader)।

---

## Roadmap-এর প্রাথমিক অনুমানের সাথে তুলনা

Roadmap-এর automated heuristic অনুমান করেছিল `teams.ts`-এ ~২২টা
inline-role আর ~২৯টা membership-shape (দুটোই পুরো ২০৬-backlog জুড়ে,
শুধু এই ফাইলে না)। হাতে-verify করা সংখ্যা এই ফাইলে: ৪টা inline
platform-role, ৫১টা membership-shape (তার মধ্যে ৫টা ইতিমধ্যে C4-এ
`authorize()`-এ রুটেড)। পার্থক্যটা প্রত্যাশিত — heuristic-টা পুরো
backlog জুড়ে ছড়িয়ে একটা মোট অনুমান দিয়েছিল, ফাইল-বাই-ফাইল split না।

## এখনো যা বাকি
- ২টা ফ্ল্যাগড mission route — owner decision-এর অপেক্ষায় (D5 বা
  পরবর্তী কোনো ফেজে, উপরের সুপারিশ অনুযায়ী)।
- D6 (contingent): এই ফাইলের ৫টা খ.৪ route + `DELETE /teams/:id/members/:memberId`-এর
  compound shape — যথেষ্ট বড়/repeated প্যাটার্ন কিনা D1 শেষে
  পুনর্বিবেচনা করে `createGroupMembershipRule()` বানানোর সিদ্ধান্ত।
- D8: lint script-এ (১) inline platform-role detection branch এবং
  (২) inline `authorize()` কল (router মিডলওয়্যার আর্গুমেন্ট না) detect
  করার সাপোর্ট — দুটোই যোগ হলে এই ফাইলের ৫৫টা (৪ + ৫১) বেসলাইন থেকে
  বাদ পড়বে, শুধু ২টা ফ্ল্যাগড route বাকি থাকবে (যতক্ষণ না তাদের
  disposition ঠিক হয়)।
