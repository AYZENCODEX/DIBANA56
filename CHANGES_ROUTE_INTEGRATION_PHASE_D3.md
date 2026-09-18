# Route Integration Roadmap — Season D, Phase D3: `projects.ts` + `tasks.ts` triage (৩৮ route) — ১টা বাগ ফিক্স

## Scope
`projects.ts` (২৪টা flagged param route, বেসলাইনে verify করা) +
`tasks.ts` (১৪টা) = ৩৮। Roadmap-এর sizing note ৩০টা অনুমান করেছিল;
আসল সংখ্যা ৩৮ (আবারও, D2-এর মতো, heuristic অনুমান বনাম হাতে-verify করা
বেসলাইনের পার্থক্য — প্রত্যাশিত)।

`projects.ts`-এর নিজস্ব C9 header comment (Season C, Phase 9) আগে থেকেই
এই ফাইলের routes-কে bucket-এ ভাগ করে রেখেছিল — এই ফেজে সেই দাবিগুলো
লাইন-বাই-লাইন কোড পড়ে কনফার্ম করা হয়েছে, আর একটা জায়গায় C9-এর নিজের
classification-এ **একটা বাস্তব বাগ** পাওয়া গেছে (নিচে দেখুন) — সেটা এই
ফেজেই ফিক্স হয়েছে, C26/C34-এর precedent অনুসরণ করে।

## ফলাফল সংক্ষেপে

| Bucket | `projects.ts` | `tasks.ts` | মোট |
|---|---|---|---|
| Inline platform-role middleware (`requireAdmin`/`requireRoles(...)` — `../middlewares/auth`, PEP_WIRING_NAMES-এর `requireRole`-এর থেকে ভিন্ন নাম) | ৫ | ৪ | ৯ |
| Public, unauthenticated by design | ৫ | ৪ | ৯ |
| Self-scoped (composite userId key বা own-row query, আলাদা resource-id নেই) | ৬ | ৩ | ৯ |
| Membership/owner-scoped raw-SQL (`WHERE ... user_id = ${userId}`) | ৭ | ০ | ৭ |
| ইতিমধ্যে inline `authorize()`-এ PDP-routed (Phase C1) | ০ | ৩ | ৩ |
| **বাগ পাওয়া গেছে, এই ফেজেই ফিক্স হয়েছে** | **১** | **০** | **১** |
| **মোট** | **২৪** | **১৪** | **৩৮** |

---

## 🐛 বাগ ফিক্স — `GET /projects/:id/members`

**সমস্যা:** এই route-এ কোনো auth middleware-ই ছিল না (`requireAuth`
পর্যন্ত না), অথচ response-এ প্রতিটা project-member-এর **email address**
সহ userId আর task-completion স্ট্যাটস ফেরত দিত। route-এর নিজস্ব comment
বলে "(admin view)" — আর ফ্রন্টএন্ডে এই endpoint-এর তিনটা ব্যবহারই
(`operator-progress.tsx`, `project-detail.tsx` — দুটোই `pages/admin/`-এর
নিচে) ইতিমধ্যে Bearer token পাঠায়, মানে ইনটেন্ডেড ছিল admin-only। কিন্তু
কোড-এ কোনো enforcement-ই ছিল না — যে কেউ, লগইন ছাড়াই, project id গুনে
গুনে (enumerate করে) প্রতিটা মেম্বারের ইমেইল হার্ভেস্ট করতে পারত।

এটা C9-এর নিজস্ব classification-কে ভুল প্রমাণ করে — C9 এটাকে "public,
unauthenticated" bucket-এ রেখেছিল (routes যেগুলো সত্যিই intentionally
public, যেমন `GET /projects/:id`/`GET /projects/:id/stats`), কিন্তু
email-সহ member list intentionally public হওয়ার কথা না — sibling admin
route (`GET /admin/projects/:id/entity-enrollments`) ঠিকই gated।

**ফিক্স:** sibling route-এর সাথে সামঞ্জস্যপূর্ণ করে
`requireRoles("admin", "moderator")` যোগ করা হলো — এতে বৈধ কোনো caller-এর
কিছু বদলায় না (তিনটা real caller-ই already authenticated admin page থেকে
Bearer token পাঠায়), শুধু অ্যানোনিমাস leak বন্ধ হলো।

```ts
router.get("/projects/:id/members", requireRoles("admin", "moderator"), async (req, res): Promise<void> => {
```

---

## `projects.ts` — বাকি ২৩টা (bug-fix বাদে)

**Bucket ক — platform-role middleware, ৫টা:** `PATCH /projects/:id`,
`DELETE /projects/:id` (`requireAdmin`), `PATCH
/projects/:id/enrollments/:enrollmentId/status`, `GET
/admin/projects/:id/entity-enrollments` (`requireRoles("admin",
"moderator")`), `DELETE /admin/projects/:id/ratings/:ratingId`
(`requireAdmin`)। `requireAdmin`/`requireRoles` — `../middlewares/auth`-এ
define করা, `lib/policy/pep/middleware`-এর `requireRole` থেকে আলাদা নাম,
তাই script-এর `PEP_WIRING_NAMES` miss করে (D1/D2-তে যেমন দেখা গিয়েছিল)।

