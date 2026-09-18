# Route Integration Roadmap — Season C, Phase C15: Mechanical Sweep (batch 15, local-accounts.ts — new file for this series)

## যা আগে থেকেই ছিল
`local-accounts.ts` কখনো original ১৩৮-route audit-এর inventory-তে ছিল
না — এই ফেজে fresh sweep চালিয়ে খুঁজে পাওয়া গেছে, ঠিক এই সিরিজের বাকি সব
জায়গার same shape: client-supplied `:id` + hand-rolled ownership check,
শুধু এখানে Drizzle-এর `and(eq(...))`-এর বদলে raw SQL string-এ লেখা —
`WHERE id = ${id} AND user_id = ${userId}`। ফাংশনালি একই জিনিস, শুধু
syntax আলাদা।

| Route | আগের behavior (non-owner/nonexistent id) |
|---|---|
| `PUT /local-accounts/:id` | `404 { error: "Not found or forbidden" }` |
| `PATCH /local-accounts/:id/status` | `404 { error: "Not found or forbidden" }` |
| `DELETE /local-accounts/:id` | **কোনো error না** — quiet no-op, `{ success: true }` |
| `PATCH /local-accounts/:id/link-vault` | `404 { error: "Not found" }` |
| `PATCH /local-accounts/:id/unlink-vault` | `404 { error: "Not found" }` |
| `GET /local-accounts/:id` | `404 { error: "Account not found" }` |
| `GET /local-accounts/:id/points` | **কোনো error না** — empty list, `{ entries: [], total: 0 }` |
| `POST /local-accounts/:id/points` | **কোনো check-ই ছিল না** — সরাসরি insert |
| `POST /local-accounts/:id/receipt` | `404 { error: "Account not found" }` |
| `DELETE /local-accounts/:id/receipt` | `404 { error: "Account not found" }` |

## যেটা যোগ করা হলো (Phase C15)
একটা module-level `localAccountResource` (`ResourceRefBuilder`) — `:id`
দিয়ে সরাসরি DB থেকে real owner (`local_accounts.user_id`) পড়ে, কোনো
`userId` filter ছাড়াই (এই সিরিজের same trust-boundary posture)। lookup-টা
লেখা হলো parameterized `` sql`...` `` tagged template দিয়ে (`sql.raw`
না) — এই ফাইলই আগে থেকে দুটো style মিশিয়ে ব্যবহার করে (`value_history`
DELETE-এ আগে থেকেই parameterized `` sql`...` `` আছে), আর নতুন যোগ হওয়া এই
query-টার string-interpolation দিয়ে লেখার কোনো কারণ নেই। ফাইলের
**বিদ্যমান** query-গুলো (যেগুলো `sql.raw` দিয়ে লেখা) অপরিবর্তিত রাখা হলো —
সেগুলো ঠিক করা একটা আলাদা, বড় hardening effort, এই ফেজের scope-এর বাইরে।

প্রতিটা route-এর নিজস্ব pre-existing response body ধরে রাখতে
`requireLocalAccountOwnership(action, onDeny)` একটা customizable `onDeny`
callback নেয় (parameterized helper গুলো: `denyNotFoundOrForbidden`,
`denyNotFound`, `denyAccountNotFound`, `denySilentSuccess`,
`denyEmptyPoints`)।

### দুটো route কোনো error-ই দেয় না — সেটাই byte-for-byte রাখা হলো
`DELETE /:id` আর `GET /:id/points` — এই দুটো route non-owned id-তে
আগে **কোনো 404 দিতই না**: DELETE নিঃশব্দে ০ row মুছে `{success:true}`
রিটার্ন করত, points GET খালি লিস্ট দিত। এই দুটোর `onDeny` তাই সেই একই
"quiet no-op" body দেয়, `404` না — কারণ `404` দিলে এখন নতুন করে জানিয়ে
দেওয়া হতো যে "এই id আসলে আছে, শুধু তোমার না" — যেটা আগের কোড কখনো বলত না।
এটা এই সিরিজের বাকি সব phase-এর "byte-for-byte behavior preserve" নীতির
সবচেয়ে কঠোর প্রয়োগ।

| Route | নতুন `action` |
|---|---|
| `PUT /:id` | `local_account.update` |
| `PATCH /:id/status` | `local_account.status.update` |
| `DELETE /:id` | `local_account.delete` |
| `PATCH /:id/link-vault` | `local_account.link_vault` |
| `PATCH /:id/unlink-vault` | `local_account.unlink_vault` |
| `GET /:id` | `local_account.read` |
| `GET /:id/points` | `local_account.points.read` |
| `POST /:id/points` | `local_account.points.create` |
| `POST /:id/receipt` | `local_account.receipt.create` |
| `DELETE /:id/receipt` | `local_account.receipt.revoke` |

