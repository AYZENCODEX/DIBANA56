# Route Integration Roadmap — Season C, Phase C12: Mechanical Sweep (batch 12, ayzen-mailbox.ts part 3 — message resource, folder-transition/send-lifecycle half)

## যা আগে থেকেই ছিল
Phase C11-এর বাকি অর্ধেক: একই mailbox message resource
(`ayzenMailboxMessagesTable`), কিন্তু folder বদলায় বা send-lifecycle
touch করে এমন verb-গুলো — প্রতিটাই client-supplied message `:id` নিয়ে
নিজের hand-rolled `and(eq(...id, id), eq(...userId, userId))` (কিছু
ক্ষেত্রে আলাদা folder-state check সহ) দিয়ে scope করত।

| Route | আগের 404/409 body |
|---|---|
| `PATCH /ayzen-email/mailbox/:id/reschedule` | ownership-miss: `{ error: "Message not found" }`; folder≠scheduled: `400`; race হারলে: `409 { error: "...", code: "UNDO_WINDOW_EXPIRED" }` |
| `PATCH /ayzen-email/mailbox/:id/cancel-schedule` | `{ error: "Message not found in Scheduled" }` — ownership + folder='scheduled' একই combined check |
| `PATCH /ayzen-email/mailbox/:id/undo-send` | ownership-miss: `{ error: "Message not found" }`; folder≠outbox: `400`; race হারলে: `409` |
| `PATCH /ayzen-email/mailbox/:id/move` | `{ error: "Message not found" }` |
| `PATCH /ayzen-email/mailbox/:id/mark-spam` | `{ error: "Message not found" }` |
| `PATCH /ayzen-email/mailbox/:id/not-spam` | `{ error: "Message not found in Spam" }` — ownership + folder='spam' একই combined check |
| `DELETE /ayzen-email/mailbox/:id` | `{ error: "Message not found" }` |
| `PATCH /ayzen-email/mailbox/drafts/:id` | `{ error: "Draft not found" }` — ownership + isDraft=true একই combined check |

## যেটা যোগ করা হলো (Phase C12)
Phase C11-এ যোগ হওয়া same `ayzenMailboxMessageResource`
`ResourceRefBuilder` আর `requireAyzenMailboxMessageOwnership(action,
notFoundError?)` helper — নতুন কিছু বানাতে হয়নি, শুধু আরও আটটা route-এ
wire করা হলো, প্রতিটার নিজস্ব `action` আর (যেখানে pre-existing body
generic "Message not found"-এর চেয়ে বেশি specific) override করা
`notFoundError` দিয়ে।

| Route | নতুন `action` | `notFoundError` override |
|---|---|---|
| `PATCH /:id/reschedule` | `ayzen_mailbox_message.reschedule` | — (default) |
| `PATCH /:id/cancel-schedule` | `ayzen_mailbox_message.cancel_schedule` | `"Message not found in Scheduled"` |
| `PATCH /:id/undo-send` | `ayzen_mailbox_message.undo_send` | — (default) |
| `PATCH /:id/move` | `ayzen_mailbox_message.move` | — (default) |
| `PATCH /:id/mark-spam` | `ayzen_mailbox_message.mark_spam` | — (default) |
| `PATCH /:id/not-spam` | `ayzen_mailbox_message.not_spam` | `"Message not found in Spam"` |
| `DELETE /:id` | `ayzen_mailbox_message.delete` | — (default) |
| `PATCH /drafts/:id` | `ayzen_mailbox_message.draft.update` | `"Draft not found"` |

### Folder-state check-গুলো handler-এই থেকে গেল
`reschedule`/`undo-send` উভয়ের নিজস্ব ownership-lookup **এবং** folder
check (400) দুটো ধাপে আলাদা ছিল আগেও — PEP gate শুধু প্রথম ধাপটা
(ownership) নেয়, দ্বিতীয় ধাপ (folder ≠ scheduled/outbox) আর তার পরের
race-guard (409, `UNDO_WINDOW_EXPIRED`) হুবহু handler-এই অপরিবর্তিত থাকে।
`cancel-schedule`/`not-spam`/drafts-এর ক্ষেত্রে ownership+state আগে থেকেই
এক query-তে combined ছিল — PEP gate শুধু ownership অংশটা আলাদা করে
সামনে নেয়, owner-but-wrong-state request গেট পার হয়ে handler-এর নিজের
(অপরিবর্তিত) query-তে গিয়ে ঠিক আগের মতোই ০ row পায় ও একই body দেয়;
non-owner request গেটেই আটকায়, `onDeny`-তে বসানো ঠিক সেই একই
route-specific body দিয়ে — কাজেই দুটো path-ই client-এর কাছে একই রকম
দেখায়, শুধু ownership-miss case এখন একটা real, audited
`AuthorizationDecision`-এর পেছনে।

