# Route Integration Roadmap — Season C, Phase C10: Mechanical Sweep (batch 10, ayzen-mailbox.ts part 1 — folders/labels/templates/rules)

## যা আগে থেকেই ছিল
`routes/ayzen-mailbox.ts` — Phase C7 নিজেই এটাকে "২০০০+ লাইন, একাধিক
resource type, একটা dedicated phase দরকার" বলে ফ্ল্যাগ করে বাইরে রেখেছিল,
আর Phase C9-এও touch করা হয়নি। ফাইলটা আসলে বেশ কয়েকটা স্বাধীন resource
নিয়ে গঠিত: folders, labels, templates, rules (প্রতিটাই ছোট,
settings-জাতীয়, single-table), আর তার পাশে অনেক বড় ও কেন্দ্রীয় একটা
resource — mailbox message নিজেই (thread, search, analytics, contacts,
senders, sending-health, আর message-level ২০+ action যেমন star/read/
snooze/reschedule/undo-send/move/mark-spam/bulk/delete/drafts/send)।

এই ফেজে পুরো ফাইল একসাথে না নিয়ে প্রথম চারটা ছোট resource-এ scope করা
হলো — folders, labels, templates, rules — প্রতিটার `PATCH`/`DELETE
/.../:id` route নিজের `and(eq(table.id, id), eq(table.userId, userId))`
দিয়ে scope করে, সবগুলোই একই `404 { error: "<Thing> not found" }` shape
দেয়:

| Table | Route | 404 body |
|---|---|---|
| `ayzenMailboxFoldersTable` | `PATCH`/`DELETE /ayzen-email/mailbox/folders/:id` | `{ error: "Folder not found" }` |
| `ayzenMailboxLabelsTable` | `PATCH`/`DELETE /ayzen-email/mailbox/labels/:id` | `{ error: "Label not found" }` |
| `ayzenMailboxTemplatesTable` | `PATCH`/`DELETE /ayzen-email/mailbox/templates/:id` | `{ error: "Template not found" }` |
| `ayzenMailboxRulesTable` | `PATCH`/`DELETE /ayzen-email/mailbox/rules/:id` | `{ error: "Rule not found" }` |

(`DELETE /folders/:id` does a select-then-verify-then-delete instead of a
single combined-where delete, but the net effect — 404 on non-owner/
nonexistent id — is identical to the other three.)

## যেটা যোগ করা হলো (Phase C10)
Phase B1/C1-C9-এর same pattern: চারটা module-load-time `ResourceRefBuilder`
(প্রতিটা resource type-এর জন্য একটা, DB থেকে real owner পড়ে) + shared
`pepDecisionObserver` দিয়ে wired `requireOwnership()`।

যেহেতু চারটা resource-ই একই 404 shape (`{ error: "<Thing> not found" }`)
শেয়ার করে, প্রতিটার জন্য আলাদা `requireXOwnership()` wrapper না লিখে একটা
parameterized `requireAyzenMailboxSubOwnership(resource, action,
notFoundLabel)` লেখা হলো — Phase C7-এর `email-accounts.ts`-এর
parameterized `requireEmailAccountOwnership(action, notFoundBody)`-র
same spirit, শুধু এখানে চারটা ভিন্ন resource-এর মধ্যে শেয়ার করা হলো কারণ
সবগুলোর body shape literally identical (শুধু নামটা বদলায়)।

| Route | নতুন `action` |
|---|---|
| `PATCH /ayzen-email/mailbox/folders/:id` | `ayzen_mailbox_folder.update` |
| `DELETE /ayzen-email/mailbox/folders/:id` | `ayzen_mailbox_folder.delete` |
| `PATCH /ayzen-email/mailbox/labels/:id` | `ayzen_mailbox_label.update` |
| `DELETE /ayzen-email/mailbox/labels/:id` | `ayzen_mailbox_label.delete` |
| `PATCH /ayzen-email/mailbox/templates/:id` | `ayzen_mailbox_template.update` |
| `DELETE /ayzen-email/mailbox/templates/:id` | `ayzen_mailbox_template.delete` |
| `PATCH /ayzen-email/mailbox/rules/:id` | `ayzen_mailbox_rule.update` |
| `DELETE /ayzen-email/mailbox/rules/:id` | `ayzen_mailbox_rule.delete` |

### Sentinel — same `-1` trick
`AYZEN_FOLDER_OWNER_SENTINEL_NONE` / `AYZEN_LABEL_OWNER_SENTINEL_NONE` /
`AYZEN_TEMPLATE_OWNER_SENTINEL_NONE` / `AYZEN_RULE_OWNER_SENTINEL_NONE` —
আগের সব ফেজের same posture।

## কেন `PATCH /ayzen-email/mailbox/:id/labels` বাদ
এই route "Labels" সেকশনের ভেতরেই বসে আছে, কিন্তু এর `:id` আসলে একটা
**message** id (`ayzenMailboxMessagesTable`), কোনো label id না — এটা
label-এর সেট বদলায় একটা নির্দিষ্ট মেসেজের উপর। এটা mechanical-এ এই ফেজের
label resource-এর সাথে মেলে না — বরং deferred বড় "message" resource
batch-এর অংশ (নিচে দেখুন)।

