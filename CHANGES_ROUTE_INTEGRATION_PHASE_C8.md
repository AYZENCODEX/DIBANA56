# Route Integration Roadmap — Season C, Phase C8: Mechanical Sweep (batch 8, vault entity links + emergency access)

## যা আগে থেকেই ছিল
Phase C7-এর নিজের "এখনো যা বাকি" তালিকা থেকে এই ফেজে দুটো ফাইল নেওয়া হলো:
`routes/vault-entity-links.ts` আর `routes/emergency-access.ts`। দুটোই
`requireAuth` দিয়ে `req.user` populate করে, আর দুটোতেই `:id`-based route
আছে যেগুলো নিজের hand-rolled combined-where দিয়ে owner check করে —
Phase B1/C1-C7-এর ঠিক same shape।

### `routes/vault-entity-links.ts`
এই ফাইলে দুই ধরনের resource মেশানো: `GET /vault/:id/links` scope করে
একটা **vault entry**-র (`vaultEntriesTable`) উপর owner check দিয়ে
(`ownsEntity()` helper, `and(eq(vaultEntriesTable.id, id),
eq(vaultEntriesTable.userId, userId))`); `PATCH`/`DELETE
/vault-entity-links/:id` scope করে **link row নিজের** (`vaultEntityLinksTable`)
উপর (`and(eq(vaultEntityLinksTable.id, id),
eq(vaultEntityLinksTable.userId, userId))`)। তিনটাই ভিন্ন 404 body দেয়
না — GET → `{ error: "Vault entry not found" }`, PATCH/DELETE দুটোই →
`{ error: "Link not found" }`।

### `routes/emergency-access.ts`
`DELETE /emergency-access/contacts/:id` (owner = `emergencyContactsTable.userId`,
404 `{ error: "Contact not found" }`) আর `POST
/emergency-access/grants/:id/cancel` (owner =
`emergencyAccessGrantsTable.ownerUserId`, 404 `{ error: "No cancellable
grant found" }`) — দুটোই combined-where shape মেলে।

## যেটা যোগ করা হলো (Phase C8)
Phase B1/C1-C7-এর same pattern: প্রতিটা ফাইলে module-load-time
`ResourceRefBuilder` (DB থেকে real owner পড়ে, client-supplied কিছু trust
করে না) + throwaway `requireOwnership()` middleware, shared
`pepDecisionObserver` দিয়ে wired।

| ফাইল | Route | নতুন `action` | `onDeny` response (অপরিবর্তিত) |
|---|---|---|---|
| `vault-entity-links.ts` | `GET /vault/:id/links` | `vault_entry.links.read` | `404 { error: "Vault entry not found" }` |
| `vault-entity-links.ts` | `PATCH /vault-entity-links/:id` | `vault_entity_link.update` | `404 { error: "Link not found" }` |
| `vault-entity-links.ts` | `DELETE /vault-entity-links/:id` | `vault_entity_link.delete` | `404 { error: "Link not found" }` |
| `emergency-access.ts` | `DELETE /emergency-access/contacts/:id` | `emergency_contact.delete` | `404 { error: "Contact not found" }` |
| `emergency-access.ts` | `POST /emergency-access/grants/:id/cancel` | `emergency_access_grant.cancel` | `404 { error: "No cancellable grant found" }` |

### Sentinel — same `-1` trick
`VAULT_ENTRY_OWNER_SENTINEL_NONE` / `VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE`
/ `EMERGENCY_CONTACT_OWNER_SENTINEL_NONE` /
`EMERGENCY_ACCESS_GRANT_OWNER_SENTINEL_NONE` — Phase B1/C1-C7-এর same
posture, `usersTable.id` কখনো negative না বলে sentinel কখনো real
owner-এর সাথে মেলে না।

