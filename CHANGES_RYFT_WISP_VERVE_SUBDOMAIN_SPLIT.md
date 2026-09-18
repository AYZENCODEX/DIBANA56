# AYZEN Workspace — Ryft / Wisp / Verve Subdomain Split (master plan §7 Phase 3)

Extends the Sylo pattern (`CHANGES_SYLO_SUBDOMAIN_SPLIT.md`) to the next
three apps: same host-based routing, same one deploy, no new build target,
no new database migration. Each app's routes already lived under one or two
existing prefixes in `route-config.tsx`, so — like Sylo — no page had to
move or get renamed.

## What was added

### Frontend
| File | Change |
|---|---|
| `artifacts/ayzen/src/lib/subdomain-app.ts` | Added `ryft`, `wisp`, `verve` entries to `SUBDOMAIN_APPS`. `App.tsx`'s `ProtectedRoute` scope guard and `app-sidebar.tsx`'s `filterGroupsBySubdomain()` both already read this map generically — **zero changes needed in either file**, same as when Sylo's entry was first added. |

### Backend
| File | Change |
|---|---|
| `artifacts/api-server/src/app.ts` | Replaced the single hardcoded `SYLO_HOSTS` redirect block with a small `SPLIT_APP_HOST_CONFIG` table (one row per split app) and a flat hostname→homePath `Map` built once at startup. Same server-side "redirect bare `/` before `index.html` loads" behavior as before, now for `RYFT_HOSTS`, `WISP_HOSTS`, `VERVE_HOSTS` too (each independently configurable, same comma-separated env var pattern, same `<id>.ayzen.tech` default). |

## Route scoping chosen

| App | Home path | In-scope prefixes | Why |
|---|---|---|---|
| **Ryft** | `/wallet` | `/wallet`, `/wallets`, `/finance`, `/admin/tools/wallet` | Wallet + finance/ledger + Investments (master plan §2 — Investments stays a nav tab inside Ryft, not its own brand). `/credits` and `/subscription` deliberately **excluded** — those are Workspace-wide (AYZEN Credits pool, §5), not Ryft-scoped; scoping them to Ryft would strand a Sylo/Wisp/Verve user's ability to top up. |
| **Wisp** | `/mailbox` | `/mailbox`, `/ayzen-email`, `/email-accounts`, `/admin/mail-sending-config` | `/mailbox` is the native mail client (`CHANGES_NATIVE_MAILBOX.md`); `/ayzen-email` is the account-setup/status page, kept in-scope since a new Wisp visitor needs it before a mailbox exists. |
| **Verve** | `/marketplace/hub` | `/marketplace`, `/admin/marketplace`, `/admin/marketplace-categories`, `/admin/marketplace-market-config` | The two admin sub-pages needed their own explicit prefix entries — `hasPrefix()` matches on a `/` boundary, so `/admin/marketplace` alone does **not** cover `/admin/marketplace-categories` (no `/` between `marketplace` and `categories`). |

## Auth — nothing to do here, already generic
Confirmed by reading rather than assuming:
- `scripts/src/seed-oidc-clients.ts` already registers OIDC clients for
  `ryft`, `wisp`, `verve` (and `zynth`) alongside `sylo` —
  `seedClient("ryft", "Ryft", { backchannelLogout: true })` etc.
- `lib/sylo-oidc-config.ts`'s `resolveSyloOidcClientId()` reads
  `getCurrentSubdomainApp().id` generically — it was written to "keep
  producing the correct client_id for whichever [app] it's actually
  running as" the moment a new entry landed in `subdomain-app.ts`. It did.
- `lib/sylo-oidc-rollout-flag.ts`'s `getSyloOidcRolloutFlag(appId)` already
  takes the app id as a parameter, not a hardcoded `"sylo"`.

So Ryft/Wisp/Verve visitors get the same "Sign in with AYZEN" auto-cutover
flow, PKCE round-trip, and backchannel logout Sylo already has — no code
in the OIDC path needed to change for this pass.

## Zynth — deliberately not included
`seed-oidc-clients.ts` registers Zynth's OIDC client too, but there is no
real user-facing route for it yet in `route-config.tsx` — only an admin
config page (`/admin/ai-agent`), not a page an end user would land on.
Adding a `subdomain-app.ts` entry now would scope `zynth.ayzen.tech`
visitors to a `homePath` that doesn't actually serve them anything. Add
Zynth's entry here once a real "Ask Zynth" / AI chat user route exists —
everything else (OIDC client, rollout-flag plumbing) is already waiting
for it.

## What was tested
- Brace/paren balance checked on both edited files (matches the level of
  testing the Sylo pass used — no `node_modules` in this sandbox, so
  `tsc --noEmit` couldn't be run here; worth running for real before
  merging).
- Not tested: actual browser behavior on `ryft.localhost` / `wisp.localhost`
  / `verve.localhost` (no network in this sandbox). Same pre-deploy check
  as the Sylo pass: verify the sidebar filters correctly and an existing
  session is recognized without re-login on each new host.

## What's still ahead
- Zynth's subdomain entry (blocked on a real frontend route existing).
- Phase 4 (Skarn full build-out) and Phase 8 (Warde) — unstarted.
- Actually pointing DNS at `ryft.ayzen.tech` / `wisp.ayzen.tech` /
  `verve.ayzen.tech` and CDN/hosting config — unchanged from Sylo's own
  "still Phase 3" carve-out, now just three more hostnames to point.
