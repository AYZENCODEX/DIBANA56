# What's new in this drop (native mailbox + attachments)

This zip is your FULL codebase with the native ayzen.tech mailbox feature
already merged in — extract and overwrite your project, nothing left to
hand-patch.

## Changed / new files
- lib/db/src/schema/users.ts               — + ayzenEmailMode field
- lib/db/src/schema/ayzen-mailbox.ts       — new (+ encryptedContent column for outbound attachments)
- lib/db/src/schema/mail-messages.ts       — new (bug fix: missing mail_messages table)
- lib/db/src/schema/index.ts               — exports the two new schema files
- migrations/036_ayzen_native_mailbox.sql  — new tables + users.ayzen_email_mode
- migrations/037_mail_messages_table.sql   — bug fix: missing mail_messages table
- migrations/038_ayzen_mailbox_attachment_content.sql — new: outbound attachment storage
- artifacts/api-server/src/lib/resend-mail.ts       — Resend API + attachment fetch/send
- artifacts/api-server/src/routes/ayzen-mailbox.ts  — inbox/sent/read/send/claim-native + attachment download
- artifacts/api-server/src/routes/resend-webhook.ts — POST /webhooks/resend/inbound
- artifacts/api-server/src/routes/resend-admin.ts   — admin domain setup
- artifacts/api-server/src/routes/email-routing.ts  — status now returns `mode`; claim/release set ayzenEmailMode
- artifacts/api-server/src/routes/plugins.ts         — registers "Resend Email" plugin slug
- artifacts/api-server/src/routes/index.ts           — registers the 3 new routers
- artifacts/api-server/src/app.ts                    — raw-body carve-out for the Resend webhook
- artifacts/ayzen/src/pages/user/mailbox.tsx          — new: mailbox UI (inbox/sent/read/compose/attachments)
- artifacts/ayzen/src/pages/user/ayzen-email.tsx      — + "Mailbox Mode" card (switch to native / open mailbox)
- artifacts/ayzen/src/lib/route-config.tsx            — registers /mailbox and /mailbox/:id

## Before running
1. Run migrations 036 → 037 → 038 (in that order) via your usual flow.
2. Admin → Plugins → Resend Email: set your Resend API key (or RESEND_API_KEY env var).
3. Call POST /api/admin/resend-email/setup-domain (admin auth) to register + verify
   the domain and auto-push DNS records onto Cloudflare.
4. In the Resend dashboard, add a webhook for `email.received` pointing to
   `https://<your-api-domain>/api/webhooks/resend/inbound`, and put its signing
   secret into the Resend Email plugin config as `webhookSecret`.