## কেন বাকিগুলো এখনো বাদ
- **PATCH /mailbox/bulk** — array of ids; আলাদা bulk-ownership shape,
  Season C-র mechanical-sweep single-resource pattern-এ ফিট করে না।
- **GET /mailbox/thread/:threadId**, **PATCH
  /mailbox/thread/:threadId/quick-action** — threadId single-owner
  primary key না; C11-এর একই কারণে বাদ।
- **vault.ts/vault-attachments.ts/vault-snapshot.ts** — Season B-র Phase
  B2-এর জন্য ইচ্ছাকৃতভাবে সংরক্ষিত (আগের সব ফেজেই বলা হয়েছে)।
- **email-compose.ts** — নিজের `requireAuth` wiring-ই নেই (Phase
  C6/C9-এর polymarket.ts-এর মতো একই কারণ)।

## Resource lookup — client-supplied কিছু trust করা হয়নি
C11-এর same `ayzenMailboxMessageResource` পুনরায় ব্যবহার হলো — `:id`
দিয়ে সরাসরি DB থেকে real owner পড়ে, Phase B1/C1-C11-এর same
trust-boundary posture।

## এই ফেজে যা সরানো হয়নি
প্রতিটা route-এর existing folder-state check, race-guard transaction
(reschedule/cancel-schedule/undo-send-এর send-queue `UPDATE ... WHERE
status = 'pending'`), spam-report/clear-spam-flag side-effect, আর
DELETE-এর soft-delete-vs-hard-delete (trash কিনা তার উপর ভিত্তি করে)
লজিক — সব অপরিবর্তিত। GET/POST (list/create, drafts-create, send)
route-গুলো touch করা হয়নি।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। owner-এর existing success path
আটটা route-েই অপরিবর্তিত; non-owner/nonexistent/wrong-state id ঠিক আগে
যা রিটার্ন করত তাই এখনো করে — শুধু ownership-miss path-টা এখন একটা real,
audited `AuthorizationDecision`-এর পেছনে।

## যা টেস্ট করা হয়েছে
- `ayzen-mailbox.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  C11+C12 দুটো ফেজ মিলিয়ে `{}` 737/737, `()` 2179/2179, `[]` 144/144 —
  সব শূন্যে মেলে।
- প্রতিটা নতুন import আগে থেকেই ফাইলে বিদ্যমান কিনা যাচাই করা হয়েছে —
  নতুন কিছু যোগ করতে হয়নি (C11-এর same helper পুনর্ব্যবহার)।
- ম্যানুয়ালি verify করা হয়েছে প্রতিটা route-এ: owner → gate ALLOW →
  handler-এর নিজস্ব folder-state check ও race-guard আগের মতোই চলে।
  non-owner → gate abstain → default-deny → route-specific `onDeny` body
  (আটটা route-এর প্রতিটার body আলাদাভাবে মিলিয়ে দেখা হয়েছে, যাতে কোনোটা
  ভুল করে আরেকটার body না পায়)।
- `drafts/:id`-এ বিশেষভাবে verify করা হয়েছে যে middleware ordering ঠিক
  আছে — `requireAuth` → PEP gate (শুধু `:id` param পড়ে, body লাগে না) →
  `sendBodyParser` → handler — যেহেতু PEP gate route params থেকে কাজ
  করে, body-parser-এর আগে বসানো নিরাপদ, request body-র উপর কোনো নির্ভরতা
  নেই।

## এখনো যা বাকি
`ayzen-mailbox.ts`-এর message resource-এর মধ্যে এখনো বাদ: `PATCH
/mailbox/bulk` (array-of-ids, নিজের bulk-ownership pattern দরকার), `GET
/mailbox/thread/:threadId` + `PATCH
/mailbox/thread/:threadId/quick-action` (threadId single-owner PK না)।
এর বাইরে Season B-র Phase B2 (vault.ts family) আর email-compose.ts
আগের মতোই দাঁড়িয়ে আছে। এই তিনটা/চারটা shape একসাথে না জড়িয়ে প্রতিটার
নিজস্ব dedicated phase হিসেবে (bulk-ownership pattern, thread-scope
pattern আলাদাভাবে ডিজাইন করে) future phase-এর কাজ হিসেবে রাখা হলো —
ঠিক যেভাবে C9→C10→C11→C12 নিজেদের একেকটা distinct shape-এ ভাগ করেছে।
