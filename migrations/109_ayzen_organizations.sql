-- 109_ayzen_organizations.sql
-- AYZEN Workspace — Phase 8: Organization Accounts (master plan §2/§7 Phase 8,
-- "Enterprise/Team tier — org accounts, shared vaults, managed extension
-- policy" — the Warde layer CHANGES_WARDE_SUBDOMAIN_SPLIT.md's own "Where
-- this leaves the master plan's Skarn/Warde split" section named as still
-- genuinely unbuilt: that pass claimed Warde's existing *farming-team*
-- product surface (`teams`/`team_members`); this migration is the separate
-- org-account layer master plan §2/§9 describes — org-wide RBAC, shared
-- vault access, and org-admin-managed Astra extension policy. Distinct
-- concept from `teams` on purpose: a farming team and an organization can
-- overlap in membership but are not the same relationship (§2's own list
-- keeps "Skarn — farming teams" and "Warde — org accounts" as two lines).
--
-- Run this once in Supabase SQL Editor. Run AFTER 108.
--
-- IDEMPOTENT — every statement is safe to re-run (IF NOT EXISTS), matching
-- every other migration in this directory.
--
-- This also gives the Policy & Authorization Mega Engine's Phase 03C
-- `organization-access-rule.ts` and Phase 18 `OrganizationProvider`
-- interface (lib/policy/pip/organization-provider.ts) their first real
-- backing table — both shipped "additive, unwired" (their own file headers
-- say so explicitly) specifically because, until now, AYZEN had no
-- organizations table at all. See lib/policy/pip/drizzle-organization-
-- provider.ts (Phase 8) for the real `OrganizationProvider` implementation
-- this table backs.

CREATE TABLE IF NOT EXISTS organizations (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  slug         TEXT UNIQUE,
  owner_id     INTEGER NOT NULL,          -- users.id — the org's current owner (ownership transfers via PATCH, not a role change)
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_organizations_owner ON organizations(owner_id);

-- One row per (organization, user). 'status' mirrors team_members' own
-- 'pending'/'active' vocabulary so an invite is just a row that hasn't
-- been accepted yet, not a second parallel invites table.
CREATE TABLE IF NOT EXISTS organization_members (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL,      -- users.id
  role             TEXT NOT NULL DEFAULT 'member',   -- 'owner' | 'admin' | 'member'
  status           TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active'
  invited_by       INTEGER,               -- users.id of whoever sent the invite (NULL for the founding owner row)
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  updated_at       TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_user ON organization_members(user_id, status);

-- "Shared vaults" (master plan §2's phrase, verbatim) — a vault entity
-- shared with an ENTIRE organization at once, rather than one
-- vault_shares row per recipient user (migration 03x's per-user model,
-- routes/vault-shares.ts, unchanged by this migration). Same entity_type
-- vocabulary ('local' | 'entity' | 'kyc' | 'game') as vault_shares, so a
-- future unified "what can I see" view can UNION both tables without a
-- vocabulary translation step.
CREATE TABLE IF NOT EXISTS organization_vault_shares (
  id               SERIAL PRIMARY KEY,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type      TEXT NOT NULL,         -- 'local' | 'entity' | 'kyc' | 'game'
  entity_id        INTEGER NOT NULL,
  shared_by        INTEGER NOT NULL,      -- users.id — must own the entity at share-creation time (route-enforced, not a DB constraint, same trust boundary vault_shares.owner_id already draws)
  field_permissions TEXT,                 -- JSON { field: 'view'|'edit' } — NULL = whole-entity view, same convention as vault_shares.field_permissions
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMP NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMP,
  UNIQUE(organization_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_organization_vault_shares_org ON organization_vault_shares(organization_id, is_active);
CREATE INDEX IF NOT EXISTS idx_organization_vault_shares_entity ON organization_vault_shares(entity_type, entity_id);

-- Managed extension policy (master plan §2's third Phase-8 line item,
-- "managed extension policy") — one row per org, org owner/admin
-- configurable. Deliberately a single-row-per-org settings table (like
-- Phase 3's mail-sending-config singleton) rather than per-member, since
-- master plan §9's own design principle is org-wide guardrails, not a
-- per-member exception system.
CREATE TABLE IF NOT EXISTS organization_extension_policies (
  organization_id       INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  disable_seed_reveal   BOOLEAN NOT NULL DEFAULT false,  -- blocks GET /vault/:id/seed server-side for every member, not just an Astra UI toggle — see routes/vault.ts
  require_domain_allowlist BOOLEAN NOT NULL DEFAULT false,
  allowed_domains       TEXT NOT NULL DEFAULT '[]',      -- JSON string[] — read by Astra's background script when require_domain_allowlist is true (see CHANGES doc's "not done" section for wiring status)
  updated_by            INTEGER,          -- users.id of whichever org admin last changed this
  updated_at            TIMESTAMP NOT NULL DEFAULT now()
);
