# AYZEN Workspace — Phase 8: Organization Accounts (master plan §2/§7 Phase 8)

## Scope
Master plan §7's Build Order names Phase 8 as **"Enterprise/Team tier — org
accounts, shared vaults, managed extension policy."** This is a genuinely
new concept, not a rename of work already done: `CHANGES_WARDE_SUBDOMAIN_
SPLIT.md` (folded in early, out of build order) claimed exactly Warde's
existing *farming-team* product surface (`teams`/`team_members` —
members, chat, browse/invite, missions, team vault) and explicitly flagged
the org-account layer this doc covers as still unbuilt: *"nothing here
builds the enterprise/org-account layer (shared vaults, org wallets,
cross-app audit log) that section [§2/§9] describes."*

Separately, the Policy & Authorization Mega Engine already had the
*vocabulary* for organizations — `Subject.organizationId`/`ResourceRef.
organizationId` (Phase 1A), `organization-access-rule.ts` (Phase 3C), and
an `OrganizationProvider` interface (Phase 18) — all shipped deliberately
unimplemented, because **AYZEN had no `organizations` table at all**. Each
file's own header said so explicitly and named this the blocker.

This phase adds that table and the product surface on top of it: org
accounts (create/invite/roles/ownership transfer), org-wide ("shared")
vault access, and org-admin-managed extension policy — the three things
master plan §7's Phase 8 line names, in that order.

## What was added

### Organizations (schema)
| File | Change |
|---|---|
| `migrations/109_ayzen_organizations.sql` | **New.** `organizations` (name, slug, owner_id), `organization_members` (org_id, user_id, role: owner\|admin\|member, status: pending\|active — same vocabulary `team_members` already uses), `organization_vault_shares` (org-wide vault entity sharing), `organization_extension_policies` (one row per org, owner/admin-configurable). All four idempotent (`IF NOT EXISTS`), matching every other migration in this series. |
| `lib/db/src/schema/organizations.ts` | Drizzle schema for all four tables, exported via `schema/index.ts`. |

### Organization Provider (completing Phase 18)
| File | Change |
|---|---|
| `lib/policy/pip/drizzle-organization-provider.ts` | **New.** `DrizzleOrganizationProvider` — a real implementation of the Phase 18 `OrganizationProvider` interface, reading `organization_members` (active memberships only). Same "never throw, return `[]`" contract the interface already documented. |
| `lib/policy/pip/organization-provider.ts` | Header updated with a short pointer to the real implementation above — the interface itself is unchanged (it was already the right shape). |

**Still honestly unwired:** nothing in the app constructs a
`PolicyInformationPoint` with this provider (or any real provider) on a
live `authorize()` call path yet — see `policy-information-point.ts`'s own
header, unchanged by this phase. `Subject.organizationId` is still
`undefined` on every real request, so `organization-access-rule.ts` still
abstains in practice today. Every route this phase adds is authorized by
its own direct `organization_members` role check (same hand-rolled
leader/member pattern `teams.ts` already uses), not the PDP. Wiring a live
PEP call site to actually consume same-org access via the policy engine —
rather than routes/organizations.ts's own checks — is a follow-up.

### Routes — org accounts
| File | Change |
|---|---|
| `routes/organizations.ts` | **New.** `POST /organizations` (create, creator becomes owner), `GET /organizations` (mine), `GET /organizations/my-invites`, `GET/PATCH/DELETE /organizations/:id`, `POST /organizations/:id/invite` (by username or email), `PATCH /organizations/:id/invites/respond` (accept/decline), `DELETE /organizations/:id/members/:memberId` (manager or self), `PATCH /organizations/:id/members/:memberId/role` (owner only, admin↔member), `POST /organizations/:id/transfer-ownership`, `POST /organizations/:id/leave` (owner blocked — must transfer or delete first). |
| `routes/index.ts` | Registered `organizationsRouter`. |
| `lib/notification-bus.ts` | Added `notifyOrganizationInvited` / `notifyOrganizationRoleChanged`, both under the existing `"warde"` category (master plan §2: Warde is the org-accounts brand) — same bus, same per-user channel preferences, no new plumbing. |

