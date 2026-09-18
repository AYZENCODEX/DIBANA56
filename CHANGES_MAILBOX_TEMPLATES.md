# What's new in this drop (Compose Templates)

Adds a "canned responses" system to the native ayzen.tech mailbox: named
templates (subject + rich-text body) a user can save once and insert into
any New Message / Reply / Forward, instead of retyping the same boilerplate
every time. Distinct from the existing per-user Signature (which
auto-inserts into every fresh message) — a user can save any number of
templates, and picks one explicitly per compose.

## Changed / new files
- lib/db/src/schema/ayzen-mailbox.ts        — + `ayzenMailboxTemplatesTable`
- migrations/056_ayzen_mailbox_templates.sql — new table + unique
  (user_id, lower(name)) index
- artifacts/api-server/src/routes/ayzen-mailbox.ts — + CRUD routes:
  `GET/POST /ayzen-email/mailbox/templates`,
  `PATCH/DELETE /ayzen-email/mailbox/templates/:id`
- artifacts/ayzen/src/pages/user/mailbox.tsx — compose box gets a
  "Templates" dropdown (Insert / Save as template / Manage templates), a
  standalone `SaveTemplateDialog`, a `TemplatesManagerDialog` (list +
  create/edit/delete), and a "Templates" button in the mailbox header for
  managing templates outside of compose

## Behavior notes
- `bodyHtml` is stored encrypted at rest the same way message bodies are
  (`encryptField`/`decryptField`), since a template can carry the same kind
  of sensitive boilerplate a mail body can.
- Inserting a template only fills the Subject field if it's currently
  blank (so applying a template mid-reply/forward doesn't clobber a
  subject that's already there); the body is always inserted at the
  cursor, same affordance as "Insert signature".
- Template names are unique per user (case-insensitive) — saving a
  duplicate name gets a 409 with a clear message, same pattern as Labels.
- "Save as template" is available any time the compose box has a subject
  or body typed; it doesn't touch attachments or recipients — only the
  subject/body get saved.

## Before running
Run migration 056 (after 055) via your usual flow — no other setup steps.
