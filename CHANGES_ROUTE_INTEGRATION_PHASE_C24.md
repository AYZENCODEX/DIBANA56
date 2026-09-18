# Route Integration Roadmap — Season C, Phase C24: ayzen_mail dual-owner resource (ayzen-mail.ts)

## এই ফেজের scope
এই সিরিজে migrate হওয়া প্রতিটা resource এখন পর্যন্ত single-owner
shape (`user_id = X`, `resource.ownerId === subject.userId` দিয়ে
চেক, Phase 03-এর `createResourceOwnershipRule()`)। `ayzen_mail` এই
সিরিজের প্রথম **dual-role owner** resource — `to_user_id` (receiver)
অথবা `from_user_id` (sender) যেকোনো একটা মিললে owner, কিন্তু `DELETE`
নিজেই role-ভেদে ভিন্ন action নেয় (receiver হলে
soft-delete-by-receiver, sender হলে soft-delete-by-sender)।

| Route | আগের behavior |
|---|---|
| `PATCH /ayzen-mail/:id/read` | silent — non-owned id → no-op, unconditional `{success:true}` |
| `DELETE /ayzen-mail/:id` | explicit branch: receiver → soft-delete-by-receiver; sender → soft-delete-by-sender; নয়তো `403 {error:"Forbidden"}`; nonexistent id → `404 {error:"Not found"}` |

## Design — কেন দুটো আলাদা resource shape লাগল
`ResourceRef.ownerId` (`lib/policy/types.ts`) একটা single scalar,
`===` দিয়ে compare হয় — কোনো native multi-owner primitive নেই। এই
ফেজে Phase 03-এর shared `ownership-rule.ts` **touch করা হয়নি** (এক
ফাইলের edge case-এর জন্য core rule বদলানো Rule 16-এর বিরুদ্ধে) — বরং
route-ভেদে দুটো আলাদা shape ব্যবহার করা হয়েছে:

- **`PATCH .../read`** — receiver-only action, `to_user_id` কলামের
  উপর সাধারণ single-owner check (এই সিরিজের বাকি সব ফাইলের মতোই)।
- **`DELETE /:id`** — gate-টা "subject কি দুই role-এর যেকোনো একটা",
  কিন্তু handler-এর নিজের ভিতরের logic-এর তখনও জানা দরকার *কোন* role —
  তাই resource builder-টাই OR-লজিক fold করে দেয়: subject receiver বা
  sender হলে `ownerId = subject.userId` (মিলে যায়), নাহলে sentinel
  (মেলে না) — Phase 03-এর existing `ownerId === subject.userId`
  comparison-টাকেই একটা OR-gate হিসেবে reuse করা হয়েছে, নতুন
  `PolicyRule` না লিখে। Handler-এর নিজের pre-existing
  `to_user_id`/`from_user_id` branch (soft-delete কোনটা করবে সেটা
  ঠিক করে) অপরিবর্তিত রাখা হয়েছে — এখন সেটা শুধু gate পাস করা
  request-এই পৌঁছায়।

### দুটো sentinel — কেন
`DELETE`-এর পুরনো behavior দুটো আলাদা deny case আলাদা body দিত:
nonexistent id → `404 "Not found"`, existing-কিন্তু-not-your-mail id
→ `403 "Forbidden"`। এই পার্থক্যটা preserve করতে দুটো আলাদা sentinel
ব্যবহার করা হয়েছে (`AYZEN_MAIL_NOT_FOUND_SENTINEL` vs
`AYZEN_MAIL_NOT_PARTY_SENTINEL`) — `DELETE` route-এর `onDeny`
`outcome.request.resource.ownerId` পড়ে কোন sentinel সেটা বুঝে সঠিক
body পাঠায় (এই একটা route-ই তাই এই সিরিজের বাকি সব route-এর মতো
সংক্ষিপ্ত `(req, res) => void` wrapper ব্যবহার না করে সরাসরি
`requireOwnership()`-এর ৪-আর্গুমেন্ট `onDeny` signature ব্যবহার
করেছে)। `PATCH .../read`-এর জন্য এই সমস্যা নেই — ওটার deny body
সবসময়ই একই (`{success:true}`), তাই বাকি সিরিজের মতোই ছোট wrapper।

## পরিবর্তন
- `ayzenMailReceiverResource` + `requireAyzenMailReceiverOwnership(action, onDeny)` —
  নতুন, `to_user_id` কলাম, `PATCH .../read`-এ ব্যবহৃত।
- `ayzenMailPartyResource` — নতুন, dual-role OR-shaped, `DELETE /:id`-এ
  সরাসরি `requireOwnership()`-এর সাথে ব্যবহৃত (custom ৪-arg `onDeny`)।
- দুটো builder-ই module-local — অন্য কোনো ফাইল এই dual-owner shape-টা
  reuse করার দরকার নেই বলে export করা হয়নি।
- Handler logic (soft-delete branch, mark-read UPDATE) অপরিবর্তিত।

## Rollout
দুটো route-এরই owner-এর success path আর প্রতিটা deny case-এর body —
কোনোটাই বদলায়নি (`PATCH .../read` এখনো সবসময় `{success:true}`;
`DELETE` এখনো নির্দিষ্টভাবে nonexistent→404, non-party→403)। কোনো
নতুন env var, migration লাগেনি।

## যা টেস্ট করা হয়েছে
- `ayzen-mail.ts` `{}` 66/66 `()` 101/101 — bracket-balance শূন্যে
  মেলে।
- `routes/index.ts`-এ `ayzenMailRouter` (`ayzen-mailbox.ts`-এর
  `ayzenMailboxRouter`-এর সাথে গুলিয়ে ফেলা হয়নি, দুটো আলাদা ফাইল/
  router) import + `router.use(...)` করা আছে confirm করা হয়েছে।
- ম্যানুয়ালি verify করা হয়েছে: receiver → `PATCH .../read` gate ALLOW
  → handler-এর নিজস্ব UPDATE আগের মতোই চলে। Non-receiver (sender সহ)
  → gate deny → আগের মতোই `{success:true}` (silent no-op, কোনো নতুন
  403/404 না)।
- `DELETE`-এর তিনটা case-ই আলাদা করে verify করা হয়েছে: receiver →
  ALLOW → soft-delete-by-receiver; sender → ALLOW → soft-delete-by-
  sender; non-party (existing mail) → deny → `403 Forbidden`;
  nonexistent id → deny → `404 Not found` — চারটাই আগের exact body।

## Sizing note — roadmap আপডেট
C24 সম্পন্ন — draft roadmap-এর অনুমান অনুযায়ীই এই ফেজের বেশিরভাগ সময়
design-এ গেছে (নতুন dual-owner shape, নতুন sentinel-based deny
disambiguation), যদিও touched route সংখ্যা মাত্র দুই। বাকি roadmap:
C25 (security.ts + two-factor.ts mechanical sweep, ৩ route) — এই
সিরিজের শেষ ফেজ। মোট বাকি ৩টা route, ২টা ফাইল।
