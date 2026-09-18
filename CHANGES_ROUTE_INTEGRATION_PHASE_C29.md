# Route Integration Roadmap — Season C, Phase C29: `project-dates.ts`-এর `GET /projects/:id/dates` visibility decision + implement

## এই ফেজের scope
C25 থেকে flagged, C26-C28-এর roadmap-এ "owner decision" হিসেবে gated
রাখা হয়েছিল — `project-dates.ts`-এর `GET /projects/:id/dates` কোনো
`project_enrollments` check ছাড়াই `projectId` দিয়ে সরাসরি সব date ফেরত
দেয়, যেখানে একই ফাইলের `GET /project-dates?mine=true` ইতিমধ্যে
enrollment দিয়ে filter করে।

## Design decision (owner sign-off পাওয়া গেছে)
প্রথমে দুটো route-ই আর তাদের caller ভালোভাবে পড়া হয়েছে:

- `GET /project-dates` (query param ছাড়া, ডিফল্ট) — `mine` না দিলে
  `projectIdFilter` কখনো set হয় না, মানে **যেকোনো authenticated user
  ইতিমধ্যেই সব project-এর সব date একসাথে দেখতে পারে** — `mine=true`
  আসলে "আমার calendar" convenience filter, access boundary না।
- `GET /projects/:id/dates`-এর একমাত্র frontend caller
  `ProjectDatesManager` কম্পোনেন্ট (`components/
  project-dates-manager.tsx`), যা কেবল `pages/admin/project-detail.tsx`-এ
  mount হয় — কিন্তু সেটা UI-লেভেল admin-only পেজ হওয়ার কারণ, route-টাকে
  নিজে থেকে admin-scoped বানায় না।
- কোনো user-facing page (`pages/user/project-detail.tsx`,
  `project-dashboard.tsx`) এই endpoint সরাসরি কল করে না — user-facing
  calendar (`pages/user/airdrop-calendar.tsx`) `/project-dates` (উপরের
  aggregate endpoint) ব্যবহার করে, `mine` filter দিয়ে বা ছাড়া।

এই দুটো পয়েন্ট একসাথে মিলিয়ে দেখায়: `project_dates` টেবিলের row
(token snapshot/TGE/claim deadline) কখনোই enrollment-private data
হিসেবে ট্রিট করা হয়নি — এটা airdrop calendar-এর জন্য ইচ্ছাকৃতভাবে
public তথ্য, যেভাবে `/project-dates` aggregate endpoint আগে থেকেই
প্রমাণ করছে। তাই owner-এর সিদ্ধান্ত: **intentional, কোনো enrollment
gate লাগবে না** — `GET /projects/:id/dates` যেভাবে আছে সেভাবেই থাকবে
(`requireAuth`: কোনো signed-in user, enrollment check ছাড়া)।

## পরিবর্তন
কোনো behavior/SQL change নেই। `project-dates.ts`-এ `GET
/projects/:id/dates` route-এর ঠিক উপরে একটা comment যোগ করা হয়েছে যা
এই decision আর তার পেছনের evidence (aggregate endpoint-এর default
behavior, একমাত্র frontend caller admin-only হলেও সেটা route-কে
scope করে না) documented রাখে — ঠিক যেভাবে C28 তার own decision
`content.ts`-এ inline comment দিয়ে রেখেছিল।

## Rollout
কোনো behavior change নেই (pure documentation phase, C28-এর অর্ধেকের
মতো — কিন্তু এখানে কোনো middleware/route বদলায়নি, কারণ decision নিজেই
ছিল "যা আছে তাই ঠিক")। কোনো নতুন env var, migration, বা middleware
বদল লাগেনি।

## যা টেস্ট করা হয়েছে
- `project-dates.ts`-এ bracket/brace/paren balance script চালানো
  হয়েছে — কমেন্ট-only এডিট, কোড লজিক অপরিবর্তিত থাকা নিশ্চিত করার জন্য।
- `GET /project-dates` (mine বাদে) হ্যান্ডলার লাইন-বাই-লাইন পড়ে
  নিশ্চিত করা হয়েছে যে `projectIdFilter` `null` থাকলে `inArray(...)`
  clause `undefined` হয়ে যায় (Drizzle-এ `and()`-এর ভেতর `undefined`
  বাদ পড়ে) — মানে সত্যিই কোনো filter apply হয় না, ধারণাটা assumption
  না বরং code-এ ভেরিফাই করা।
- `grep -rn "projects/.*dates\|/dates\b"` দিয়ে frontend-এ
  `GET /projects/:id/dates`-এর একমাত্র caller (`ProjectDatesManager`
  → `pages/admin/project-detail.tsx`) আর `/project-dates`-এর caller
  (`pages/user/airdrop-calendar.tsx`) আলাদা করে শনাক্ত করা হয়েছে।
- `routes/index.ts`-এ `projectDatesRouter` (বা সমতুল্য নাম) mount হয়
  কিনা grep করে নিশ্চিত করা হয়েছে (live traffic পায়, unaffected)।

## এখনো যা বাকি
`vault.ts` মূল CRUD (C30) আর peripheral sweep (C31) এখনো শুরু হয়নি।
C28/C29 দুটো decision-gated ফেজই এখন close — বাকি সিরিজ (C30-C35)
কোনো owner-decision-এর উপর নির্ভর করে না।