### একটা real gap পাওয়া গেছে এবং ঠিক করা হলো — `POST /:id/points`
বাকি নয়টা route-এর মতো না — এটার আগে **কোনো ownership check-ই ছিল না**।
Handler সরাসরি `INSERT INTO local_account_points (account_id, user_id,
amount, notes) VALUES (${accountId}, ${userId}, ...)` চালাত — `accountId`
আসলে caller-এর নিজের কিনা কখনো verify করত না। মানে যেকোনো authenticated
user অন্য কারো `local_accounts.id` refer করে একটা points entry বানিয়ে
ফেলতে পারত, নিজের `userId` ট্যাগ করে — data-integrity গ্যাপ (severe
leak না, কিন্তু ভুল জায়গায় ডেটা জোড়া লাগানো সম্ভব ছিল)। এই ফেজে
`requireLocalAccountOwnership` গেট বসানো হলো এই route-এও — **এটা একটা
সত্যিকার behavior change, Phase C14-এর email-compose.ts fix-এর মতোই
deliberately flag করা হলো, preserve-behavior refactor না।**

## এই ফেজে যা সরানো হয়নি
- `DELETE /local-accounts/categories/:id` আর `DELETE
  /local-accounts/points/:pointId` — ভিন্ন resource type
  (`local_account_category`, `local_account_point`), নিজেদের id-space,
  নিজেদের owner column — এই ব্যাচে না, future phase-এর candidate।
- `GET /local-accounts/receipt/:token`, `GET
  /local-accounts/receipt/:token/pdf` — ফাইলের নিজের comment অনুযায়ী
  "possession-is-auth" মডেল (finance.ts-এর receipt link-এর মতোই), client
  id না, token — বাদ।
- `POST/DELETE /local-accounts/category-receipt/:category` —
  `category` কোনো shared/global resource id না, বরং প্রতিটা user-এর
  নিজস্ব namespace-এর একটা slice (`WHERE user_id = ... AND category =
  ...` দিয়ে scope করা, আলাদা owner lookup করার কিছু নেই) — genuinely
  self-scoped, C9-এর নিজের exclusion যুক্তির same class, বাদ।

## এই ফেজে যা সরানো হয়নি (handler logic)
প্রতিটা route-এর নিজস্ব existing query, sync hook
(`syncOnLocalAccountUpdate`/`syncOnLocalAccountDelete`), encrypt/decrypt
field logic, receipt-token generation — সব হুবহু অপরিবর্তিত।

## Rollout
`POST /:id/points`-এ একটা real behavior change আছে (উপরে বলা হয়েছে)।
বাকি নয়টা route-এর owner-এর success path বা non-owner/nonexistent-id-এর
response — দুটোই আগের মতোই অপরিবর্তিত। কোনো নতুন env var, migration
লাগেনি।

## যা টেস্ট করা হয়েছে
- `local-accounts.ts`-এ bracket/brace/paren balance script চালানো
  হয়েছে — `{}` 406/406, `()` 664/664 — শূন্যে মেলে।
- সবগুলো (দশটা) intended route আসলে `requireLocalAccountOwnership(`
  দিয়ে wired হয়েছে কিনা grep করে যাচাই করা হয়েছে, আর deliberately-বাদ-দেওয়া
  route-গুলো (`categories/:id`, `points/:pointId`, receipt/token routes,
  category-receipt routes) এখনো unwired অবস্থায় আছে কিনা আলাদাভাবে confirm
  করা হয়েছে।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner →
  gate ALLOW → handler-এর নিজস্ব query আগের মতোই চলে। non-owner/nonexistent
  id → gate deny → route-specific `onDeny` body, বিশেষভাবে `DELETE /:id`
  আর `GET /:id/points`-এ verify করা হয়েছে যে deny path-ও ঠিক আগের
  "quiet success"/"empty list" body-ই দেয়, নতুন কোনো 404 না।
- `POST /:id/points`-এর নতুন gate confirm করা হয়েছে যে এখন non-owned
  `accountId` দিয়ে call করলে `404 { error: "Account not found" }` পাবে,
  আগে যেটা silently succeed করত।

## এখনো যা বাকি
`local-accounts.ts`-এর `local_account_category`/`local_account_point`
resource-দুটো এখনো unwired। বাকি বড় unaudited surface (marketplace.ts,
mcp-agents.ts-এর dev-gated না এমন কোনো user-owned resource যদি থাকে,
ai-agent.ts) এখনো audit বাকি। `content.ts`-এর missing-ownership gap
আগের মতোই flagged, ফিক্স করা হয়নি — Rakib-এর সিদ্ধান্তের অপেক্ষায়।