### `emergency-access.ts` — status filter হাতে-ই থেকে গেছে
`POST /emergency-access/grants/:id/cancel`-এর existing query একই where
clause-এ ownership আর `status IN ('pending_admin_review')` একসাথে চেক
করে। নতুন PEP gate **শুধু ownership** বিচার করে — status filter টা
handler-এর ভেতরেই আগের মতো রয়ে গেছে, ঠিক Phase B1-এর finance route-গুলোর
নিজস্ব business-state filter untouched রাখার মতোই। ফলে owner হলেও ভুল
status-এর grant এখনো একই `404` পায় (এখন PEP gate ALLOW দেওয়ার পর handler
নিজেই সেটা ধরে)।

## কেন `vault-entity-links.ts`-এর `POST /vault-entity-links` বাদ
এই route একসাথে দুটো entity-র ownership check করে (`entityId` আর
`linkedEntityId`, দুটোই request body থেকে) — route-level `:id` param না।
এই ফেজের `ResourceRefBuilder` shape (`req.params.id`-নির্ভর) এখানে খাটে
না — ঠিক Phase C7-এ `email-accounts.ts`-এর `POST
/email-accounts/test-config` বাদ দেওয়ার একই যুক্তি। `GET
/vault/links/all` একটা list route (কোনো `:id` না), এই সিরিজের বাকি
list/create route-গুলোর মতোই বাদ।

## কেন `emergency-access.ts`-এর admin routes বাদ
`POST /admin/emergency-access/grants/:id/approve` আর `.../deny` —
এগুলো `requireAdmin` দিয়ে গার্ড করা, আর Phase A2-এর RBAC-PEP shim থেকে
`requireAdmin` নিজেই ইতিমধ্যে PDP-র মধ্য দিয়ে যায়। এখানে কোনো ownership
প্রশ্ন নেই — পুরো পয়েন্টই হলো একজন **ভিন্ন** ইউজার (admin) অন্য কারো grant
review করছে। Phase C7 এই admin-review shape-টাকে "Phase B3-স্টাইল বিবেচনা
লাগতে পারে" বলে ফ্ল্যাগ করেছিল; খতিয়ে দেখার পর দেখা গেল এখানে আর কিছু করার
নেই — এটা আগে থেকেই PDP-backed। `POST /emergency-access/confirm/:token`
আর `GET /emergency-access/view/:token` — public, token-is-auth routes
(`requireAuth`-ই নেই, `req.user` নেই) — এই সিরিজে OIDC/public route-দের
সবসময় যেভাবে বাদ দেওয়া হয়েছে সেভাবেই বাদ। `GET
/emergency-access/contacts`, `POST /emergency-access/contacts`, `GET
/emergency-access/grants` — list/create, নিজের query-তেই
`eq(...userId, userId)` বসানো (client-supplied `:id` নেই) — এই সিরিজের
বাকি সব list/create route-এর মতো একই exclusion।

## Resource lookup — client-supplied কিছু trust করা হয়নি
চারটা `ResourceRefBuilder`-ই `:id` দিয়ে সরাসরি DB থেকে real owner পড়ে —
Phase B1/C1-C7-এর same trust-boundary posture।

## এই ফেজে যা সরানো হয়নি
প্রতিটা route-এর existing hand-rolled scoping আর side-effect (activity
log write, invite email, notification insert, `lastActiveAt` bump
ইত্যাদি) — সব অপরিবর্তিত। `wallets.ts`-এর send/withdraw-এ Phase C7 যেভাবে
`sensitiveWriteLimiter`-এর পরে নতুন gate বসিয়েছিল, এখানে
`POST /emergency-access/grants/:id/cancel`-এও একই posture — নতুন
`requireEmergencyAccessGrantOwnership()` `sensitiveWriteLimiter`-এর পরেই
বসানো হয়েছে, আগে না (existing middleware order অপরিবর্তিত)।

