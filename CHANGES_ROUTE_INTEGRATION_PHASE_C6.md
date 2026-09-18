# Route Integration Roadmap — Season C, Phase C6: Mechanical Sweep (batch 6, combined-where ownership shape)

## যা আগে থেকেই ছিল
Phase C1–C5 পর্যন্ত পুরো `routes/` ডিরেক্টরিতে `userId !== `/`!== .*userId`
grep-এর সব hit migrate করা হয়ে গেছে (বা false-positive হিসেবে চিহ্নিত ও
untouched রাখা হয়েছে) — Phase C5-এর নিজের "এখনো যা বাকি" অংশ দেখুন। কিন্তু
সেই grep pattern-টা একটা নির্দিষ্ট shape-ই ধরে (`x.ownerId !== userId`),
আরেকটা সমান-common ownership shape এটা কখনো ধরেনি:

```ts
.where(and(eq(table.id, id), eq(table.userId, userId)))
```

— অর্থাৎ ownership check-টা কোনো `if`/`!==`-এ লেখা না, বরং সরাসরি SQL
`WHERE`-এর ভেতরে বসানো (row না মিললে handler নিজেই একটা 404/no-op দেয়)।
Phase C5 নিজেই এটা চিহ্নিত করে রেখেছিল: "এই grep pattern-এর বাইরে থাকা
ownership shape-গুলো ... একটা ভবিষ্যৎ phase পুরো routes-এ manual audit
চালিয়ে সেগুলো খুঁজে বের করতে পারে।" এই ফেজ সেই manual audit।

`grep -rl "and(eq("` পুরো `routes/`-এ চালিয়ে ২৫টা ফাইল পাওয়া গেছে; এর
মধ্যে যেগুলো ইতিমধ্যে migrate হয়ে গেছে (`finance.ts` — B1, `finance-invoices.ts`
— C3, `teams.ts` — C4, `passkey.ts`/`vault-reauth.ts` — C2) বাদ দিয়ে ১৯টা
candidate ফাইল বাকি ছিল। এর মধ্যে থেকে এই ফেজে দুটো ফাইল নেওয়া হলো
(বাকিগুলো নিচের "এখনো যা বাকি" অংশে) — দুটোই ছোট, পরিষ্কার single-resource
CRUD shape, `requireAuth`/`requireSessionAuth` দিয়ে `req.user` populate করা
(তাই `requireOwnership()`-এর subject resolution-এর জন্য অতিরিক্ত কিছু লাগে
না)।

## এই ফাইলগুলোর নিজস্ব বৈশিষ্ট্য

### `routes/api-keys.ts`
৫টা `:id`-based route (`PATCH /api-keys/:id/scopes`, `PATCH /api-keys/:id`,
`POST /api-keys/:id/rotate`, `POST /api-keys/:id/revoke`,
`DELETE /api-keys/:id`) — প্রতিটাই নিজের `UPDATE`/`DELETE`-এর `WHERE`-এই
`and(eq(apiKeysTable.id, id), eq(apiKeysTable.userId, user.userId))` (আর
rotate-এর ক্ষেত্রে অতিরিক্ত `isNull(revokedAt)`) দিয়ে scope করত, `!row` হলে
404। দুটো ভিন্ন 404 body আছে: চারটাতে `{ error: "Key not found" }`, rotate-এ
`{ error: "Key not found or already revoked" }`।

### `routes/notifications.ts`
২টা `:id`-based route (`PATCH /notifications/:id/read`,
`DELETE /notifications/:id`) — কোনোটাই কখনো 404 দেয়নি: নিজের
`UPDATE`/`DELETE ... WHERE id=$1 AND userId=$2` শূন্য row touch করলেও
handler সবসময় `{ success: true }` (200) রিটার্ন করে (silent no-op) —
existence/ownership leak এড়ানোর জন্য এটা ইচ্ছাকৃত pre-existing আচরণ, এই
ফেজ সেটা বদলায়নি।

## যেটা যোগ করা হলো (Phase C6)
Phase B1/C1-C5-এর same pattern: প্রতিটা ফাইলে নিজের module-load-time
`ResourceRefBuilder` (DB থেকে `:id`-র real owner পড়ে) + একটা throwaway
`requireOwnership()` middleware, `pepDecisionObserver` (Phase A3, এখন
export করা) দিয়ে wired।

