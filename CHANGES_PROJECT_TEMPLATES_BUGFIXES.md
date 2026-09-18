# Project Templates — Top 3 Bug Fixes

Applied on top of `ayzen-full-project-with-templates-strong.zip`
(search + preview round). No schema changes, no migration.

## 1. Data-integrity bug — clearing a default wasn't atomic with the save
**Where:** `artifacts/api-server/src/routes/project-templates.ts`, POST and
PATCH `/project-templates`.

**Bug:** setting `defaultForProjectType` ran as two separate statements —
clear the previous holder, *then* insert/update the new row. If the
insert/update failed afterward (most likely: the name already exists →
409), the clear had already committed. Result: **no template** was left
holding that type's default, even though nothing new was actually saved —
a silent data loss on a failed request.

**Fix:** both statements now run inside one `db.transaction(...)` (same
pattern already used elsewhere, e.g. `routes/ayzen-mailbox.ts`), so a
failed insert/update rolls the clear back with it. Removed the now-unused
standalone `clearExistingDefault()` helper.

## 2. Race condition — default-template auto-apply could silently never fire
**Where:** `artifacts/ayzen/src/pages/admin/projects.tsx`.

**Bug:** `handleFormChange` set `autoDefaultTried.current = true` the
instant `projectType` was picked — even if the templates list (fetched
async in `openCreate`) hadn't finished loading yet. Since the flag is a
one-shot "already tried this session" guard, picking a project type
quickly (very plausible — it's often the first field touched) meant the
default-template feature silently never fired for the rest of that
dialog session, even after the fetch resolved a moment later.

**Fix:** the auto-apply logic moved out of `handleFormChange` into a
`useEffect` keyed on `[showCreate, templates, form.projectType]`, which
only proceeds (and only then marks the ref) once `templates` is actually
loaded — so it correctly fires the moment both the templates list and a
matching `projectType` are present, in whichever order they arrive.
`handleFormChange` itself is back to a plain `setForm` wrapper.

## 3. Type inconsistency — badges/tutorial steps broke the create-form UI
**Where:** `artifacts/api-server/src/routes/project-templates.ts`,
`POST /project-templates/from-project/:projectId`.

**Bug:** a template saved via "Save this project as template"
(`admin/project-detail.tsx`) pulled `tutorial_steps`/`badges` straight
from the raw project row as JSON-encoded **strings** (however Postgres
had them stored). A template saved via "Save current as template" from
the live create-form (`admin/projects.tsx`) stores these as real
**arrays**, since that's what the form state holds. The two sources
produced different shapes for the same fields — applying a
from-an-existing-project template back onto the create form handed the
Tutorial Steps editor and badge tag-input a string instead of an array,
breaking that part of the UI.

**Fix:** added a small `parseJsonArray()` helper in the `from-project`
route that parses these two fields into arrays before they're passed to
`pickTemplateData` — so every template, regardless of source, stores
`tutorialSteps`/`badges` the same way.

## Not changed
Nothing else in the Project Templates surface (schema, other routes, the
manager page, the preview component) needed to change for these three —
each fix is contained to its file.