5. Users switch to native mode from the AYZEN Email page ("Switch to Native
   Mailbox") or via POST /api/ayzen-email/claim-native.

Full details + API surface: see the SETUP.md that shipped with the earlier
(files-only) drop, or ask me to regenerate it.

---

## Add-on: Folders + Drafts + Trash/Archive (full folder system)

Adds a real folder system on top of the inbox/sent split above: Drafts,
Archive, and Trash as first-class folders (Trash replaces the old
`deleted_at` soft-delete, which just hid a message with no way to see or
restore it), plus user-created custom folders.

### Changed / new files
- lib/db/src/schema/ayzen-mailbox.ts — + `ayzenMailboxFoldersTable` (custom
  folders), + `folder`/`folderId`/`isDraft` columns on messages, +
  `AYZEN_MAILBOX_SYSTEM_FOLDERS` constant
- migrations/039_ayzen_mailbox_folders.sql — new `ayzen_mailbox_folders`
  table + the columns above, with a backfill of existing rows' `folder`
  from their old `direction`/`deleted_at` values
- artifacts/api-server/src/routes/ayzen-mailbox.ts — folder CRUD
  (list/create/rename/delete), `GET /mailbox?folder=`, `PATCH
  /mailbox/:id/move`, two-stage `DELETE /mailbox/:id` (trash, then
  permanent), `DELETE /mailbox/trash/empty`, `POST /mailbox/drafts`,
  `PATCH /mailbox/drafts/:id`, and `POST /mailbox/send` now accepts an
  optional `draftId` to send an existing draft in place
- artifacts/ayzen/src/pages/user/mailbox.tsx — folder chip rail (5 system
  folders + custom folders + "new folder"), rename/delete folder menus,
  move-to-folder menu on every message, Archive/Restore/Delete-forever
  actions, Empty Trash, and compose now supports save-draft /
  autosave-on-close / edit-existing-draft / send-a-draft

### Behavior notes
- Deleting a message moves it to Trash (recoverable via the move menu);
  deleting it again *from* Trash asks for confirmation and permanently
  removes it (row + attachments). "Empty Trash" does the same for every
  message in Trash at once.
- Deleting a custom folder never deletes mail — its messages move to
  Archive and the folder itself goes away.
- Closing the compose dialog (X, backdrop, or Cancel) autosaves a
  non-empty draft instead of discarding it, same as Gmail.
- No migration renumbering was needed — this is 039, since 037 and 038
  were already taken by mail_messages_table and attachment-content.

### Before running
Run migration 039 (after 038) via your usual flow — no other setup steps
beyond what's already above.

---

## Add-on: Spam folder, Snooze system, and quick star/read reactions

Adds a Spam folder (manual report/not-spam, plus rules can already target it
for free), a Gmail-style Snooze system (temporarily pull a message out of
Inbox, it comes back on its own), and per-row quick-toggle buttons for star
and read/unread — previously star/read only worked once a message was
already open.

### Changed / new files
- lib/db/src/schema/ayzen-mailbox.ts — `AYZEN_MAILBOX_SYSTEM_FOLDERS` is now
  `inbox, snoozed, sent, drafts, spam, archive, trash`; + `snoozedUntil`
  column
- migrations/043_ayzen_mailbox_spam_snooze.sql — new: `snoozed_until` column
  + partial index. Spam needs no schema change — it's just a 6th plain
  folder value, same as archive/trash.
- artifacts/api-server/src/routes/ayzen-mailbox.ts —
  - `sweepExpiredSnoozes()`, called at the top of `GET /mailbox`,
    `GET /mailbox/folders`, and `GET /mailbox/unread-summary`: moves any
    message whose snooze has passed back to Inbox for that user, lazily —
    no cron/scheduled job needed.
  - `PATCH /mailbox/:id/snooze` (body `{ until }`, only from Inbox) and
    `PATCH /mailbox/:id/unsnooze`
  - Bulk actions gained `snooze` (body `{ until }`) and `unsnooze`
  - The generic move routes (`PATCH /mailbox/:id/move` and bulk `move`) now
    reject `folder: "snoozed"` as a target — snoozing needs a due date, so
    it only happens through the two routes above
  - Snoozed folder's list is sorted soonest-due-first instead of newest-first
  - `fmt()` now returns `snoozedUntil`
- artifacts/ayzen/src/pages/user/mailbox.tsx —
  - Spam + Snoozed added to the folder rail, icons, and every folder-driven
    menu (Move-to menus exclude Snoozed as a direct target, same reasoning
    as above)
  - New per-row quick actions: a Star toggle and a Read/Unread toggle button
    that act without opening the message, plus a Snooze button (Inbox rows)
    or Unsnooze button (Snoozed rows)
  - New `SnoozeMenu` component (presets: Later today / Tomorrow morning /
    This weekend / Next week, plus a custom date-time picker) — used by the
    row action, the open-message header, and the bulk action bar
  - Thread detail header gained Snooze/Unsnooze and Report spam/Not spam
    buttons (spam only offered on inbound mail, snooze only from Inbox)
  - Bulk action bar gained Snooze/Unsnooze and Spam/Not-spam buttons
  - Snoozed folder rows show a "Until <date>" badge

### Behavior notes
- Snoozing is only offered from Inbox (matches Gmail); once snoozed, the
  message physically moves to folder = 'snoozed' with `snoozedUntil` set —
  it reappears in Inbox automatically once that passes, or immediately if
  you hit Unsnooze first.
- Spam has no automatic detection — this is manual only (Report spam /
  Not spam), same scope as Gmail's user-driven button, not a filter service.
  Existing mail rules can already route matching inbound mail straight to
  Spam, since it's just another folder name to them.
- Star and read/unread already worked fully once a message was open; this
  add-on's new part is the quick-toggle buttons directly on list rows.

### Before running
Run migration 043 (after 042) via your usual flow — no other setup steps.
