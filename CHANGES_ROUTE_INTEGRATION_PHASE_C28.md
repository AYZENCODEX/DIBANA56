# Route Integration Roadmap — Season C, Phase C28: `content.ts` ownership gap — decision + implement

## এই ফেজের scope
C18 থেকে flagged, C26/C27-এর roadmap-এ "owner decision" হিসেবে gated
রাখা হয়েছিল — `content.ts`-এর চারটা route (`memory` create/delete,
`generated` create/delete) কোনো ownership check ছাড়াই ছিল।

## Design decision (owner sign-off পাওয়া গেছে)
প্রথমে schema চেক করে নিশ্চিত হওয়া হয়েছে যে `project_memory` আর
`generated_content` — দুটো টেবিলেরই কোনো `user_id` কলাম নেই (শুধু
`project_id`), আর `projects` টেবিলেরও কোনো owner column নেই — এটা একটা
shared platform catalog, per-user resource না (user-ownership আসে শুধু
`project_enrollments` junction টেবিল দিয়ে, প্রতিটা project-এ না)।
ফ্রন্টএন্ড (`pages/user/content.tsx`)-ও পুরো `/projects` লিস্ট থেকে
যেকোনো project বেছে memory/generated content read-write করে —
enrollment filter কখনোই ছিল না।

তাই "single-owner (`user_id` কলাম)" মডেল এখানে প্রযোজ্যই না (কলাম নেই)।
Owner-এর সিদ্ধান্ত: **admin-only write, সবার জন্য read** — community
generated/AI content browse করতে পারবে (GET route-গুলো অপরিবর্তিত,
`requireAuth`-এ থাকা যেকোনো authenticated user), কিন্তু শুধু admin/owner
memory entry বা generated content তৈরি/মুছতে পারবে।

## পরিবর্তন
`content.ts`-এর চারটা write route-এ `requireAuth` → `requireAdmin`:
- `POST /content/memory/:projectId`
- `DELETE /content/memory/:id`
- `POST /content/generate` (generated_content তৈরি করে; ক্রেডিট এখনও
  caller-এর নিজের balance থেকেই কাটে — শুধু কে কল করতে পারবে সেটা
  বদলেছে, ক্রেডিট লজিক না)
- `DELETE /content/generated/:id`

তিনটা GET route (`/content/memory/:projectId`,
`/content/generated/:projectId`, `/content/plan-limits`) অপরিবর্তিত
(`requireAuth`) — decision অনুযায়ী read সবার জন্য খোলা থাকার কথা।

আলাদা `contentResource`/resource-ownership engine বানানো হয়নি — কারণ
এই দুই টেবিলে কোনো `ownerId`/`user_id` column-ই নেই compare করার মতো;
এটা genuinely role-based decision (single-owner বা project-enrollment
resource না), তাই `requireAdmin` (যেটা ইতিমধ্যে
`lib/policy/pep/middleware.ts`-এর `requireRole()` PDP দিয়ে যায়,
`pepDecisionObserver`-এ audit হয় — C27-এর মতোই centrally observable,
আলাদা কিছু বানানোর দরকার নেই) সরাসরি reuse করা হয়েছে, যেভাবে
`categories.ts`/`broadcast.ts`/`ad-tasks.ts`-এর admin-write route
গুলো করে।

## Rollout
Behavior change আছে (আগের তিনটা phase-এর মতো pure audit-only না) —
আগে যেকোনো authenticated user memory/generated content create/delete
করতে পারত, এখন শুধু admin role পারবে। GET route তিনটা অপরিবর্তিত।
কোনো নতুন env var, migration লাগেনি — `requireAdmin` আগে থেকেই আছে
(`middlewares/auth.ts`)।

## যা টেস্ট করা হয়েছে
- `content.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  `{}` 84/84, `()` 135/135 — শূন্যে মেলে।
- `routes/index.ts`-এ `contentRouter` mount হয় কিনা grep করে নিশ্চিত
  করা হয়েছে (live traffic পায়)।
- `requireAuth`/`requireAdmin` দুটোই import-এ ব্যবহৃত হচ্ছে কিনা (unused
  import না) grep করে confirm করা হয়েছে — তিনটা GET-এ `requireAuth`,
  চারটা write route-এ `requireAdmin`।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে: `POST /content/generate`-এর
  credit-deduction লজিক (`req.user!.userId` দিয়ে balance check/spend)
  অপরিবর্তিত রাখা হয়েছে — শুধু middleware বদলেছে, handler body না।

## এখনো যা বাকি
`project-dates.ts`-এর `GET /projects/:id/dates` visibility decision
(C29) এখনো pending। `vault.ts` মূল CRUD (C30) আর peripheral sweep
(C31) এখনো শুরু হয়নি।
