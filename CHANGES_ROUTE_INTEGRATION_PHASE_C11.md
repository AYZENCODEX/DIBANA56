# Route Integration Roadmap — Season C, Phase C11: Mechanical Sweep (batch 11, ayzen-mailbox.ts part 2 — message resource, read/tag half)

## যা আগে থেকেই ছিল
Phase C10 নিজেই ফ্ল্যাগ করে গিয়েছিল: `routes/ayzen-mailbox.ts`-এর সবচেয়ে
বড় resource — mailbox message নিজে (`ayzenMailboxMessagesTable`) — ২০+
verb নিয়ে গঠিত, এক ব্যাচে গুঁজে দেওয়া তাড়াহুড়ো হতো। এই ফেজ সেই resource-এর
প্রথম অর্ধেক নেয়: read/tag-জাতীয় route-গুলো, যার প্রতিটাই client-supplied
message `:id` নিয়ে নিজের `and(eq(ayzenMailboxMessagesTable.id, id),
eq(ayzenMailboxMessagesTable.userId, userId))` দিয়ে scope করত।

| Route | আগের 404 body |
|---|---|
| `GET /ayzen-email/mailbox/:id` | `{ error: "Message not found" }` |
| `GET /ayzen-email/mailbox/:id/attachments/download-all` | `{ error: "Message not found" }` (এবং non-numeric id-তে `400 { error: "Invalid id" }`) |
| `GET /ayzen-email/mailbox/:id/attachments/:attachmentId` | `{ error: "Message not found" }` (এবং non-numeric `id`-তে `400 { error: "Invalid id" }`) |
| `PATCH /ayzen-email/mailbox/:id/labels` | `{ error: "Message not found" }` — এটাই Phase C10-এর সেই route যা "Labels" সেকশনে বসে থাকলেও আসলে message-resource scope বলে তখন বাদ দেওয়া হয়েছিল |
| `PATCH /ayzen-email/mailbox/:id/star` | `{ error: "Message not found" }` |
| `PATCH /ayzen-email/mailbox/:id/read` | `{ error: "Message not found" }` |
| `PATCH /ayzen-email/mailbox/:id/snooze` | `{ error: "Message not found" }` (ownership check আলাদা, তারপর folder≠inbox হলে আলাদা `400`) |
| `PATCH /ayzen-email/mailbox/:id/unsnooze` | `{ error: "Message not found in Snoozed" }` — ownership + folder='snoozed' একই query-তে combined |

## যেটা যোগ করা হলো (Phase C11)
একটাই নতুন module-load-time `ResourceRefBuilder` —
`ayzenMailboxMessageResource` (DB থেকে `ayzenMailboxMessagesTable.userId`
পড়ে real owner বের করে) — যেটা C11 আর C12 দুটো ফেজই শেয়ার করবে, কারণ
দুটোই আসলে একই resource type-এর ভিন্ন verb মাত্র। সাথে একটা parameterized
`requireAyzenMailboxMessageOwnership(action, notFoundError?)` helper —
বেশিরভাগ route-এর pre-existing 404 body হুবহু `{ error: "Message not
found" }`, তাই সেটাই default; `/:id/unsnooze`-এর মতো যে ২-১টা route
আলাদা, নির্দিষ্ট body দেয়, সেগুলোর জন্য দ্বিতীয় parameter দিয়ে override করা
যায়।

| Route | নতুন `action` |
|---|---|
| `GET /ayzen-email/mailbox/:id` | `ayzen_mailbox_message.read` |
| `GET /ayzen-email/mailbox/:id/attachments/download-all` | `ayzen_mailbox_message.attachments.download_all` |
| `GET /ayzen-email/mailbox/:id/attachments/:attachmentId` | `ayzen_mailbox_message.attachments.read` |
| `PATCH /ayzen-email/mailbox/:id/labels` | `ayzen_mailbox_message.labels.update` |
| `PATCH /ayzen-email/mailbox/:id/star` | `ayzen_mailbox_message.star.update` |
| `PATCH /ayzen-email/mailbox/:id/read` | `ayzen_mailbox_message.read_state.update` |
| `PATCH /ayzen-email/mailbox/:id/snooze` | `ayzen_mailbox_message.snooze` |
| `PATCH /ayzen-email/mailbox/:id/unsnooze` | `ayzen_mailbox_message.unsnooze` |

