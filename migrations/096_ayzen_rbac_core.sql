-- 096_ayzen_rbac_core.sql
-- AYZEN Policy & Authorization Mega Engine — Phase 02: RBAC.
-- Run this once in Supabase SQL Editor. Run AFTER 095.
--
-- Creates the four tables the roadmap's Phase 02 section names: roles,
-- permissions, role_permissions, user_roles. Matches
-- lib/db/src/schema/rbac.ts exactly (see that file's header for the full
-- design rationale: no DB-level FK constraints, permission-key wildcard
-- shape, why parent_role_key references a role's `key` and not its `id`,
-- and — most importantly — why the existing `users.role` column is left
-- completely untouched by this migration).
--
-- DRIZZLE SCHEMA, NOT RAW-`pool` — unlike the OIDC-family tables added
-- since migration 088 (see e.g. 093's header), this one DOES get a
-- `lib/db/src/schema` mirror. Reason: this table's readers/writers are
-- `artifacts/api-server/src/lib/policy/rbac/*` (this same phase), which is
-- itself typed, reusable library code meant to be called from many future
-- call sites (routes, admin console, tests) — the OIDC precedent's
-- raw-`pool` idiom fit code with one or two known call sites in a single
-- request/response cycle; RBAC's permission-resolution path does not have
-- that shape.
--
-- IDEMPOTENT — every statement is safe to re-run (CREATE ... IF NOT EXISTS,
-- ON CONFLICT DO NOTHING for the seed rows) so this migration is safe to
-- accidentally run twice, matching every other file in this directory.

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  parent_role_key TEXT,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_key_idx ON roles(key);

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS permissions_key_idx ON permissions(key);

CREATE TABLE IF NOT EXISTS role_permissions (
  id SERIAL PRIMARY KEY,
  role_id INTEGER NOT NULL,
  permission_key TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS role_permissions_role_id_idx ON role_permissions(role_id);
CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_role_id_permission_key_idx
  ON role_permissions(role_id, permission_key);

CREATE TABLE IF NOT EXISTS user_roles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL,
  granted_by INTEGER,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS user_roles_user_id_idx ON user_roles(user_id);
CREATE INDEX IF NOT EXISTS user_roles_role_id_idx ON user_roles(role_id);
CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_id_role_id_idx ON user_roles(user_id, role_id);

-- ── Seed: system roles matching the three legacy `users.role` strings ──────
-- `middlewares/auth.ts` already treats these as a hierarchy today
-- (requireDev accepts "dev" OR "admin"; requireAdmin accepts only "admin";
-- everyone gets "user"-level access once logged in) — parent_role_key makes
-- that hierarchy explicit and machine-readable for the Phase 02 role
-- resolver's inheritance walk, without changing any existing check.
INSERT INTO roles (key, name, description, parent_role_key, is_system)
VALUES
  ('user', 'User', 'Base authenticated AYZEN user. Matches the legacy users.role = ''user'' default.', NULL, TRUE),
  ('dev', 'Developer', 'Developer-tier access. Matches the legacy users.role = ''dev'' value. Inherits every ''user'' permission.', 'user', TRUE),
  ('admin', 'Administrator', 'Full administrative access. Matches the legacy users.role = ''admin'' value. Inherits every ''dev'' permission.', 'dev', TRUE)
ON CONFLICT (key) DO NOTHING;

-- ── Seed: illustrative permission catalog entries ───────────────────────────
-- The roadmap's own Phase 02 examples, verbatim (Sylo = the AYZEN vault
-- product, Ryft = the AYZEN finance product — both real first-party AYZEN
-- clients, see lib/db/src/schema/oidc-clients.ts's header). This is a
-- starting catalog, not an exhaustive one — Phase 02 proves the
-- product.resource.action model end-to-end; enumerating every AYZEN
-- module's full permission surface is left to whichever future work
-- actually wires a PEP check at each of those routes (Phase 19+), so each
-- addition can be reviewed against the route it is meant to guard instead
-- of being guessed at up front.
INSERT INTO permissions (key, description)
VALUES
  ('sylo.vault.read', 'Read Sylo vault entries.'),
  ('sylo.vault.update', 'Modify Sylo vault entries.'),
  ('ryft.payment.create', 'Create a Ryft payment/ledger entry.'),
  ('ryft.payment.approve', 'Approve a Ryft payment.'),
  ('admin.user.manage', 'Manage AYZEN user accounts (ban/suspend/role changes).')
ON CONFLICT (key) DO NOTHING;

-- ── Seed: baseline role → permission grants ────────────────────────────────
-- 'user' can read/update their own Sylo vault and create Ryft payments.
-- 'dev' adds nothing here yet (inherits 'user' via parent_role_key) — no
-- roadmap-named dev-only permission exists yet, so nothing is invented.
-- 'admin' gets the global wildcard, matching requireAdmin's current
-- "role === 'admin' can do anything" behavior exactly (see
-- middlewares/auth.ts) — Phase 02 does not narrow existing admin access,
-- only makes it expressible in the new model.
INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, p.permission_key
FROM roles r
CROSS JOIN (VALUES ('sylo.vault.read'), ('sylo.vault.update'), ('ryft.payment.create')) AS p(permission_key)
WHERE r.key = 'user'
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, 'ryft.payment.approve'
FROM roles r
WHERE r.key = 'dev'
ON CONFLICT (role_id, permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_key)
SELECT r.id, '*'
FROM roles r
WHERE r.key = 'admin'
ON CONFLICT (role_id, permission_key) DO NOTHING;
