# What's new in this drop (Project Templates — Search + Preview)

Applied on top of `ayzen-full-project-15v-email-accounts-restore` (which
already had the base + extension Project Templates work merged in at
migrations 070/071 — nothing renumbered this round). Three things:

1. **Search/filter** in every template picker (create dialog, existing-
   project apply, and the manager page)
2. **Preview before apply** — every "apply a template" action now shows a
   diff (current value → template value) with an explicit confirm, instead
   of applying immediately on click
3. **UI polish** — the preview/diff is a small shared component so all
   three surfaces look and behave identically, plus a "Preview" (eye) icon
   on the manager page so you can inspect a template's fields without
   opening the full edit form

## New file
- `artifacts/ayzen/src/components/projects/template-preview.tsx` — shared
  by all three surfaces:
  - `buildTemplateDiff(templateData, current)` — one row per key the
    template actually sets, `from`/`to` formatted with the same
    option-label lookup (`PROJECT_CREATE_FIELDS`) the create form uses, so
    e.g. `costType: "free"` shows as "Free" not the raw value
  - `TemplatePreviewModal` — the diff view + Cancel/Apply buttons; a
    `readOnly` mode (no Apply button, no from→to arrows, just current
    template values) for the manager page's plain "Preview" action

## Changed files
- `artifacts/api-server/src/routes/projects.ts` — **bug fix**:
  `GET /projects/:id` now also returns `category`/`durationType`/
  `difficulty`/`costType`. These are raw-SQL-only columns (not in
  `projectsTable`'s Drizzle definition — same gap category as the
  `xpPrice`/POST-PATCH fix from the base drop), so the typed select was
  silently dropping them — meaning "Apply Template" previews on an
  existing project would have diffed against `undefined` for those four
  fields instead of what the project actually has. Found while wiring the
  preview and fixed alongside it.
- `artifacts/ayzen/src/pages/admin/projects.tsx`:
  - Load Template dropdown gets a search box (auto-shown once there are
    more than 3 templates) filtering by name/folder
  - clicking a template now opens the preview modal instead of applying
    immediately; confirming applies + tracks usage (silently — the modal
    itself was the confirmation, so no extra toast)
  - the existing auto-default-on-projectType-select behavior is
    unchanged — still applies silently with a toast, no preview, since
    it's meant to be a zero-click convenience
- `artifacts/ayzen/src/pages/admin/project-detail.tsx` — same treatment
  for the "Apply Template" dropdown: search box + preview-before-apply,
  diffed against the project's current (now-complete) field values
- `artifacts/ayzen/src/pages/admin/project-templates.tsx` (manager page):
  - search bar (name/description/folder) + a folder filter dropdown above
    the card grid; empty states distinguish "no templates at all" from
    "no matches for this search/filter"
  - each card gets a "Preview" (eye) button — opens the same modal in
    read-only mode

## Behavior notes
- The diff only lists keys the template actually sets — a template that
  only touches `tier` and `xpName` shows a 2-row diff, not all 14 possible
  keys blank.
- "Unchanged" rows (current already equals the template's value) are shown
  dimmed with a single value instead of a from→to arrow, and don't count
  toward the "N of M fields will change" summary line.
- Search is a plain case-insensitive substring match on name/folder(/
  description on the manager page) — no fuzzy matching, kept intentionally
  simple.

## Before running
No new migration this round — purely route/frontend changes. Redeploy as
usual.
