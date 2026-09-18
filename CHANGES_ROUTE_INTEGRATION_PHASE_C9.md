# Route Integration Roadmap — Season C, Phase C9: Mechanical Sweep (batch 9, project enrollments)

## যা আগে থেকেই ছিল
Phase C7-এর "এখনো যা বাকি" তালিকার শেষ ফাইল — `routes/projects.ts`
(১১৪০+ লাইন)। ফাইলটা বড়, কিন্তু broader audit করে দেখা গেছে এই সিরিজের
pattern-এ (client-supplied `:id` যেটা handler নিজেই আগে
`and(eq(table.id, id), eq(table.userId, userId))` দিয়ে verify করে)
আসলে **মাত্র দুটো** route ফিট করে — বাকি সবগুলো হয় ইতিমধ্যে
`requireAdmin`/`requireRoles(...)` (Phase A2-এর shim থেকে আগে থেকেই
PDP-backed), অথবা list/create/self-scoped shape (composite `(userId,
projectId)` key, আলাদা কোনো resource-id ownership check নেই), অথবা
পুরোপুরি public route।

দুটো route-ই একই resource — project enrollment
(`projectEnrollmentsTable`) — scope করে, `:enrollmentId` param দিয়ে
(project-এর নিজের `:id` না):
- `DELETE /projects/:id/enrollments/:enrollmentId` — `and(eq(projectEnrollmentsTable.id,
  enrollmentId), eq(projectEnrollmentsTable.userId, userId))`, কিন্তু
  **কখনো 404 দেয় না** — non-owner/nonexistent enrollmentId-তেও সবসময়
  `{ message: "Enrollment removed" }` (silent no-op, ঠিক Phase C6-এর
  `notifications.ts`/Phase C7-এর `email-accounts.ts` DELETE-এর মতো)
- `GET /projects/enrollments/:enrollmentId/activity` — একই combined-where,
  miss হলে `404 { error: "Enrollment not found" }`

## যেটা যোগ করা হলো (Phase C9)
Phase B1/C1-C8-এর same pattern: একটা module-load-time `ResourceRefBuilder`
(DB থেকে real owner পড়ে, client-supplied কিছু trust করে না) + একটা
throwaway `requireOwnership()` middleware, shared `pepDecisionObserver`
দিয়ে wired। যেহেতু দুটো route-ই ভিন্ন response body-তে deny করে, helper-টা
`onDeny` একটা parameter হিসেবে নেয় (Phase C7-এর
`requireEmailAccountOwnership(action, notFoundBody)`-র মতোই একটা
parameterized shape, শুধু এখানে পুরো `onDeny` ফাংশনটাই parameter, কারণ
একটা route 404 দেয়ই না)।

| Route | নতুন `action` | `onDeny` response (অপরিবর্তিত) |
|---|---|---|
| `DELETE /projects/:id/enrollments/:enrollmentId` | `project_enrollment.delete` | `200 { message: "Enrollment removed" }` (আগে যা দিত তাই — কখনো 404 না) |
| `GET /projects/enrollments/:enrollmentId/activity` | `project_enrollment.activity.read` | `404 { error: "Enrollment not found" }` |

### Sentinel — same `-1` trick
`PROJECT_ENROLLMENT_OWNER_SENTINEL_NONE` — আগের সব ফেজের same posture।

## কেন বাকি সব `:id` route বাদ
- **আগে থেকেই PDP-backed**: `PATCH`/`DELETE /projects/:id`, `PATCH
  /projects/:id/enrollments/:enrollmentId/status`, `GET
  /admin/projects/:id/entity-enrollments`, `DELETE
  /admin/projects/:id/ratings/:ratingId` — সবই `requireAdmin`/
  `requireRoles(...)` দিয়ে গার্ড করা, যা Phase A2-এর shim থেকে ইতিমধ্যে PDP-র
  মধ্য দিয়ে যায়।
- **Self-scoped by construction**: `GET/POST/DELETE
  /projects/:id/ratings/me`, `POST`/`DELETE /projects/:id/pnl-receipt` —
  এগুলোর `:id` আসলে project-এর id, আর query নিজেই সবসময়
  `eq(...userId, userId)` বসায় (composite `(userId, projectId)` key) —
  আলাদা কোনো client-supplied resource-id নেই যেটার ownership আলাদাভাবে
  verify করতে হবে। Phase B1 থেকে এই সিরিজে list/create/self-scoped shape-এর
  জন্য same exclusion চলে আসছে।
