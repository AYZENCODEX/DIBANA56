# Route Integration Roadmap — Season C, Phase C13: Mechanical Sweep (batch 13, ayzen-mailbox.ts part 4 — PATCH /mailbox/bulk via authorizeMany())

## যা আগে থেকেই ছিল
`PATCH /ayzen-email/mailbox/bulk` — C11 আর C12 দুটো ফেজই এটাকে explicitly
বাদ রেখেছিল একই কারণে: এটা একটা array of ids নেয় (`body.ids: number[]`),
single resource ref না, তাই `requireOwnership()` — যেটা এক request-এ
ঠিক একটাই WHO/WHAT/WHICH প্রশ্নের জন্য বানানো — এখানে ফিট করে না।

আগের ownership check ছিল সরাসরি একটা DB query-তে বসানো:
`inArray(id, requestedIds) AND eq(userId, userId)` — non-owner/nonexistent
id-গুলো নীরবে `owned`/`ids`-এর বাইরে থেকে যেত, PDP-র কোনো ধারণাই ছিল না
এই filtering-এর ব্যাপারে।

## যেটা যোগ করা হলো (Phase C13)
Policy & Authorization Mega Engine-এর Phase 20-এই ঠিক এই shape-এর জন্য
`authorizeMany()`/`allowedKeys()` বানানো হয়েছিল
(`lib/policy/pep/authorize-many.ts`-এর নিজের header অনুযায়ী — "marketplace
lists, projects, organization members, vault resources, admin dashboards")
কিন্তু কোনো route কখনো এটা আসলে call করেনি। এই ফেজ সেই টুলের প্রথম real
caller।

- মডিউল-লোড-টাইমে একটা নতুন `ayzenMailboxBulkOwnershipEngine`
  (`PolicyEngine` + `createResourceOwnershipRule()`) — ঠিক C11/C12-এর
  single-item engine-এর same rule, শুধু batch-এর জন্য module-level এ
  বানানো, এই ফাইলের বাকি সব route-এর `requireOwnership()`-এর ভেতরে যেটা
  ব্যবহার হয় সেই একই `resource-ownership` rule — এই কোডবেসের অন্য
  bulk/list route-গুলোতে (tasks.ts, teams.ts, support.ts,
  marketplace-*.ts) module-level engine বানানোর যে কনভেনশন আছে, সেটাই
  অনুসরণ করা হলো।
- Ownership lookup query এখন **`userId` দিয়ে filter করে না** — শুধু
  requested ids-এ scope করে, প্রতিটা candidate row-এর real owner (`row.userId`)
  পড়ে আনে। এটাই এই সিরিজের বাকি সব single-id route-এর same
  trust-boundary posture, এখন batch-এ প্রয়োগ করা হলো।
- প্রতিটা candidate row-কে `authorizeMany()`-এর একটা item বানানো হলো
  (`{ key: row.id, resource: { type: "ayzen_mailbox_message", id: row.id,
  ownerId: row.userId } }`), action `ayzen_mailbox_message.bulk.${action}`
  (মানে `bulk.trash`, `bulk.delete`, `bulk.addLabel` ইত্যাদি — bulk-এ যে
  verb client পাঠিয়েছে সেটাই action-এর অংশ, এই সিরিজের বাকি সব route-এর
  "প্রতিটা verb নিজের decision-reason code পায়" নীতির সাথে সামঞ্জস্যপূর্ণ)।
- `allowedKeys(outcome)` থেকে পাওয়া id-গুলো দিয়ে candidates ফিল্টার করে
  আগের মতোই `owned`/`ids` বানানো হলো — **ফলাফল identical**: nonexistent
  id বা অন্য কারো id আগেও silently বাদ পড়ত, এখনো ঠিক তাই পড়ে, শুধু এখন
  সেই বাদ-পড়াটা একটা real, audited `AuthorizationDecision`-এর (প্রতি id-এ
  একটা করে) পেছনে, একটাই shared Subject/PolicyContext resolution দিয়ে
  (batch-এর জন্য N+1 এড়াতে — `authorizeMany()`-এর নিজের কাজ)।

## এই ফেজে যা সরানো হয়নি
সব ১৪টা bulk action-এর নিজস্ব business logic (delete-এর trash/permanent
two-stage split, spam/notSpam-এর per-sender dedup, addLabel/removeLabel-এর
already-labeled skip, move-এর `resolveMoveTarget`, snooze-এর
`until` validation) — সব হুবহু অপরিবর্তিত, শুধু `owned`/`ids` কীভাবে বসানো
হয় সেই একটা অংশই বদলেছে। Action validation (`BULK_ACTIONS.includes`) আর
id-validation (non-empty, finite) ঠিক আগে যেখানে ছিল সেখানেই, ownership
check-এরও আগে — same order।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। owner-এর existing success path
অপরিবর্তিত; non-owner/nonexistent id-ওয়ালা request-এ response ঠিক আগের
মতোই (সেই id silently বাদ পড়ে, বাকি ids-এর জন্য batch এগিয়ে যায়, পুরো
selection non-owned হলে `{ ok: true, affected: 0 }`) — শুধু এখন
`authorizeMany()`-এর প্রথম real ব্যবহার এটা।

## যা টেস্ট করা হয়েছে
- `ayzen-mailbox.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  `{}` 746/746, `()` 2205/2205, `[]` 144/144 — সব শূন্যে মেলে।
- প্রতিটা নতুন import (`authorizeMany`/`allowedKeys` from
  `lib/policy/pep`'s barrel, `PolicyEngine` from `lib/policy/policy-engine`,
  `createResourceOwnershipRule` from `lib/policy/resource`'s barrel,
  `ResourceRef` from `lib/policy/types`) সোর্স ফাইলে গিয়ে সরাসরি export
  হিসেবে বিদ্যমান কিনা এবং path resolve করে কিনা, দুটোই grep + file-existence
  দিয়ে যাচাই করা হয়েছে — কোনো নতুন dependency যোগ করতে হয়নি, সবই
  আগে থেকে codebase-এ আছে এমন module।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে: owner-এর id → item resolve
  হয় `ownerId === subject.userId` দিয়ে → rule ALLOW করে → `allowedKeys`-এ
  থাকে → আগের `owned`/`ids` build-এর same set। Non-owner/nonexistent id
  → candidates query-তে হয় আসেই না (nonexistent), অথবা আসে কিন্তু
  `ownerId !== subject.userId` (non-owner) → rule abstain → default-deny
  → `allowedKeys`-এ নেই → same silent-drop।
- Import path-গুলো actual filesystem-এ resolve করে কিনা সরাসরি চেক করা
  হয়েছে (`lib/policy/types.ts`, `lib/policy/policy-engine.ts`,
  `lib/policy/resource/index.ts` সবই বিদ্যমান)।

## এখনো যা বাকি
`GET /mailbox/thread/:threadId` + `PATCH
/mailbox/thread/:threadId/quick-action` — threadId একটা single-row
primary key না যার একটা owner column আছে (এক thread-এ একাধিক row,
প্রতিটার নিজের owner হতে পারে না যেহেতু query নিজেই `eq(userId, userId)`
বসায় প্রথমেই), তাই এটা `authorizeMany()`-এর batch-of-single-owner shape-এও
সরাসরি ফিট করে না — নিজের একটা আলাদা, dedicated pattern দরকার। Season
B-র Phase B2-এর জন্য সংরক্ষিত `vault.ts` family, আর নিজের `requireAuth`
wiring-হীন `email-compose.ts` — আগের সব ফেজের মতোই একই কারণে বাইরে।
এই তিনটা/চারটা shape-ই Season C-র সম্ভাব্য পরবর্তী phase-গুলোর candidate
হিসেবে থেকে গেল।
