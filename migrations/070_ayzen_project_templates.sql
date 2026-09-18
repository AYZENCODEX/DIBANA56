-- 070_ayzen_project_templates.sql
-- Project Templates — one-click prefill for the "Initialize New Protocol"
-- admin form (artifacts/ayzen/src/pages/admin/projects.tsx).
--
-- An admin/moderator saves a named template once (e.g. "Exchange Campaign",
-- "L2 Airdrop", "Testnet Grind") capturing everything on PROJECT_CREATE_FIELDS
-- *except* the per-project identity fields (name, description, social links,
-- media, funding/reward numbers, deadline) — those still get typed fresh
-- every time. Picking a template in the create dialog just merges `data`
-- into the current form state; nothing is written to `projects` until the
-- admin still hits "Initialize Project" themselves.
--
-- `data` is a JSON-stringified partial of CreateForm (same string-in
-- convention as projects.tutorial_steps/badges) rather than individual
-- columns — the field set on the create form has already changed shape
-- several times (Phase 4/7A/12/26 all added fields to it), and a template
-- is allowed to carry a subset; a rigid column-per-field schema would need
-- a migration every time the form does. Applying a template is purely a
-- frontend merge, so this stays intentionally schema-light.
CREATE TABLE IF NOT EXISTS ayzen_project_templates (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- JSON-stringified partial<CreateForm> — category/subcategory/projectType,
  -- tier/experienceLevel/durationType/difficulty/costType, xpName/xpPrice,
  -- tutorialLink/tutorialSteps, badges. See routes/project-templates.ts for
  -- the exact allow-list of keys accepted on write.
  data TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- One name per template set, case-insensitive — same "no two entries an
-- admin can't tell apart in the picker" convention as
-- ayzen_mailbox_templates_user_name_key, just not scoped to a single user
-- since templates here are shared across the whole admin/moderator team.
CREATE UNIQUE INDEX IF NOT EXISTS ayzen_project_templates_name_key
  ON ayzen_project_templates (lower(name));

-- Backs "list all templates" (picker dropdown + manager page), most
-- recently updated first.
CREATE INDEX IF NOT EXISTS ayzen_project_templates_updated_idx
  ON ayzen_project_templates (updated_at DESC);
