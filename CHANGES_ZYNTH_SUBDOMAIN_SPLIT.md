# AYZEN Workspace — Zynth Subdomain Split (master plan §7 Phase 3, closing it out)

`CHANGES_RYFT_WISP_VERVE_SUBDOMAIN_SPLIT.md` shipped three of Phase 3's four
apps and explicitly deferred the fourth: *"Zynth is deliberately not
included... there is no real user-facing route for it yet... Add Zynth's
entry here once a real 'Ask Zynth' / AI chat user route exists."* This pass
builds that route and adds the entry. **Phase 3 is now fully complete.**

## What was already there (didn't need building)
- `POST /api/ai/chat` + `GET /api/ai/models` (`routes/ai.ts`) — the full
  DB-connected chat backend, including the `ACTION:` block protocol
  (create_vault / complete_task / get_password / add_roi).
- `components/ai-chat.tsx` — a complete 400+ line chat UI with model
  picker, action-card execution, quick prompts — already wired to that
  backend. It just had nowhere to live except as a floating bottom-right
  widget mounted globally in `App.tsx`, which isn't a "page" a subdomain
  visitor can be redirected to.
- Zynth's OIDC client, already seeded (`seed-oidc-clients.ts`) and waiting.

So the actual gap was narrower than "build an AI assistant" — it was "give
the existing assistant a dedicated page."

## What was added

| File | Change |
|---|---|
| `artifacts/ayzen/src/components/ai-chat.tsx` | Added a `standalone` prop. When true, the same component docks full-size in its parent instead of floating bottom-right, skips the collapse/toggle chrome (a dedicated page has nothing to collapse to), and the *floating* instance hides itself while `/assistant` is the active route (via `wouter`'s `useLocation`) so the two don't stack. All chat/action logic is untouched and shared between both render modes. |
| `artifacts/ayzen/src/pages/user/assistant.tsx` | **New file.** Thin page — header + `<AiChat standalone />` filling the rest of the viewport. This is Zynth's `homePath`. |
| `artifacts/ayzen/src/lib/route-config.tsx` | Registered `{ path: "/assistant", component: Assistant }` in `USER_ROUTES`. |
| `artifacts/ayzen/src/lib/subdomain-app.ts` | Added the `zynth` entry to `SUBDOMAIN_APPS` — `homePath: "/assistant"`, `routePrefixes: ["/assistant", "/admin/ai-agent"]`. `App.tsx`'s scope guard and `app-sidebar.tsx`'s subdomain filter both read this map generically — no changes needed in either, same as every app since Sylo. |
| `artifacts/api-server/src/app.ts` | Added `{ id: "zynth", hosts: process.env.ZYNTH_HOSTS ?? "zynth.ayzen.tech", homePath: "/assistant" }` to `SPLIT_APP_HOST_CONFIG` — same generic table Ryft/Wisp/Verve/Skarn/Warde already use, so the bare-`/` server-redirect works for free. |
| `artifacts/ayzen/src/components/layout/app-sidebar.tsx` | Added a "Zynth AI" nav link (`/assistant`, `Bot` icon) to the Social group in `USER_NAV` (the main end-user sidebar) and `TEAM_LEADER_NAV`. Not added to `ADMIN_NAV`/`MODERATOR_NAV`/`DEV_NAV` — staff already have the floating widget on every page they use, including admin pages `/assistant` isn't scoped to open a redundant dedicated link for. |

## Why dock the existing component instead of writing a new chat UI
Rewriting `ai-chat.tsx`'s message list, action-card rendering, and model
picker for a "page" version would have meant two copies of ~400 lines
drifting out of sync the next time either one changes. A `standalone` prop
keeps it one component, one set of bugs to fix, one place the `ACTION:`
protocol is parsed.

## Why the floating widget had to be suppressed on `/assistant`
Without the location check, visiting `/assistant` would show the docked
chat AND the floating bubble in the corner — two independent `AiChat`
instances with two independent message histories, confusing regardless of
which one a click landed in. The check lives in the *floating* instance
only (`!standalone && location === "/assistant"`), placed after all hook
calls (not before) to avoid a conditional-hook-count React error as the
route changes under the same globally-mounted instance.

## What was tested
- Brace/paren/bracket balance checked on every edited file (`node_modules`
  isn't in this sandbox, so `tsc --noEmit` couldn't run — same caveat as
  every prior pass in this repo).
- Not tested: actual browser behavior — that the floating widget correctly
  disappears/reappears when navigating to/from `/assistant`, that the
  docked layout doesn't clip on small viewports, and that a
  `zynth.ayzen.tech`/`zynth.localhost` visitor lands on `/assistant` and
  stays scoped to it. Same pre-deploy check as every other subdomain split
  in this repo: verify sidebar filtering and session recognition on the
  new host before trusting it.

## What's still ahead
- Actually pointing DNS at `zynth.ayzen.tech` and CDN/hosting config —
  unchanged carve-out from every prior split pass.
- Astra v2's "Zynth Ask" (browser-extension right-click → ask Zynth,
  master plan §3) can now target this same `/api/ai/chat` endpoint once
  Phase 6 starts — nothing here blocks that, but nothing here builds it
  either.
- Phase 5 (AYZEN Credits consumption layer) is the next unstarted phase in
  roadmap order, though Phase 4 (Skarn) and Phase 8 (Warde) were already
  done ahead of their nominal roadmap position per the existing
  `CHANGES_SKARN_SUBDOMAIN_SPLIT.md` / `CHANGES_WARDE_SUBDOMAIN_SPLIT.md`.

**Phase 3 (master plan §7) is now complete**: Ryft (with Investments live
under `/finance/investments`), Wisp, Verve, and now Zynth are all split
onto their own subdomains.
