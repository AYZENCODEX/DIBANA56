# CHANGES — Feature 15l: Vault Backup — Google Drive / Dropbox Delivery

Extends the "Also deliver a copy to" destination on Automatic Backups
(previously: store / email / webhook) with two more: the user's own
Google Drive or Dropbox account.

This feature was developed as a standalone patch against an earlier
snapshot of this repo and has now been merged in by hand, since several
of the files it touches (`vault-backup-delivery.ts`,
`vault-backup-schedule-cron.ts`, `routes/vault-backup-schedule.ts`,
`routes/index.ts`, both `lib/db/src/schema/index.ts` and
`vault-backup-schedules.ts`, `lib/jwt.ts`, and the two `ayzen` frontend
files) had all diverged since the patch was cut. Every touched file was
merged by hand rather than overwritten, so unrelated changes made to
this repo in the meantime are preserved.

## What changed

**New**
- `migrations/063_ayzen_vault_backup_cloud_connections.sql` — new
  `vault_backup_cloud_connections` table (one row per user+provider: OAuth
  tokens + a display-only account label +, for Drive, the backup folder
  id). Applied by hand against Supabase, same convention as migrations
  055–062 (not wired into `index.ts`'s boot-time `MIGRATIONS` array).
- `lib/db/src/schema/vault-backup-cloud-connections.ts` — the matching
  Drizzle schema, re-exported from `schema/index.ts`.
- `lib/vault-backup-cloud.ts` — everything provider-specific: OAuth
  authorize-URL builders, code↔token exchange, token refresh, account-label
  lookup, the one-time "AYZEN Vault Backups" Drive folder creation, and the
  actual `uploadToGoogleDrive()` / `uploadToDropbox()` calls. Full
  ASSUMPTIONS list in the file header (upload endpoint choice, size limits,
  refresh-grant shape) — no live Google/Dropbox app to test against was
  available, so double-check these before relying on it in production.
- `routes/vault-backup-cloud.ts` — `GET /vault/backup/cloud` (connection
  status for both providers, never returns tokens), `GET
  /vault/backup/cloud/:provider/connect` (returns `{ url }` — see below for
  why this is JSON, not a server redirect), `GET
  /vault/backup/cloud/:provider/callback` (unauthenticated — the browser
  lands here straight from Google/Dropbox; exchanges the code, stores the
  connection, redirects back into the app), `DELETE
  /vault/backup/cloud/:provider` (disconnect). Wired into `routes/index.ts`.
- `lib/jwt.ts` — added `signOAuthState()`/`verifyOAuthState()`, reusing the
  existing session-token signing secret to produce a short-lived (10 min),
  tamper-proof OAuth `state` param carrying `{ userId, provider }` through
  the redirect round-trip to the provider and back.

**Changed**
- `lib/vault-backup-delivery.ts` — `DeliveryTarget.destination` widened to
  include `CloudProvider`; new `deliverSnapshotByCloud()` dispatches to
  `uploadToGoogleDrive`/`uploadToDropbox` and logs the attempt to
  `vault_backup_deliveries`, same as the existing email/webhook functions.
- `routes/vault-backup-schedule.ts` — `DESTINATIONS` now also accepts
  `"google_drive"` / `"dropbox"`. Saving a schedule with one of these never
  requires a connection to already exist (that's checked at run time, so
  connect-order never blocks saving the rest of the schedule).
- `lib/vault-backup-schedule-cron.ts` — `destination` cast widened
  accordingly; no other change needed since `deliverSnapshot()` already
  dispatches generically.
- `lib/db/src/schema/vault-backup-schedules.ts` — doc comments updated for
  the two new destination values.
- Frontend: `lib/vault-snapshot-api.ts` (new `CloudProvider`/
  `CloudConnectionStatus` types + `listCloudConnections()` /
  `connectCloudProvider()` / `disconnectCloudProvider()`), `pages/user/
  vault-snapshot.tsx` (Google Drive/Dropbox added to the destination
  `<Select>`; a Connect/Connected/Disconnect block shown under it; toast +
  URL cleanup for the `?cloudConnected=`/`?cloudError=` the callback
  redirects back with; delivery-history icon handles the new destinations).

## Why the connect step is JSON, not a server-side redirect

This app authenticates via a bearer token (`Authorization` header — see
`middlewares/auth.ts`), not a session cookie. A plain browser navigation to
`GET /connect` can't carry that header, so `requireAuth` would reject it if
`/connect` itself tried to `res.redirect()` into Google/Dropbox. Instead
`/connect` is a normal authenticated JSON call (`customFetch`, header
attached) that returns `{ url }`; the frontend does the actual navigation
(`window.location.href = url`) itself. The provider's OAuth `state` param
is what then carries `userId` through to the (necessarily unauthenticated)
`/callback` route.

## Required setup (not done by this change)

Both providers need a real registered OAuth app before "Connect" will work:

- **Google Drive**: a Google Cloud project with the Drive API enabled and
  an OAuth 2.0 Web application client.
  `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
  `GOOGLE_DRIVE_REDIRECT_URI` (must exactly match what's registered —
  `<APP_URL>/api/vault/backup/cloud/google_drive/callback`).
- **Dropbox**: a Dropbox App Console app with the `files.content.write`
  scope. `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`,
  `DROPBOX_REDIRECT_URI` (`<APP_URL>/api/vault/backup/cloud/dropbox/callback`).

If a provider's env vars aren't set, its `/connect` endpoint returns a
clear 501 instead of redirecting into a broken flow, and the UI shows "isn't
set up on this server yet" instead of a Connect button.

## Merge notes / verification done

- `pnpm install` succeeded against the existing lockfile.
- `pnpm run typecheck:libs` (root `tsc --build`, covers `lib/*` including
  the new schema) passes clean.
- `artifacts/api-server` and `artifacts/ayzen` typecheck clean for every
  file this feature touches — the two real type errors this merge
  introduced (`req.params.provider` being `string | string[]` in Express'
  types) were fixed by wrapping in `String(...)`, matching the convention
  already used elsewhere in this codebase (e.g. `vault-attachments.ts`).
- The remaining `tsc -p tsconfig.json --noEmit` output in both packages
  (mostly `TS6305` project-reference build-order noise and pre-existing
  `TS7006`/`TS18046` implicit-`any`/unknown-`err` issues) is pre-existing
  baseline noise present throughout the rest of the codebase, unrelated to
  this feature — confirmed by grepping for it in files this change never
  touched (`vault.ts`, `projects.ts`, `teams.tsx`, etc.).
- One unrelated line from the original patch (`RestoreTableKey` gaining an
  `"attachments"` member in `vault-snapshot-api.ts`) was intentionally
  **not** merged in — it belongs to a different feature branch the patch
  was cut from and is out of scope here.