### Shared vaults
| File | Change |
|---|---|
| `routes/organizations.ts` | `POST /organizations/:id/vault-shares` (share an entity you own with every active member of an org at once), `GET /organizations/:id/vault-shares` (decrypted list, for any active member), `DELETE /organizations/:id/vault-shares/:shareId` (sharer or org owner/admin). |
| `routes/vault-shares.ts` | `ENTITY_TABLES`, `VALID_TYPES`, `isValidType` changed from module-private to `export`ed, so `organizations.ts` reuses the exact same entity-type → table/sensitive-fields/label map instead of a second hand-maintained copy (the exact kind of drift `vault-shares.ts`'s own Phase C23-era comment already describes fixing once). |

**Deliberately a separate table/endpoint, not folded into `GET
/vault-shares/received`:** `organization_vault_shares` is genuinely
different from `vault_shares` (one row grants an entire org, not one
recipient), and merging the two into one unified "what's shared with me"
response would mean touching `vault-shares.ts`'s existing, already-tested
per-user resolution query. Kept as its own endpoint this pass; a future
unified view can `UNION` both tables (migration 109's header already
notes both use the same `entity_type` vocabulary for exactly this).

### Managed extension policy
| File | Change |
|---|---|
| `routes/organizations.ts` | `GET /organizations/:id/extension-policy` (any active member), `PUT /organizations/:id/extension-policy` (owner/admin — `disableSeedReveal`, `requireDomainAllowlist`, `allowedDomains`). |
| `routes/vault.ts` | `GET /vault/:id/seed` now also checks: is the caller an active member of *any* organization with `disable_seed_reveal = true`? If so, 403 (`ORG_SEED_REVEAL_DISABLED`) before the existing PIN/reveal-token check even runs. This is real server-side enforcement — not just an Astra UI toggle — since every seed read (web, mobile, or a future Astra autofill) goes through this one endpoint. |

**Astra extension itself not touched this pass.** `require_domain_
allowlist`/`allowed_domains` are stored and returned by the GET endpoint
above, but nothing in `astra-extension/background/` reads them yet — the
extension's own domain-match autofill guard (master plan §9's existing
design principle) is unchanged. Wiring the background script to fetch
and enforce this policy is the natural next step, not invented here.

## What wasn't done / open follow-ups
- **PDP/PEP wiring**: org routes use hand-rolled role checks, not
  `authorize()` — see "Still honestly unwired" above. A future pass could
  construct a `PolicyInformationPoint` with `DrizzleOrganizationProvider`
  and pass it via `enrichment.pip` at a real call site (e.g. the vault
  routes), letting `organization-access-rule.ts` actually fire.
- **Org wallets** (master plan §2/§9's other named piece of "shared
  access, org wallets") — not built. `wallets.ts`/Ryft are untouched;
  an org-scoped wallet is a materially different feature (pooled funds,
  multi-sig-adjacent approval) than the read-access sharing this phase
  ships for vault entities, and deserves its own pass.
- **Cross-app audit log** (§9: "org admins get an audit log of member
  actions across Sylo/Ryft/Verve/Skarn") — not built. `activity_log`
  already exists per-subject (Phase 15B) but has no organization
  dimension yet.
- **Astra background-script enforcement** of `require_domain_allowlist` —
  see above.
- **Frontend** — no `pages/user/organizations.tsx` or admin UI added this
  pass; this phase is backend-only, same posture Phase 7's notification-
  preferences backend originally shipped a UI section for, but org
  management here has no frontend yet at all. `pages/user/settings.tsx`
  is untouched.
- **No `pnpm install`/typecheck run** — same sandbox limitation as every
  prior phase. Every new/edited file's braces and parens were counted and
  balance (checked file-by-file); imports were hand-checked against the
  actual exported symbols in `vault-shares.ts`, `events.ts`, `vault-
  crypto.ts`, and `@workspace/db`'s schema barrel. A real `tsc` pass is
  worth running before treating this as shippable.
