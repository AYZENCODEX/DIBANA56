-- 071_ayzen_project_templates_extend.sql
-- Project Templates extension — folders, usage tracking, and a
-- default-per-project-type slot. Builds on migration 070
-- (ayzen_project_templates) the same incremental way vault_snapshots and
-- dr_test_reports grew across migrations — ALTER, not a rewrite.

-- Free-text grouping so the manager page can bucket templates ("Exchange",
-- "L2 Testnets", "Airdrop Farming"...) instead of one flat list. Nullable —
-- an ungrouped template just shows in a "No folder" bucket.
ALTER TABLE ayzen_project_templates ADD COLUMN IF NOT EXISTS folder TEXT;

-- Bumped by POST /project-templates/:id/apply every time a template is
-- actually applied (either into the create-project form or onto an
-- existing project) — NOT every time it's merely viewed/listed. Lets the
-- manager page show "Used N×" and, eventually, sort by popularity.
ALTER TABLE ayzen_project_templates ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 0;

-- When set, this is THE default template auto-applied when an admin picks
-- this project_type on the create form (see admin/projects.tsx). At most
-- one template can be default for a given project_type — enforced by the
-- partial unique index below; routes/project-templates.ts clears any
-- prior holder before setting a new one, so the index is a safety net, not
-- the primary enforcement path.
ALTER TABLE ayzen_project_templates ADD COLUMN IF NOT EXISTS default_for_project_type TEXT;

CREATE INDEX IF NOT EXISTS ayzen_project_templates_folder_idx
  ON ayzen_project_templates (folder);

CREATE UNIQUE INDEX IF NOT EXISTS ayzen_project_templates_default_type_key
  ON ayzen_project_templates (default_for_project_type)
  WHERE default_for_project_type IS NOT NULL;
