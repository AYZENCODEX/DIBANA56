# OIDC Roadmap — Season 3 follow-on: "Login with AYZEN" button on the main domain

## What
The main AYZEN app (`ayzen.tech` / `workspace.ayzen.tech`) now offers a
"Login with AYZEN" button on its own `/login` page, alongside the existing
email/password, magic-link, and passkey options — Google-style optional SSO,
not a replacement for the credential form. Clicking it runs the exact same
Authorization Code + PKCE round-trip against this provider's own
`/oidc/authorize` that Sylo/Ryft/Wisp/Verve/Zynth already use for their
subdomain auto-cutover (Season 3, Phase 5b) — just self-referential (the
issuer and the client share an origin) and started by an explicit click
instead of an automatic redirect.

## Why this design
Every piece of client-side OIDC machinery (`oidc-client.ts`,
`sylo-oidc-login.ts`, `oidc-callback.tsx`, `sylo-oidc-callback.ts`) was
already generic over "whichever first-party app this bundle is currently
scoped to" — `resolveSyloOidcClientId()` just had nowhere to route on the
main domain (it fell back to the literal `"sylo"` constant, dead code in
practice since nothing called the OIDC login path there). So this is almost
entirely additive:

- **New first-party client, `workspace`** (`scripts/src/seed-oidc-clients.ts`):
  registered like the five subdomain apps, but with both
  `https://ayzen.tech/oidc/callback` and `https://workspace.ayzen.tech/oidc/callback`
  as redirect URIs (and matching post-logout URIs), since the main app isn't
  scoped to a single `<id>.ayzen.tech` host the way the others are. Public
  client, PKCE-only, same as every other seeded entry.
- **`WORKSPACE_OIDC_CLIENT_ID` constant + updated `resolveSyloOidcClientId()`**
  (`lib/sylo-oidc-config.ts`): now resolves to a detected subdomain app's id
  when one exists (unchanged), to `"workspace"` in any other real-browser
  context (the actual fix), and only falls back to the literal `"sylo"`
  constant outside a browser entirely (unchanged, still what the Phase 5a-f
  test suite exercises).
- **The button itself** (`pages/login.tsx`): calls the existing
  `startSyloOidcLogin("/dashboard")` unchanged — no new login-start or
  callback logic needed, since the resolver above is the only thing that
  was main-domain-blind. Gated to `signin` tab, no detected subdomain app,
  and no in-flight `oidcReturnTo` transaction (that case means this page IS
  already the credential-entry step of some OTHER client's OIDC attempt;
  offering a second, competing OIDC button there would just be confusing).

## Follow-up: backchannel logout extended to every first-party client
`routes/oidc-backchannel-logout.ts` and `lib/oidc-logout-propagation.ts`'s
`resolveBackchannelLogoutTargets()` were already fully generic over any
registered `client_id` (verified by reading both — the `aud` check matches
against a real row, nothing Sylo-specific in the code path). Only the seed
data scoped this to Sylo alone. `scripts/src/seed-oidc-clients.ts` now
registers a `backchannelLogoutUri` for Ryft/Wisp/Verve/Zynth (their own
`<id>.ayzen.tech/oidc/backchannel-logout`, same shape as Sylo's) and for
the new `workspace` client (`https://ayzen.tech/oidc/backchannel-logout`,
matching its bare-domain redirect/post-logout URIs). No route/dispatch
code changed — this is a seed-data-only completion.

`scripts/src/test-seed-oidc-clients.ts` updated to match: expects six
seeded clients instead of five, checks `workspace`'s two-origin URI set
separately from the five `<id>.ayzen.tech` subdomain clients, and now
asserts every seeded client (not just Sylo) carries a
`backchannelLogoutUri` pointing at its own origin.

Verified everything else in the "remaining OIDC work" list was already
complete in this codebase (stale info, not actually missing):
- **7d (consent revocation)** — `routes/oidc-connected-apps.ts`: list +
  revoke + token-revocation cascade (`revokeAllTokensForClientAndUser`) +
  backchannel dispatch, all wired.
- **7e (scope re-prompt)** — `lib/oidc-consent-scope-superset.ts`'s
  `evaluateScopeCreep()` is called from both `oidc-authorize.ts`'s consent
  gate and `oidc-consent.ts`'s own info/allow handlers.
- **9b/9c/9d/9e** — `routes/admin-oidc-clients.ts`: edit, create/delete
  (first-party-scoped), approve/suspend (with `revokeAllTokensForClient()`
  + per-affected-user backchannel dispatch on both suspend and delete),
  and a full audit log (migration 093) wired into all four write routes.
- Migrations 089/090 (the numbering gap noted earlier) — confirmed no code
  anywhere references those numbers or depends on schema they'd have
  added; this is a skipped/abandoned migration number, not a missing
  feature, so nothing to build.

## Not touched
- `/oidc/authorize`, `/oidc/token`, `/oidc/userinfo`, consent, discovery,
  admin client list — all provider-side routes work unchanged for any
  registered first-party client, `workspace` included.
- Sylo/Ryft/Wisp/Verve/Zynth's own auto-cutover behavior — their
  `resolveSyloOidcClientId()` branch (a detected subdomain app) is
  untouched.
- `oidc-callback.tsx` / `sylo-oidc-callback.ts` — both already call
  `getSyloOidcClientConfig()` fresh at callback time with no client-id
  parameter of their own, so they automatically pick up `"workspace"` on
  the main domain the same way login-start does, with zero changes.
