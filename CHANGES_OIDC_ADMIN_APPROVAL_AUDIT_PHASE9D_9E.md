# OIDC Roadmap — Season 5, Phase 9d..9e: Approval/Suspension Workflow + Audit Log

## যা আগে থেকেই ছিল
- `oidc_clients.registration_status` (migration 091, `'pending' | 'approved' | 'suspended'`) —
  `POST /oidc/register` (8a) দিয়ে তৈরি প্রতিটা client ডিফল্ট `'pending'`; `lib/oidc-client-validation.ts`-এর
  `validateOidcClientId()` (8c) `/oidc/authorize`/`/oidc/token`-এ এই status enforce করে — কিন্তু
  `'pending'` থেকে `'approved'`-এ নেওয়ার বা কাউকে `'suspended'` করার কোনো UI/API আগে ছিল না।
- `routes/admin-oidc-clients.ts` (9a-9c) — `GET /admin/oidc-clients` (list), `GET`/`PATCH
  /admin/oidc-clients/:clientId` (detail/edit), `POST`/`DELETE /admin/oidc-clients` (create/delete,
  first-party path)। সবগুলো `requireDev`-গেটেড, `lib/oidc-client-admin.ts` + `lib/oidc-client-admin-request.ts`-এর
  "route composes, one lib validates, one lib persists" split মেনে।
- `lib/vault-backup-audit.ts` — "dedicated audit table, best-effort non-blocking write helper,
  never throws" ডিজাইন প্যাটার্নের precedent (কলাম-নাম হুবহু না, ডিজাইন-শেপ হিসেবে reused)।
- `lib/oidc-client-admin.ts`-এর নিজের 9c-এর header ইতিমধ্যেই Phase 10 dependency-টা নাম ধরে
  documented রেখেছিল (`deleteOidcClientAdmin()`-এর কমেন্ট): suspend/delete-এর সময় token
  invalidate করার কোনো ফাংশন এখনো codebase-এ নেই।

## যেটা যোগ করা হলো

### Phase 9d — Approval/Suspension Workflow
| ফাইল | পরিবর্তন |
|---|---|
| `lib/oidc-client-admin-request.ts` | `validateOidcAdminClientStatusRequest()` **নতুন** — pure, DB-free। শুধু `'approved'`/`'suspended'` valid target; `'pending'` কখনো accept করে না (client শুধু 8a দিয়ে fresh-registered হয়েই pending-এ আসে, admin action দিয়ে কখনো না — roadmap কোনো "un-approve" transition নাম করেনি)। কারেন্ট status চেক করে না (সেটা persistence layer-এর কাজ, কারণ সেটার জন্য DB read লাগে) |
| `lib/oidc-client-admin.ts` | `updateOidcClientStatusAdmin()` **নতুন** — 9b-এর `updateOidcClientAdmin()`-এর মতো একটা জেনেরিক "patch any column" ফাংশন না বানিয়ে আলাদা রাখা হয়েছে, যাতে 9e-এর audit action label (`"client_updated"` vs `"client_status_changed"`) কোনো column-diffing ছাড়াই ঠিক হয়। Transition enforce করে: `'approved'` শুধু কারেন্ট status `'pending'` হলেই legal, `'suspended'` যেকোনো অবস্থা থেকে (already-suspended-কে আবার suspend করা idempotent no-op, error না) |
| `routes/admin-oidc-clients.ts` | `PATCH /admin/oidc-clients/:clientId/status` **নতুন** route — body validate → before-snapshot নেয় → persist করে → audit log লেখে → updated client রিটার্ন করে |

**Phase 10 gap, explicitly named (fake করা হয়নি):** suspend করলে `registration_status = 'suspended'`
সেট হয়ে যায়, ফলে ভবিষ্যতের `/oidc/authorize`/`/oidc/token` কল সাথে সাথে reject হবে (existing 8c
enforcement-এর মাধ্যমে) — কিন্তু client-এর হাতে আগে থেকে থাকা কোনো access/refresh token এখনই invalidate
হয় না, কারণ Phase 10-এর `revokeAllTokensForClient()` এই zip (phase9b-9c base)-এ এখনো নেই। এটা ঠিক সেই
একই gap যেটা `deleteOidcClientAdmin()`-এর নিজের comment আর `lib/oidc-user-consents.ts`-এর 7d section
আগে থেকেই নাম ধরে documented রেখেছিল — এখানে তৃতীয়বার একই ভাষায় explicit করা হলো, কোনো stub/fake
call যোগ না করে।