## কেন বাকি পুরো ফাইল (message resource) এখনো বাদ
`GET /ayzen-email/mailbox` থেকে শুরু করে (লাইন ~746) file-এর বাকি অংশ —
thread view, quick-action, search, analytics, contacts, senders/
problematic-recipients/sending-health, admin sending-config, আর
individual-message action-গুলো (star/read/snooze/unsnooze/reschedule/
cancel-schedule/undo-send/move/mark-spam/not-spam, bulk action, delete,
trash empty, drafts, send) — এই সবগুলো একটাই resource (mailbox message)-এর
২০+ ভিন্ন verb, একই ফাইলের বাকি অর্ধেকের বেশি লাইন। এটাকে এই চারটা ছোট
settings resource-এর সাথে একই ব্যাচে গুঁজে দেওয়াটা তাড়াহুড়ো হতো — Phase
C7 যে কারণে পুরো ফাইলটাকে একবারে "dedicated phase দরকার" বলেছিল, সেই একই
যুক্তি এখনো এই বড় অংশের জন্য প্রযোজ্য। এই resource-এর নিজস্ব ownership shape
(কোনগুলো owner-স্কোপড দরকার, কোনগুলো ইতিমধ্যে অন্য কোনো mechanism দিয়ে
সুরক্ষিত, bulk-action-এ ownership কীভাবে বসবে) আলাদা মনোযোগ দাবি করে —
পরবর্তী phase-এর (C11+) কাজ হিসেবে রাখা হলো।

## Resource lookup — client-supplied কিছু trust করা হয়নি
চারটা `ResourceRefBuilder`-ই `:id` দিয়ে সরাসরি DB থেকে real owner পড়ে —
Phase B1/C1-C9-এর same trust-boundary posture।

## এই ফেজে যা সরানো হয়নি
প্রতিটা route-এর existing hand-rolled scoping, uniqueness-constraint
error handling (folder/label/template নাম duplicate হলে 409), আর
folder-delete-এর নিজস্ব side-effect (folder-এর মেসেজগুলো archive-এ সরানো)
— সব অপরিবর্তিত। GET/POST (list/create) route-গুলো touch করা হয়নি, এই
সিরিজের বাকি সব ফেজের মতোই।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। owner-এর existing success path
আটটা route-েই অপরিবর্তিত; non-owner/nonexistent id ঠিক আগে যা রিটার্ন
করত তাই এখনো করে — শুধু এখন একটা real, audited `AuthorizationDecision`
এর পেছনে।

## যা টেস্ট করা হয়েছে
- `ayzen-mailbox.ts`-এ bracket/brace/paren balance script চালানো হয়েছে —
  `{}` 721/721, `()` 2121/2121, `[]` 143/143 — সব শূন্যে মেলে।
- এই sandbox-এ `node_modules`/`tsc` install নেই, তাই আগের ফেজগুলোর মতোই
  standalone type-check চালানো যায়নি — প্রতিটা নতুন import
  (`requireOwnership`/`ResourceRefBuilder`/`pepDecisionObserver`)
  সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep করে যাচাই করা
  হয়েছে — আগের ফেজগুলোতে যেখানে verify করা হয়েছিল ঠিক সেই একই export,
  নতুন কিছু না।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner → gate
  ALLOW → handler logic অপরিবর্তিত চলে। non-owner/nonexistent id → gate
  abstain → default-deny → `onDeny`-তে বসানো ঠিক pre-existing `404` body,
  চারটা resource-এর label ("Folder"/"Label"/"Template"/"Rule") আলাদাভাবে
  মিলিয়ে দেখা হয়েছে যাতে কোনোটা ভুল করে আরেকটার body না পায়।
- `DELETE /folders/:id`-এ বিশেষভাবে verify করা হয়েছে যে নতুন gate
  handler-এর নিজস্ব archive-move side-effect-কে প্রভাবিত করে না — gate
  ALLOW দিলে handler নিজের select-then-verify আগের মতোই আবার চালায় (সামান্য
  redundant DB read, কিন্তু কোনো behavior পরিবর্তন না, ঠিক Phase B1/C1-এর
  মতোই "PEP additive, handler-এর নিজস্ব logic touch করে না" নীতি)।

## এখনো যা বাকি
`ayzen-mailbox.ts`-এর message resource (thread/search/analytics/contacts/
senders/sending-health + সব message-level action, drafts, send) — এই
ফাইলের সবচেয়ে বড় ও জটিল অংশ, ভবিষ্যতের phase (C11+)-এর জন্য নির্দিষ্টভাবে
রাখা হলো। এছাড়া `vault.ts`/`vault-attachments.ts`/`vault-snapshot.ts`
(Season B-র Phase B2-এর জন্য সংরক্ষিত) আর `email-compose.ts` (নিজের
`requireAuth` wiring নেই) — আগের ফেজগুলোতে বলা একই কারণে এখনো বাইরে।
