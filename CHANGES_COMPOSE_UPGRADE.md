# What's new in this drop (compose upgrade: Bcc, signature, rich editor, draft autosave)

This zip is your FULL codebase with the compose upgrade merged into the
native ayzen.tech mailbox on top of the threading drop — extract and
overwrite your project, nothing left to hand-patch.

## The problem this fixes
- Compose had no Bcc field at all — only To and Cc.
- No per-user signature — every message started from a blank body.
- The message body was a plain `<textarea>` — no bold/italic/lists/links,
  and nothing ever sent an `html` body to the backend even though the
  mailbox schema (and the thread viewer) has supported one since the
  native-mailbox drop. Every sent/drafted message was plain text only.
- Draft saving was manual-only: a "Save draft" button, plus a save-on-close
  when you back out of the compose dialog. Nothing saved *while* you were
  still typing, so a crash or an accidental full page reload mid-compose
  lost everything since the last explicit save.

## Changed / new files
- migrations/041_ayzen_mailbox_compose_upgrade.sql — new: adds
  `bcc_addr` to `ayzen_mailbox_messages`, and `ayzen_mailbox_signature` +
  `ayzen_mailbox_signature_enabled` to `users`
- lib/db/src/schema/ayzen-mailbox.ts — + `bccAddr` column
- lib/db/src/schema/users.ts — + `ayzenMailboxSignature`,
  `ayzenMailboxSignatureEnabled` columns
- artifacts/api-server/src/lib/resend-mail.ts — `sendAsAyzenUser()` now
  accepts and sends `bcc`
- artifacts/api-server/src/routes/ayzen-mailbox.ts —
  - `fmt()` now returns `bcc`
  - both draft routes (`POST`/`PATCH /mailbox/drafts`) and the send route
    (`POST /mailbox/send`) accept, store, and forward `bcc`
  - new `GET`/`PATCH /ayzen-email/mailbox/signature` — read/update the
    signature HTML and its auto-insert flag
- artifacts/api-server/src/routes/email-routing.ts — `GET
  /ayzen-email/status` now also returns `mailboxSignature` and
  `mailboxSignatureEnabled`, so the mailbox page's existing status fetch
  picks up signature state without an extra round-trip
- artifacts/ayzen/src/components/mail/rich-text-editor.tsx — new: a small
  contentEditable-based rich text editor (bold/italic/underline,
  bulleted/numbered lists, links, clear formatting) plus a `textToHtml()`
  helper. No editor library dependency — none was already in this
  workspace and there's no network access to add one, so this uses
  `document.execCommand`, the same approach mail clients have relied on
  for "simple HTML compose" for years and which is still universally
  supported for exactly this.
- artifacts/ayzen/src/pages/user/mailbox.tsx —
  - `ComposeDialog` gained a Bcc field (mirrors the existing Cc show/hide
    pattern), swapped the plain `<textarea>` for `RichTextEditor`, and now
    sends both `html` and a derived plain-text fallback (`stripHtml(html)`)
    on every draft save and send
  - new debounced autosave: 1.5s after the last change to any field (To,
    Cc, Bcc, Subject, body), the draft is saved automatically — same
    pattern Gmail/Docs use. A small indicator next to "Save draft" shows
    Unsaved / Saving… / Draft saved
  - signature auto-insert: a brand new compose, reply, or forward gets the
    saved signature inserted automatically when "Auto-insert" is on;
    editing an existing draft never auto-inserts (the draft already
    reflects whatever the user left it as). A manual "Insert signature"
    button in the attachments toolbar row covers everything else (added it
    back after removing it, editing a draft that predates having one, etc.)
  - new `SignatureDialog`, opened from a "Signature" button in the mailbox
    header — rich-text signature editor + an Auto-insert toggle, saved via
    the new signature endpoint
  - the thread detail view shows `Bcc <address>` alongside `Cc` when
    present (only the sender's own mailbox ever sees this, same as any
    real mail client)

## Behavior notes / known simplifications
- Bcc is exactly what it sounds like: stored on your own copy of the
  message so you can see who you blind-copied, but never exposed to the
  other recipients — Resend receives it on the one outbound API call and
  it never appears in headers anyone else sees.
- The rich editor uses `document.execCommand`, which browsers have
  deprecated in favor of newer editing APIs but still fully support for
  this exact use case (basic formatting commands in a contentEditable).
  If a proper editor library becomes available in this workspace later,
  swapping it in only touches `rich-text-editor.tsx` — nothing else
  references `execCommand` directly.
- Signature auto-insert content-checks are simple: opening a fresh compose
  with a signature counts as "not blank" for the isBlank/autosave check,
  same as if you'd typed something. In practice this means closing a
  freshly-opened compose that has an auto-inserted signature (and nothing
  else typed) will save a signature-only draft, the same tradeoff Gmail
  makes when a default "Sent from my ..." signature is on.
- Legacy drafts saved before this drop have no `htmlBody` — editing one
  seeds the rich editor from its plain-text body via `textToHtml()`
  (escaped, newlines converted to `<br>`) rather than losing it.

## Before running
1. Run migration 041 (after 040) via your usual flow.
2. No new env vars, plugin config, or webhook changes — this is additive
   on top of the existing Resend Email setup.

## Verified
- Manual review pass over every touched route and component for type
  consistency (no `node_modules`/network access in this environment to run
  a full `pnpm install && tsc --noEmit`, unlike the previous two drops —
  worth running that yourself before deploying, same as always, but
  nothing here changes shapes that were already flowing through the
  existing threading/attachments code paths).