- **Public, unauthenticated**: `GET /projects`, `GET /projects/:id`,
  `GET /projects/:id/members`, `GET /projects/:id/stats`, `GET
  /projects/:id/ratings`, `GET /projects/pnl-receipt/:token[/pdf]` —
  কোনো `requireAuth`-ই নেই।

## `ayzen-mailbox.ts` — এখনো ইচ্ছাকৃতভাবে বাইরে
Phase C7 নিজেই এটাকে "dedicated phase দরকার" বলে ফ্ল্যাগ করেছিল
(২০০০+ লাইন, folders/labels/templates/rules/messages — প্রতিটার নিজের
ownership shape)। এই ফেজে touch করা হয়নি — এটা Season C-র মেকানিক্যাল
ব্যাচের বাইরে, নিজের একটা আলাদা phase-এর candidate হিসেবেই থেকে গেল।

## Resource lookup — client-supplied কিছু trust করা হয়নি
`projectEnrollmentResource`-ও `:enrollmentId` দিয়ে সরাসরি DB থেকে real
owner পড়ে (`projectEnrollmentsTable.userId`) — আগের সব ফেজের same
trust-boundary posture।

## এই ফেজে যা সরানো হয়নি
`DELETE`-এর existing pre-delete activity-log lookup, তার নিজস্ব
`and(eq(...))` scoping, আর handler-এর ভেতরের বাকি সব side-effect —
অপরিবর্তিত। PEP gate এখন non-owner/nonexistent enrollmentId-কে handler-এ
ঢোকার আগেই আটকায়, কিন্তু response client-এর কাছে ঠিক আগের মতোই দেখায়
(handler আগেও একই id না মেলায় কোনো row touch করত না, activity log-ও
লিখত না — behavior অপরিবর্তিত)।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। owner-এর existing success path
দুটো route-েই অপরিবর্তিত; non-owner/nonexistent enrollmentId ঠিক আগে যা
রিটার্ন করত তাই এখনো করে (DELETE-এর `{ message: "Enrollment removed" }`
সহ) — শুধু এখন একটা real, audited `AuthorizationDecision` এর পেছনে।

## যা টেস্ট করা হয়েছে
- `projects.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  `{}` 383/383, `()` 1037/1037, `[]` 93/93 — সব শূন্যে মেলে।
- এই sandbox-এ `node_modules`/`tsc` install নেই, তাই আগের ফেজগুলোর মতোই
  standalone type-check চালানো যায়নি — প্রতিটা নতুন import
  (`requireOwnership`/`ResourceRefBuilder`/`pepDecisionObserver`/
  `requireAuth`/`requireAdmin`/`requireRoles`) সোর্স ফাইলে গিয়ে সরাসরি
  export হিসেবে বিদ্যমান কিনা grep করে যাচাই করা হয়েছে — Phase C8-এ যেখানে
  verify করা হয়েছিল ঠিক সেই একই export, নতুন কিছু না।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে: owner → gate ALLOW → handler
  logic অপরিবর্তিত চলে। non-owner/nonexistent enrollmentId → gate abstain
  → default-deny → `onDeny`-তে বসানো ঠিক pre-existing response
  (DELETE-এর ক্ষেত্রে 200/no-op, GET-এর ক্ষেত্রে 404) — দুটোই আলাদাভাবে
  verify করা হয়েছে যাতে ভুল করে একটা route আরেকটার body না পায়।
- Full `projects.ts` route তালিকা আবার grep করে নিশ্চিত করা হয়েছে যে এই
  দুটো ছাড়া বাকি কোনো `:id`-based route Season C-র mechanical-sweep শেপ
  (client-supplied id + hand-rolled combined-where ownership, কোনো
  admin gate ছাড়া) মেলে না।

## এখনো যা বাকি
`ayzen-mailbox.ts` — Season C-র শেষ বড় candidate, নিজের dedicated phase-এর
অপেক্ষায়। Broader grep-এ Phase C8-এ পাওয়া `vault.ts`/
`vault-attachments.ts`/`vault-snapshot.ts` (Season B-র Phase B2-এর জন্য
ইচ্ছাকৃতভাবে সংরক্ষিত) আর `email-compose.ts` (নিজের `requireAuth` wiring-ই
নেই, Phase C6-এর `polymarket.ts`-এর মতো) — কোনোটাই এখনো mechanical sweep-এ
touch করা হয়নি, একই কারণে যা আগের ফেজগুলোতে বলা হয়েছে।