## Rollout
কোনো নতুন env var, কোনো migration লাগেনি। Behavior-wise ADDITIVE/neutral:
owner-এর existing success path প্রতিটা route-এ অপরিবর্তিত; non-owner/
nonexistent id প্রতিটা route-এ ঠিক আগে যা রিটার্ন করত তাই এখনো করে —
শুধু এখন সেই deny-এর পেছনে একটা real, audited `AuthorizationDecision` আছে।

## যা টেস্ট করা হয়েছে
- দুটো এডিট করা ফাইলেই bracket/brace/paren balance script দিয়ে চেক করা
  হয়েছে — `vault-entity-links.ts`: `{}` 95/95, `()` 217/217, `[]` 16/16;
  `emergency-access.ts`: `{}` 133/133, `()` 280/280, `[]` 15/15 — সব
  শূন্যে মেলে।
- Phase C6/C7-এর মতোই এই sandbox-এ `node_modules`/`tsc` install নেই, তাই
  standalone type-check চালানো যায়নি — তার বদলে প্রতিটা নতুন import সোর্স
  ফাইলে গিয়ে সরাসরি export হিসেবে বিদ্যমান কিনা grep করে যাচাই করা হয়েছে
  (`requireOwnership`/`ResourceRefBuilder`/`pepDecisionObserver`/
  `requireAuth`/`getRequestUserId` — সবগুলো আগের ফেজগুলোতে যেখানে verify
  করা হয়েছিল ঠিক সেই একই export, নতুন কিছু না)।
- ম্যানুয়ালি reasoning করে verify করা হয়েছে প্রতিটা route-এ: owner → gate
  ALLOW → আগের handler logic অপরিবর্তিত চলে। non-owner/nonexistent id →
  gate abstain → default-deny → `onDeny`-তে বসানো ঠিক pre-existing
  response।
- `emergency-access.ts`-এর grant-cancel route-এ বিশেষভাবে verify করা
  হয়েছে যে নতুন gate `sensitiveWriteLimiter`-এর আগে বসেনি (array position
  অপরিবর্তিত), আর owner-কিন্তু-ভুল-status গ্রান্টের ক্ষেত্রে এখনো handler-এর
  নিজের status filter-ই আগের মতো 404 দেয় (PEP gate শুধু ownership আটকায়,
  status না)।

## এখনো যা বাকি
`ayzen-mailbox.ts` (Phase C7-এই ফ্ল্যাগ করা — ২০০০+ লাইন, একাধিক resource
type, একটা dedicated phase দরকার) আর `projects.ts` (এই ফেজে touch করা
হয়নি, Phase C9-এর জন্য রাখা হলো) এখনো বাকি। এছাড়া নতুন করে broader grep-এ
`vault.ts`/`vault-attachments.ts`/`vault-snapshot.ts` ধরা পড়েছে (সবই
vault-entry-scoped, একই combined-where shape), কিন্তু ইচ্ছাকৃতভাবে বাইরে
রাখা হলো — roadmap নিজেই Vault-কে Season B-এর Phase B2 (ownership +
`requireStepUp()`, যেহেতু `vault.ts`-এর `GET /vault/:id/seed`-এর মতো
sensitive-field route-ও একই ফাইলে) এর জন্য সংরক্ষণ করেছে; এগুলোকে এখানে
ownership-only mechanical gate দিয়ে আংশিক ছুঁয়ে ফেললে পরে B2 এসে আবার
পুরো ফাইল ঘাঁটতে হতো দুইবার — Phase C7-এর `wallets.ts` phrase-route
exclusion যুক্তিরই সম্প্রসারণ। `email-compose.ts`-ও বাদ — এটা `requireAuth`
দিয়ে যায়ই না (`getUserIdAsync(req)` সরাসরি ব্যবহার করে, `req.user`
populate হয় না), ঠিক Phase C6-এর `polymarket.ts` exclusion-এর মতোই একই
কারণে — ownership shim বসানোর আগে এই ফাইলের নিজের auth wiring ঠিক করা
লাগবে, সেটা mechanical sweep-এর scope-এর বাইরে।
