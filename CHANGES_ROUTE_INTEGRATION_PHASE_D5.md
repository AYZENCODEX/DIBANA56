# Route Integration Roadmap — Season D, Phase D5: owner-decision roundup (৪টা flagged route)

## Scope
D1-এর ২টা আর D4-এর ২টা flagged route — এই চারটাই একমাত্র জিনিস যা D1-D4-এর
পরেও কোনো immediate action ছাড়া বাকি ছিল (দুটো confirmed bug —
D3-এর email-leak আর D4-এর unauthenticated plugin-toggle — দুটোই
C26/C34-এর precedent অনুযায়ী নিজ নিজ ফেজেই সাথে সাথে ফিক্স হয়ে গিয়েছিল,
তাই এই ফেজে repeat করার কিছু নেই)। owner sign-off পাওয়ার পর তিনটাতেই কোড
বদলানো হয়েছে।

## সিদ্ধান্ত + ইমপ্লিমেন্টেশন

| Flag (ফেজ) | সিদ্ধান্ত | ফাইল |
|---|---|---|
| `POST /teams/:id/missions` + `PATCH /teams/:id/missions/:missionId` (D1) | Leader-only — header comment-এর সাথে মেলানো | `teams.ts` |
| `GET /projects/:id/presence` (D4) | `requireAuth` যোগ — login-gate, ownership না | `events.ts` |
| `GET /tools/streak/:userId` (D4) | `requireAuth` যোগ — login-gate, ownership না | `tools.ts` |

### ১. `teams.ts` — mission create/update এখন leader-only

`POST`/`PATCH` দুটোতেই `DELETE`/`claim`-এর ঠিক same shape যোগ করা হলো
(`SELECT role FROM team_members WHERE team_id = ... AND user_id = ... AND
status = 'active'`, তারপর `role !== "leader"` চেক, একই ৪০৩ error-shape)।
`GET /teams/:id/missions`(list) আর `GET /teams/:id/missions/:missionId`
(detail) অপরিবর্তিত থাকলো — যেকোনো active member এখনো মিশন দেখতে পারে,
শুধু তৈরি/এডিট করতে পারবে না। এখন চারটা mission-lifecycle route-ই
(create/update/delete/claim) একই leader-gate শেয়ার করে, header comment-এর
সাথে code সামঞ্জস্যপূর্ণ।

**Behavior change:** member (non-leader) এখন থেকে `POST`/`PATCH
/teams/:id/missions...`-এ ৪০৩ পাবে যেখানে আগে সফল হতো। এটা ইচ্ছাকৃত —
owner এই সিদ্ধান্তই নিয়েছেন।

### ২. `events.ts` — `GET /projects/:id/presence` এখন login-gated

এই ফাইলের নিজস্ব SSE endpoint (`GET /events`)-এর same token-resolver
(`getUserIdFromReq()` — Authorization header বা `?token=` query param,
দুটোই `getUserFromToken()`-দিয়ে verify করা) reuse করা হলো, `requireAuth`
মিডলওয়্যার না বসিয়ে — কারণ এই ফাইলে অলরেডি এই pattern established, আর
presence route-এর ownership-shaped middleware দরকার নেই, শুধু
"logged-in" চেক। কোনো ownership-check যোগ হয়নি — যেকোনো authenticated
user এখনো যেকোনো project-এর presence দেখতে পারে (আগের মতোই), শুধু
অ্যানোনিমাস অ্যাক্সেস বন্ধ হলো।

### ৩. `tools.ts` — `GET /tools/streak/:userId` এখন login-gated

`middlewares/auth.ts`-এর `requireAuth` import করে যোগ করা হলো — এই
কোডবেসের bucket-খ.২ pattern-এর সাথে সামঞ্জস্যপূর্ণ (`marketplace-spot.ts`,
`layout.ts`-এর মতো "logged-in-required, ownership না")। কোনো ownership-
check যোগ হয়নি — যেকোনো authenticated user এখনো অন্য যেকোনো user-এর
streak দেখতে পারে (আগের মতোই), শুধু অ্যানোনিমাস অ্যাক্সেস বন্ধ হলো।

## যাচাই
- তিনটা edited ফাইলই (`teams.ts`, `events.ts`, `tools.ts`) TypeScript
  parser দিয়ে syntax-check করা হয়েছে (০ parse error)।
- `scripts/src/check-ownership-gate-coverage.ts` আবার চালানো হয়েছে —
  বেসলাইন অপরিবর্তিত (৩৪০), যা প্রত্যাশিত: তিনটা ফিক্সই handler-body-এর
  ভেতরের inline check (D1/D3/D4-এর bucket-ক প্যাটার্নের মতোই), router-
  level middleware আর্গুমেন্ট না — script-এর `PEP_WIRING_NAMES` কখনোই
  এভাবে গণনা করে না, D1-D4-এর কোনো bucket-ক ফাইলেই করেনি।
- কোনো বিদ্যমান টেস্ট এই তিনটা route রেফারেন্স করে না (রিপোতে
  `__tests__`/`tests` ডিরেক্টরিতে খোঁজ করে কনফার্ম করা হয়েছে) — কোনো টেস্ট
  আপডেট করার দরকার হয়নি।

## Season D — সম্পূর্ণ close-out সারাংশ

| আইটেম | সংখ্যা |
|---|---|
| Triage করা route (D1-D4) | ৩৪০ |
| Confirmed বাগ, ফিক্স হয়েছে | ২ (D3: email leak; D4: unauthenticated plugin toggle) |
| Flagged, owner-decision-এ resolve হয়েছে (D5) | ৪ (২টা leader-gate যোগ, ২টা login-gate যোগ) |
| কোনো action ছাড়া নিরাপদ হিসেবে confirm হয়েছে | ৩৩৪ |

Season D-এর মূল triage কাজ (D1-D5) সম্পূর্ণ। বাকি D6 (contingent —
`createGroupMembershipRule()`, `teams.ts`-এর ৫১-route membership-shape
নিয়ে), D7 (contingent — audit-trail sweep), আর D8 (lint script fix +
baseline close-out) — তিনটাই এখন D1-D5-এর সম্পূর্ণ findings নিয়ে size
করার জন্য প্রস্তুত, যদি owner এগোতে চান।