| ফাইল | Route | নতুন `action` | `onDeny` response (অপরিবর্তিত) |
|---|---|---|---|
| `api-keys.ts` | `PATCH /api-keys/:id/scopes` | `api_key.scopes.update` | `404 { error: "Key not found" }` |
| `api-keys.ts` | `PATCH /api-keys/:id` | `api_key.rename` | `404 { error: "Key not found" }` |
| `api-keys.ts` | `POST /api-keys/:id/rotate` | `api_key.rotate` | `404 { error: "Key not found or already revoked" }` |
| `api-keys.ts` | `POST /api-keys/:id/revoke` | `api_key.revoke` | `404 { error: "Key not found" }` |
| `api-keys.ts` | `DELETE /api-keys/:id` | `api_key.delete` | `404 { error: "Key not found" }` |
| `notifications.ts` | `PATCH /notifications/:id/read` | `notification.read` | `200 { success: true }` |
| `notifications.ts` | `DELETE /notifications/:id` | `notification.delete` | `200 { success: true }` |

### Sentinel — record নেই মানে normal DENY, thrown wiring error না
Phase B1-এর `FINANCE_OWNER_SENTINEL_NONE` (`-1`) exact same trick প্রতিটা
ফাইলে নিজের নামে repeat করা হলো (`API_KEY_OWNER_SENTINEL_NONE`,
`NOTIFICATION_OWNER_SENTINEL_NONE`) — `usersTable.id` কখনো negative হয় না
(positive serial), তাই sentinel কখনো কোনো real owner-এর সাথে মেলে না।

### `rotate`-এর combined 404 — ownership gate এটা ভাঙে না
`POST /api-keys/:id/rotate`-এর নিজস্ব query-তে `isNull(revokedAt)`-ও থাকে,
কিন্তু নতুন ownership gate-টা শুধু `id`-দিয়ে owner পড়ে (revoked কিনা চেক করে
না)। ফলে: owner নিজে কিন্তু key already revoked → gate ALLOW করে (owner
মেলে), তারপর handler-এর নিজের বেশি-specific query শূন্য row পায় → হ্যান্ডলার
নিজেই সেই একই `404 { error: "Key not found or already revoked" }` দেয় —
gate এই কেসে কিছুই বদলায় না, শুধু non-owner/nonexistent-id কেসেই আগে থেকে
denial করে।

### Notifications — 404 না, byte-for-byte পুরনো response reuse করা হলো
`requireOwnership()`-এর default deny rendering ব্যবহার না করে,
`requireNotificationOwnership()`-এর নিজের `onDeny` ঠিক পুরনো silent-success
শেপটাই রেন্ডার করে (`res.json({ success: true })`, কোনো নতুন status code
না) — Phase B1-এর "onDeny for byte-for-byte response parity" নীতির একটা
variant: এখানে parity-র লক্ষ্য একটা pre-existing 404 না, বরং একটা
pre-existing "সবসময় সফল দেখানো" no-op।

### Resource lookup — client-supplied কিছু trust করা হয়নি
দুটো `ResourceRefBuilder`-ই `:id` দিয়ে সরাসরি DB থেকে real owner পড়ে
(`apiKeysTable.userId`/`notificationsTable.userId`), কখনো request
body/query থেকে ownerId নেয় না — `ownership-rule.ts`-এর নিজের trust
boundary মেনে, Phase B1/C1-C5-এর same posture।

## `pepDecisionObserver` — reuse, দ্বিতীয় instance নয়
দুটো ফাইলই `middlewares/auth.ts`-এর একই exported `pepDecisionObserver`
(Phase B1-এ export করা হয়েছিল) import করে reuse করে — নতুন কোনো
audit-writer/observer instance বানানো হয়নি, ফলে সব decision একই audit
table/metrics registry-তে যায়।

## এই ফেজে যা সরানো হয়নি
- প্রতিটা route-এর existing hand-rolled `and(eq(table.id, id), eq(table.userId, userId))`
  scoping — অপরিবর্তিত, নতুন ownership check এটার আগে বসে একটা আলাদা,
  স্বাধীন second check করে (defense-in-depth, replace না)।
- `api-keys.ts`-এর `GET /api-keys` (list) আর `POST /api-keys` (create) —
  কোনো single existing resource-এর ownership প্রশ্ন না (Phase B1-এর
  "list/create বাদ" যুক্তি, একই কারণে)।
- `notifications.ts`-এর `GET /notifications/unread-count` (session token
  ছাড়াও কাজ করে, নিজের manual token parse) আর `PATCH /notifications/read-all`
  (bulk, কোনো একক `:id` না) — ownership gate-এর scope-এর বাইরে।
- `notifications.ts`-এর `POST /notifications` (admin-only, `requireAdmin`,
  কোনো owner-vs-admin প্রশ্ন না — শুধু admin) — touch করা হয়নি।