### Phase 9e — Audit Log
| ফাইল | পরিবর্তন |
|---|---|
| `migrations/093_ayzen_oidc_client_admin_audit_log.sql` | **নতুন** — `oidc_client_admin_audit_log` টেবিল: `actor_id` (nullable FK → `users(id) ON DELETE SET NULL`), `client_id` (NOT FK — delete-এর audit entry-তে row না-থাকা client_id রাখতে হয়), `action`, `before`/`after` (দুটোই nullable JSONB), `at`। `(client_id, at DESC)`-এ composite index — একমাত্র read path (per-client history) সরাসরি সার্ভ করে |
| `lib/oidc-client-admin-audit.ts` | **নতুন** — `logOidcClientAdminAudit()` (best-effort, try/catch-এ wrap করা, কখনো throw করে না — `logBackupAudit()`-এর একই discipline) + `listOidcClientAdminAuditLog()` (per-client, newest-first, বাউন্ডেড limit) |
| `routes/admin-oidc-clients.ts` | `GET /admin/oidc-clients/:clientId/audit-log` **নতুন** route। এছাড়া existing 9b (`PATCH`)/9c (`POST`, `DELETE`) handler-গুলোতেও `logOidcClientAdminAudit()` call যোগ করা হয়েছে — roadmap-এর নিজের টেক্সট অনুযায়ী "প্রতিটা 9b/9c/9d action-এ একটা রো"। `before`/`after` সবসময় `serializeOidcClientForAdmin()`-এর আউটপুট (কখনো raw `OidcClient` না) — তাই `clientSecretHash`/`registrationAccessTokenHash` কখনো audit টেবিলে লিক হতে পারে না |

### টেস্ট
| ফাইল | কাভার করে |
|---|---|
| `scripts/src/test-oidc-admin-status-audit.ts` | `validateOidcAdminClientStatusRequest()` (valid `'approved'`/`'suspended'`, `'pending'` reject, missing/malformed/non-object body) + audit-row null-handling contract (`client_created`-এ `before: null`, `client_deleted`-এ `after: null`, `actor_id: null` কখনো throw করায় না) — একটা লোকাল structural stand-in দিয়ে, যেহেতু আসল `mapAuditRow()` এই ফাইলে export করা হয়নি (একমাত্র caller একই ফাইলে) |
| `updateOidcClientStatusAdmin()` / `logOidcClientAdminAudit()` / `listOidcClientAdminAuditLog()` | live `DATABASE_URL` লাগে — এই পাসে script-এ কাভার করা যায়নি, `getActiveConsent()`/`grantConsent()`-এর (7a) একই precedent (manual/integration verification)। এই sandbox-এ `node_modules` ইনস্টল করা নেই (network বন্ধ) বলে TS syntax-level check (পাশ করেছে) আর ম্যানুয়াল রিভিউয়ের বেশি করা যায়নি |

## স্কোপ ডিসিপ্লিন — এই পাসে ইচ্ছাকৃতভাবে যা করা হয়নি
- **কোনো token revocation কল নেই suspend-এ।** Phase 10 না থাকায় — উপরে বিস্তারিত।
- **`'pending'`-এ ফিরে যাওয়ার (un-approve) কোনো path নেই।** Roadmap-এর 9d টেক্সট শুধু দুটো
  transition নাম করে (`pending→approved`, `any→suspended`); তৃতীয় কোনো transition অনুমান করে
  বানানো হয়নি।
- **`registrationStatus`-এর জন্য DB-level CHECK constraint নেই নতুন audit টেবিলের `action`
  কলামে।** TS union (`OidcClientAdminAuditAction`) authoritative রাখা হয়েছে, কারণ ভবিষ্যতে নতুন
  admin action যোগ হলে (কোনো future phase) সেটা শুধু TS union-এ যোগ করলেই হবে, migration লাগবে না —
  এটা migration 091-এর `registration_status` CHECK constraint-এর বিপরীত সিদ্ধান্ত, ইচ্ছাকৃতভাবে,
  কারণ ওই কলামের (business-critical state machine) আর এই কলামের (append-only log label)
  guarantee-এর প্রয়োজনীয়তা ভিন্ন।
- **Audit log-এর কোনো pagination cursor/offset নেই, শুধু `limit`।** একটা single client-এর history
  practically কখনো শত শত entry ছাড়াবে না (এটা কতগুলো admin action, user traffic না) — `LIMIT 500`
  cap-ই যথেষ্ট এই স্কেলে।
- **Suspended client-কে আবার approve করার কোনো path নেই।** Un-suspend roadmap-এর 9d টেক্সটে নেই।

## এখনো বাকি (এই ডকুমেন্টের ঘোষিত scope-এর বাইরে)
- **Phase 10 — Token Introspection & Revocation:** `POST /oidc/introspect`, `POST /oidc/revoke`,
  `revokeAllTokensForClientAndUser()`/`revokeAllTokensForClient()` (cascade), backchannel-logout hook,
  discovery metadata আপডেট। এটাই এই Season-এর শেষ ধাপ — একবার এটা এলে, 7d-এর consent-revoke আর
  9d-এর এই suspend action দুটোই সেই একই cascade ফাংশন কল করবে, কোনো দ্বিতীয় revocation logic ছাড়াই।
