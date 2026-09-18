# AYZEN Astra v1 — Browser Extension (master plan §3 "Core (v1)")

Phase 2's second deliverable (§7: "Split Sylo onto its own subdomain +
ship AYZEN Astra v1 (autofill only)"). Sylo's subdomain split shipped
earlier (`CHANGES_SYLO_SUBDOMAIN_SPLIT.md`); this closes out the rest of
Phase 2 — the extension didn't exist yet.

## What was added

New workspace package: **`artifacts/astra-extension`** — a Manifest V3
browser extension, plain JS (no build step, loads unpacked directly).

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — `cookies`/`storage`/`scripting`/`activeTab`/`alarms` permissions, `host_permissions` scoped to `*.ayzen.tech`, content script on every other origin. |
| `background/config.js` | `apiBase` / `cookieDomain` settings (chrome.storage.sync), mirroring the server's `AYZEN_COOKIE_DOMAIN`/`SYLO_HOSTS` env-var pattern for pre-DNS dev/testing. |
| `background/session.js` | Reads the shared `ayzen_session` cookie via `chrome.cookies` (works despite `httpOnly`), confirms it's live via `GET /auth/me`. |
| `background/vault.js` | Fetches `GET /vault`, caches in `chrome.storage.session` (in-memory, 5 min TTL, wiped on browser close), matches entries to a hostname (Twitter/X, Discord, Telegram, known webmail providers) via a `MATCHERS` table. |
| `background/background.js` | Toolbar badge (indigo = signed in, gray = signed out), refreshes on `chrome.cookies.onChanged` + a 5-min `chrome.alarms` tick, and is the sole message handler content scripts/popup talk to. |
| `content/field-detect.js` + `content-script.js` | Finds password fields (+ their paired username field, including split multi-step login flows), draws a small trigger + dropdown, fills via the native-setter/`input`+`change` event pattern React-controlled forms (Discord, Twitter) need. |
| `popup/*`, `options/*` | Toolbar popup (status + current-site matches + manual vault refresh) and a settings page for `apiBase`/`cookieDomain`. |
| `icons/*.png` | Generated placeholder toolbar icons (indigo = signed in, gray = signed out) at 16/32/48/128px — worth swapping for real brand art before store submission, functionally complete either way. |

## Design decisions worth knowing about

- **Why plain JS, no bundler:** matches the master plan's own call for v1 —
  "Sylo-only v1 ships fast." Nothing here needs React/TypeScript to work
  correctly; adding a build step is a later, additive step if the codebase
  wants type-checking parity with the rest of the workspace (there's a
  `typecheck` script stub in `package.json` already wired into
  `pnpm run typecheck` at the root, currently a no-op).
- **Why the password never reaches the content script until click:** the
  background worker's vault cache is the only place a decrypted credential
  sits in memory. The dropdown the user sees is built from `username`-only
  match summaries; only the literal entry the user clicks triggers a
  `FILL_CREDENTIAL` round-trip that returns one password, used immediately.
  This satisfies §9's Astra security principle a layer deeper than what it
  explicitly asked for (which was about seed phrases specifically) — same
  logic extended to every credential Astra handles.
- **Why seed phrases/2FA/backup codes are structurally absent, not just
  filtered:** `background/vault.js`'s `MATCHERS` table only ever reads
  `*Username`/`*Password` field pairs off a vault entry. There's no code
  path that touches `encryptedSeedPhrase`, `*2fa`, or `*BackupCode` at all
  — nothing to accidentally leak later if this file is edited without
  re-reading this note.
- **Why webmail matching is provider-allowlisted rather than "any site with
  a password field":** every vault entry has an `email`/`emailPassword`
  pair (it's the account's recovery email), but there's no per-entry
  "which site is this for" field to match against — allowlisting real
  webmail providers (Gmail, Outlook, Yahoo, Proton, iCloud, AOL) keeps
  matches precise instead of surfacing recovery-email credentials as a
  candidate autofill on unrelated login forms across the web.
- **Why `chrome.storage.session` for the vault cache, not `local`:**
  `session` storage is explicitly non-persistent (cleared when the browser
  closes) and was added to MV3 specifically for this kind of short-lived
  sensitive cache — decrypted credentials never touch disk.

## Config needed to activate

- `host_permissions` in `manifest.json` already covers `*.ayzen.tech` /
  `ayzen.tech` — no change needed once that DNS is live.
- Before then: Options page → set `apiBase` to the dev/preview URL serving
  `/auth/me` + `/vault`, and `cookieDomain` to that single host (see the
  package's `README.md` for the full walkthrough) — you'll also need to
  add that host to `host_permissions` in `manifest.json` directly, since
  Chrome enforces that list regardless of the in-extension setting.

## What was tested

- All new `.js` files pass `node --check` (syntax only — no DOM/Chrome APIs
  in this sandbox to run against).
- `manifest.json` validated as well-formed JSON.
- Not tested: actual browser load/behavior (no Chrome available here).
  Before relying on this: load it unpacked per the README, sign in on a
  real `ayzen.tech`/preview host, and confirm the trigger appears on a
  Twitter/Discord/Telegram login form and that a click fills both fields
  without the page's own JS immediately clearing them (React re-renders
  are the usual failure mode here — the native-setter approach used should
  handle it, but only a real browser confirms it).

## What's still ahead (not this pass)

- Astra v2 (Ryft Connect, Skarn Watch, Zynth Ask, Verve Price Ping,
  investment ticker) — Phase 6, unbuilt, no scaffolding added prematurely.
- Real brand icon art (current icons are generated placeholders).
- Chrome Web Store / Edge Add-ons listing and submission — this pass is
  the loadable-unpacked extension only, per §3's distribution note that
  says Store submission comes after v1's core is stable.
- Firefox port (MV3 core needs to be stable first, per §3).
- The Phase 2 Sylo-split "known rough edge" noted in
  `CHANGES_SYLO_SUBDOMAIN_SPLIT.md` (9 hardcoded `/dashboard` redirects in
  `login.tsx`) is unrelated to this pass and still open.

**Phase 2 (master plan §7) is now complete**: Sylo subdomain split
(shipped earlier) + Astra v1 autofill (this pass). Phase 3 (Ryft/Wisp/
Verve/Zynth subdomain splits) is next per the roadmap.