### `Invalid id` vs `Message not found` — একটা আলাদা variant দরকার হলো
`GET /:id/attachments/download-all` আর `GET /:id/attachments/:attachmentId`
— এই দুটো handler নিজেরাই আগে থেকে `Number.isFinite(id)` চেক করে
non-numeric id-কে `400 { error: "Invalid id" }` দিত, ownership lookup-এ
পৌঁছানোরও আগে। সাধারণ `onDeny` non-finite id-কেও একই owner-sentinel দিয়ে
"না পাওয়া" হিসেবে treat করে, ফলে সরাসরি বসালে non-numeric id 400-এর বদলে
404 পেত — এটা আসল behavior change হতো। তাই এই দুটো route-এর জন্য আলাদা
`requireAyzenMailboxMessageOwnershipStrictId(action)` লেখা হলো, যার
`onDeny` নিজেই আবার `Number.isFinite` চেক করে দুটো body-র মধ্যে ঠিক
আগের মতোই পার্থক্য করে।

### Sentinel — same `-1` trick
`AYZEN_MAILBOX_MESSAGE_OWNER_SENTINEL_NONE` — আগের সব ফেজের same posture।

## কেন বাকিগুলো এই ব্যাচে না
- **PATCH /mailbox/bulk** — একটা array of ids নেয়, single resource ref না;
  এই ফেজের shape-এ ফিট করে না, নিজের আলাদা bulk-ownership pattern দরকার।
- **GET /mailbox/thread/:threadId**, **PATCH
  /mailbox/thread/:threadId/quick-action** — `threadId` একটা single-row
  primary key না যার একটাই owner column আছে; query নিজেই সরাসরি
  `eq(userId, userId)` বসায়, আলাদা lookup-then-compare shape না। এই
  সিরিজের বাকি সব ফেজের মতোই ভিন্ন shape বলে বাদ।
- **Reschedule/cancel-schedule/undo-send/move/mark-spam/not-spam/delete/
  drafts** — একই resource, কিন্তু Phase C12-এর জন্য রাখা হলো (batch size
  ছোট রাখার জন্য, আগের সব ফেজের কনভেনশন অনুযায়ী)।

## Resource lookup — client-supplied কিছু trust করা হয়নি
`ayzenMailboxMessageResource` `:id` দিয়ে সরাসরি DB থেকে real owner পড়ে —
Phase B1/C1-C10-এর same trust-boundary posture।

## এই ফেজে যা সরানো হয়নি
প্রতিটা route-এর existing hand-rolled scoping/side-effect (mark-read on
open, snooze-এর folder guard, label diff logic, ইত্যাদি) অপরিবর্তিত। PEP
gate ALLOW দিলে handler নিজের select-then-verify আগের মতোই আবার চালায় —
Phase B1/C1-এর "PEP additive, handler-এর নিজস্ব logic touch করে না"
নীতি অপরিবর্তিত।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। owner-এর existing success path
আটটা route-েই অপরিবর্তিত; non-owner/nonexistent id বা invalid id ঠিক
আগে যা রিটার্ন করত তাই এখনো করে — শুধু এখন owner/nonexistent-id path-টা
একটা real, audited `AuthorizationDecision`-এর পেছনে।

## যা টেস্ট করা হয়েছে
- `ayzen-mailbox.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  `{}`/`()`/`[]` তিনটাই শূন্যে মেলে (আগের ফেজগুলোর মতোই)।
- প্রতিটা নতুন import (`requireOwnership`/`ResourceRefBuilder`/
  `pepDecisionObserver`) আগে থেকেই ফাইলে import করা আছে কিনা যাচাই করা
  হয়েছে — নতুন কোনো import যোগ করতে হয়নি।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner → gate
  ALLOW → handler logic অপরিবর্তিত চলে। non-owner/nonexistent id → gate
  abstain → default-deny → `onDeny`-তে বসানো ঠিক pre-existing body।
- `download-all`/`attachments/:attachmentId`-এ বিশেষভাবে verify করা
  হয়েছে: non-numeric `id` → এখনো `400 { error: "Invalid id" }` (strict-id
  variant দিয়ে), owned-but-nonexistent numeric id → `404 { error:
  "Message not found" }`, non-owner numeric id → একই `404`।
- `unsnooze`-এ verify করা হয়েছে যে non-owner আর owner-but-wrong-folder
  দুটোই ঠিক আগের মতোই `{ error: "Message not found in Snoozed" }` দেয়।

## এখনো যা বাকি
Phase C12 — এই একই resource-এর বাকি অর্ধেক: reschedule, cancel-schedule,
undo-send, move, mark-spam, not-spam, delete, drafts/:id। এছাড়া bulk আর
thread route দুটো, future dedicated phase-এর candidate হিসেবে থেকে গেল।