## এখনো যা বাকি (একই "combined-where" audit থেকে, future phase-এর জন্য)
`and(eq(` grep-এর বাকি candidate ফাইলগুলো (migrate না হওয়া):
`ayzen-mailbox.ts` (২০০০+ লাইন, বহু resource type — নিজের একটা আলাদা phase
দরকার), `email-accounts.ts`/`wallets.ts` (Phase C7-এ করা হয়েছে),
`vault-entity-links.ts`, `projects.ts`, `emergency-access.ts` (grant/admin
workflow, শুধু ownership না — approval-এর মতো shape থাকতে পারে),
`polymarket.ts` (নিচে ব্যাখ্যা, excluded)। `config.ts`/`nav.ts`
(admin-config table, user ownership না), `project-templates.ts`
(`ne(id)` exclusion, ownership গেট না), `credits.ts`/`users.ts`/
`resend-webhook.ts` (self-scoped বা internal, কোনো `:id`-vs-owner প্রশ্ন
না) — এই তিনটা false-positive হিসেবে untouched রাখা হলো, Phase
C1/C2/C5-এর নিজস্ব নীতি অনুযায়ী।

`polymarket.ts`-এ `and(eq(walletsTable...))` hit থাকলেও এটা এই ফেজে
touch হয়নি: এই ফাইল `requireAuth`/`getRequestUser` ব্যবহার করে না — নিজের
`requireUser()` helper দিয়ে `getTokenFromReq`/`getUserFromToken` সরাসরি
কল করে, কখনো `req.user` populate করে না। `requireOwnership()`-এর subject
resolution `req.user`-এর উপর নির্ভরশীল (`authorize.ts`-এর নিজের header
দেখুন) — তাই এখানে middleware বসালে req.user না থাকায় UNAUTHENTICATED
deny হয়ে যেত, route ভেঙে যেত। এটা একটা mechanical batch-এর কাজ না — আগে
এই ফাইলটাকে `requireAuth`-based shape-এ আনতে হবে, সেটা নিজেই একটা আলাদা
সিদ্ধান্ত/phase।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral:
- `api-keys.ts`: owner → আগের success path অপরিবর্তিত। non-owner/nonexistent
  id → আগেও 404 পেত (হাতে-লেখা scoping-এর কারণে), এখনো একই 404-ই পায়,
  শুধু এখন PDP-র মধ্য দিয়ে audited।
- `notifications.ts`: owner → আগের success path অপরিবর্তিত। non-owner/
  nonexistent id → আগেও `{ success: true }` পেত (silent no-op), এখনো তাই
  পায় — শুধু এখন একটা real `AuthorizationDecision` (DENY) ওই no-op-এর
  পেছনে audit trail-এ ধরা পড়ে।

## যা টেস্ট করা হয়েছে
- দুটো এডিট করা ফাইলেই bracket/brace/paren balance স্ক্রিপ্ট দিয়ে চেক করা
  হয়েছে — `api-keys.ts`: `{}` 108/108, `()` 235/235, `[]` 16/16;
  `notifications.ts`: `{}` 57/57, `()` 118/118, `[]` 8/8 — সব শূন্যে মেলে।
- `tsc`/`node_modules` এই sandbox-এ install নেই (আগের ফেজগুলোর মতোই একই
  baseline সীমাবদ্ধতা) — তাই standalone `tsc --noEmit` চালানো যায়নি; তার
  বদলে প্রতিটা নতুন import সোর্স ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান
  কিনা grep করে যাচাই করা হয়েছে: `requireOwnership` →
  `lib/policy/pep/middleware.ts` (line 165), `ResourceRefBuilder` →
  `lib/policy/pep/types.ts` (line 75), `pepDecisionObserver`/`requireAuth`/
  `requireSessionAuth`/`getRequestUser` → `middlewares/auth.ts` — সব
  মিলেছে, কোনো mismatch নেই।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner নিজে →
  ownership rule ALLOW → আগের success path। অন্য কেউ/nonexistent id → rule
  abstain → default-deny (`NO_MATCHING_POLICY`) → `onDeny`-তে বসানো ঠিক
  আগের response (byte-for-byte, প্রতিটা ফাইলের নিজের pre-existing শেপ
  অনুযায়ী)।
- `api-keys.ts`-এর rotate route-এ বিশেষভাবে verify করা হয়েছে:
  owner+not-revoked → gate ALLOW → handler-এর specific query row পায় →
  normal rotate flow। owner+already-revoked → gate তাও ALLOW করে (owner
  ঠিকই আছে) → handler-এর নিজের `isNull(revokedAt)` query শূন্য row পায় →
  handler নিজেই `404 { error: "Key not found or already revoked" }` দেয়
  — gate এই distinction-টা ভাঙেনি।