**Bucket খ — public unauthenticated, ৫টা:** `GET /projects/:id`, `GET
/projects/:id/stats`, `GET /projects/:id/ratings`, `GET
/projects/pnl-receipt/:token`, `GET /projects/pnl-receipt/:token/pdf`।
কোনোটাতেই per-user sensitive ফিল্ড নেই (project-level aggregate, বা
receipt token-gated summary)।

**Bucket গ — self-scoped, ৬টা:** `GET /projects/:id/ratings/me`, `POST
/projects/:id/ratings`, `DELETE /projects/:id/ratings/me` (rating,
composite `(projectId, userId)`), `POST /projects/:id/pnl-receipt`,
`DELETE /projects/:id/pnl-receipt` (composite `(userId, projectId)` —
আলাদা resource-id নেই), `POST /projects/:id/join`।

**Bucket ঘ — membership/owner-scoped raw-SQL, ৭টা:** `GET
/projects/:id/enrolled-entities`, `GET /projects/:id/enrollments`, `GET
/projects/:id/enrollments/overview`, `GET /projects/:id/entity-tasks`,
`GET /projects/:id/roi-summary`, `GET /projects/entity/:vaultEntryId/overview`,
`POST /projects/:id/enroll` — সব ক'টাই query-তেই `user_id = ${userId}`
বেক করা (client কোনো অন্য userId পাস করতে পারে না)। `POST
/projects/:id/enroll`-এ `vaultEntryId`/`kycEntryId` দুটোই আগে থেকে
owner-scoped SELECT দিয়ে verify হয় insert-এর আগে।

*(`DELETE /projects/:id/enrollments/:enrollmentId` আর `GET
/projects/enrollments/:enrollmentId/activity` বেসলাইনে নেই — এই দুটো
ইতিমধ্যে C9-এই `requireProjectEnrollmentOwnership()` router-middleware
দিয়ে PDP-wired, script ঠিকই "wired" ধরে।)*

## `tasks.ts` — ১৪টা

**Bucket ক — platform-role middleware, ৪টা:** `DELETE /tasks/:id`,
`PATCH /tasks/:id`, `PUT /tasks/:id/steps` (`requireAdmin`), `POST
/tasks/:id/verify` (`requireAdmin`)।

**Bucket খ — public unauthenticated, ৪টা:** `GET /tasks/:id`, `GET
/tasks/:id/steps`, `GET /tasks/submissions/receipt/:token`, `GET
/tasks/submissions/receipt/:token/pdf`।

**Bucket গ — self-scoped, ৩টা:** `GET /tasks/:id/visit`, `POST
/tasks/:id/visit` (`task_link_visits`, PK `(task_id, user_id)`), `POST
/tasks/:id/submit` (submission সবসময় caller-এর নিজের `userId`-এ তৈরি
হয়; body-supplied `entityIds` কোথাও সরাসরি trust হয় না — শুধু
`logProjectReward()`-এর ভেতরে `project_enrollments WHERE project_id AND
user_id AND vault_entry_id IN (...)` দিয়ে আবার filter হয়, তাই একটা
non-owned/spoofed id থাকলে সেটা চুপচাপ বাদ পড়ে, C26/C34-এর "owner-prefilter,
silent-drop" প্যাটার্নেরই সমতুল্য — কোনো নতুন গ্যাপ না)।

**Bucket ঘ — ইতিমধ্যে inline `authorize()`-এ PDP-routed (Phase C1), ৩টা:**
`POST /tasks/submissions/:id/receipt`, `DELETE
/tasks/submissions/:id/receipt`, `POST
/tasks/submissions/:id/receipt/email` — সবক'টা `submissionOwnerOrAdminEngine`
(module-load-time PolicyEngine, `resource-ownership` + `role-override`
rule) শেয়ার করে, `support.ts`-এর C1 owner-OR-admin শেপের হুবহু কপি।

---

## এখনো যা বাকি
- D8: এই ফেজের ৯টা platform-role-middleware route (৫ + ৪) আর ৩টা
  inline-`authorize()` route lint script fix পেলে বেসলাইন থেকে বাদ
  পড়বে (D1/D2-এর অনুরূপ route-গুলোর সাথে combined)।
- Bug-fix-এর বাইরে কোনো owner-decision-pending item নেই এই ফেজে।
- D7 (contingent audit-trail sweep)-এর candidate তালিকায় এই ফেজের
  "membership/owner-scoped raw-SQL" ১৬টা রুট (projects ৭ + tasks ০,
  যদিও tasks-এ raw-SQL bucket নেই এখানে) যোগ হতে পারে D2-এর finance
  routes-এর সাথে।
