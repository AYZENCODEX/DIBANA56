# AYZEN Astra — v1 (Vault autofill + account status)

Manifest V3 browser extension implementing master plan §3 "Core (v1)":

- Vault autofill for Twitter/X, Discord, Telegram, and recovery-email logins
  (Gmail, Outlook, Yahoo Mail, Proton Mail, iCloud, AOL).
- One-click AYZEN Account login/session status in the toolbar icon + popup.
- Seed phrases, 2FA codes, and backup codes are **never** read or exposed by
  this extension — only login username/password pairs, per the master
  plan's Astra security principle.

No build step — plain JS, loadable as an unpacked extension directly.

## Load it locally

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder
   (`artifacts/astra-extension`).
4. Sign in to your AYZEN Account in a normal tab on `ayzen.tech` (or your
   dev/preview host — see Settings below). The toolbar icon turns from gray
   to indigo once Astra sees a valid session.

## Before `ayzen.tech` DNS exists

Astra reads two settings from its own Options page (right-click the
toolbar icon → **Options**, or the "Settings" link in the popup):

| Setting | Default | Change it to... |
|---|---|---|
| API base | `https://ayzen.tech` | Your Replit/preview URL that serves `/auth/me` and `/vault` |
| Cookie domain | `ayzen.tech` | The exact host if you're not yet on a wildcard `*.ayzen.tech` domain |

These must also be added to `manifest.json`'s `host_permissions` (currently
scoped to `*.ayzen.tech`) if you're testing against a different domain —
Chrome will silently block cookie reads / fetches to hosts outside
`host_permissions` otherwise.

## How autofill works, end to end

1. Content script loads on every page except `*.ayzen.tech` itself, and
   immediately asks the background worker whether this hostname is one
   Astra covers (see `background/vault.js`'s `MATCHERS` list).
2. If yes, it watches the page for password fields (initial scan +
   `MutationObserver`, so it catches Twitter/Discord's client-rendered
   login forms) and draws a small indigo trigger next to each one.
3. Clicking the trigger shows matching vault entries by **username only** —
   the background worker holds the decrypted vault in an in-memory,
   session-only cache (`chrome.storage.session`, wiped on browser close),
   but never sends a password to the content script until...
4. ...the user picks an entry. Only then does the content script request
   that one credential pair, fill both fields via the native-setter +
   `input`/`change` event pattern (needed for React-controlled inputs like
   Discord/Twitter's), and discard the value — nothing lingers in a content
   script variable after the fill.

## What's intentionally NOT in v1

Everything under Astra "Expanded (v2+)" in the master plan — Ryft Connect,
Skarn Watch, Zynth Ask, Verve Price Ping, the investment ticker — is
unbuilt. The extension is feature-flag-ready for that (per §3's
architecture note) in the sense that each of those would be its own
content-script/background module gated the same way vault autofill is
gated on `MATCHERS`, but no scaffolding for them exists yet — add it when
Phase 6 starts rather than guessing at their shape now.

Card-adjacent data autofill (mentioned in §3) has no home yet either — the
current vault schema has no card-like fields; that arrives whenever
Ryft/Verve add one.
