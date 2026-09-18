# AYZEN Workspace — Telegram Webhook Mode + Phase 4 Open-Items Resolution

## Scope, as agreed
Following `CHANGES_SKARN_SUBDOMAIN_SPLIT.md`'s finding that Skarn was
already shipped (as "Protocols") rather than an unbuilt product, this pass
was scoped to exactly two things, per your call:
1. Build the one genuinely-missing piece the master plan's Phase 4 called
   for: the Telegram bot's `/api/telegram/webhook` endpoint, self-flagged
   `"not-wired"` in `routes/telemetry.ts`.
2. Resolve — not expand — the open items the prior Skarn pass left
   sitting. No new scope (RBAC wiring, `/teams` folding) was pulled in.

## What was actually missing
The Telegram bot itself is *not* new work — `lib/telegram.ts` already runs
a full bot (account linking, `/projects`, `/tasks`, `/leaderboard`,
task-verification alerts, new-project/new-task pings, KYC alerts, admin
broadcast) in **long-polling** mode, wired into Skarn/Protocols
(`notifyNewProject`, `notifyEnrolledUsersNewTask`) and several other apps
(Finance invoice reminders, vault health digests, backup alerts). The one
thing that didn't exist anywhere in the codebase was a **webhook** ingress
— `routes/telemetry.ts` already listed `POST /api/telegram/webhook` as a
route name with `status: "not-wired"`, i.e. a documented, unbuilt gap.

Polling works fine for a single instance, but it has real costs a webhook
doesn't: it holds an open long-poll connection per process (two instances
racing for it is exactly the 409-conflict handling already in
`registerHandlers`'s `polling_error` listener), and it's extra outbound
traffic the process makes to Telegram rather than Telegram pushing to us.
Webhook mode is what you'd want once there's more than one API instance
behind a load balancer, or on host platforms that penalize long-lived
outbound connections.

## What was added

### `lib/telegram.ts`
| Change | Detail |
|---|---|
| `TELEGRAM_WEBHOOK_URL` / `TELEGRAM_WEBHOOK_SECRET` env vars | Opt-in — unset means **zero behavior change**, the bot starts in polling mode exactly as before. This is the same "explicit env var or the old fallback stays" convention `services/uptime-bot.ts`'s `resolvePublicUrl()` already uses. |
| `initTelegramBot()` split into `initWebhookMode()` / `initPollingMode()` | `initTelegramBot()` now just picks a mode based on whether `TELEGRAM_WEBHOOK_URL` is set. `initPollingMode()` is the original function body, unchanged, renamed. |
| `initWebhookMode()` | Refuses to start in webhook mode without `TELEGRAM_WEBHOOK_SECRET` set (falls back to polling instead, logged as an error) — an unauthenticated webhook endpoint would let anyone POST fake Telegram updates. Registers the same `registerHandlers(b)` polling mode uses — `onText`/`callback_query`/`message` all fire off `bot.processUpdate()`, so the handler set is identical regardless of transport. |
| `handleWebhookUpdate(update, secretTokenHeader)` | Exported for the route to call. Verifies the header against `TELEGRAM_WEBHOOK_SECRET` and that the bot is actually in webhook mode before touching `processUpdate()`; returns `false` otherwise so the route can 401 without ever feeding untrusted data into the bot. |
| `getTelegramTransportMode()` | Exposes `"polling" \| "webhook" \| null` for the status route. |
| `stopTelegramBot()` | Now tears down whichever transport is actually active (`deleteWebhook()` vs `stopPolling()`) instead of always assuming polling. |

### `routes/telegram.ts`
| Change | Detail |
|---|---|
| `POST /telegram/webhook` | New. No AYZEN session applies — the caller is Telegram, not a logged-in user — so it's guarded by the `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes back on every call, checked inside `handleWebhookUpdate()`. Wrong/missing secret → 401, nothing touches the bot. Valid → `processUpdate()` is called and the route acks `200` immediately (Telegram retry-storms a slow/non-2xx webhook). |
| `GET /telegram/status` | Now also returns `transport: "polling" \| "webhook" \| null` so it's visible from the same health check that already reports online/offline. |

### `routes/telemetry.ts`
`telegramWebhook`'s self-reported status flipped from `"not-wired"` to
`"wired"` — this registry is a living gap-tracker (see the other
`"not-wired"` rows still in the file for wallet NFT/DeFi analysis, unrelated
to this pass), so leaving it stale after building the thing it was tracking
would just reintroduce the gap it exists to catch.

## Deploying webhook mode (optional — polling keeps working if skipped)
1. Set `TELEGRAM_WEBHOOK_URL` to the bot's public endpoint, e.g.
   `https://api.ayzen.tech/api/telegram/webhook`.
2. Set `TELEGRAM_WEBHOOK_SECRET` to a random string (this is *not* the bot
   token — generate a separate value, e.g. `openssl rand -hex 32`).
3. Restart the API process. Startup log will read `"Telegram bot started
   (webhook mode)"` instead of `"(polling mode)"`; `GET /api/telegram/status`
   confirms via its new `transport` field.
4. Leave both env vars unset anywhere polling is preferred (e.g. a single
   dev instance) — no code change needed to switch back.

## Phase 4 open items — resolved
Revisiting the three items `CHANGES_SKARN_SUBDOMAIN_SPLIT.md` left open:

1. **`/teams` folding into Skarn's scope** — left **out**, per your explicit
   instruction at the time ("আপাতত বাদ দাও" — leave it out for now). No
   code change this pass; scope stays exactly the `USER_NAV`/`ADMIN_NAV`
   "Protocols" group, as previously shipped.
2. **Zynth's subdomain entry** — still blocked on a real routed page for
   the AI chat surface (`components/ai-chat.tsx` is a global floating
   widget mounted in `App.tsx`, not a page with a `homePath`). Unrelated to
   Skarn/Telegram; no action taken or needed here.
3. **DNS/hosting for `skarn.ayzen.tech`** — infrastructure, not code. Same
   status as every other split app (Sylo/Ryft/Wisp/Verve): the OIDC client,
   host-routing config, and now the Telegram webhook route are all ready on
   the code side; pointing the actual subdomain at the deployment is a step
   you take in your DNS/hosting provider, not something this sandbox can do.

With the webhook gap closed and these three explicitly dispositioned
(not silently dropped), Phase 4 — as scoped for this pass — is done.

## What was tested
- Brace/paren/bracket balance checked on both edited files (506/506
  parens, 272/272 braces on `lib/telegram.ts`; 77/77 parens, 45/45 braces
  on `routes/telegram.ts`) — same constraint as every prior pass in this
  series (no `node_modules` in this sandbox, so no `tsc`/`tsx` run).
- **Not tested**: an actual webhook round-trip against Telegram's servers,
  or a real `TELEGRAM_WEBHOOK_SECRET` mismatch producing a 401 in a live
  process. Pre-deploy checklist: set the two env vars against a real
  `TELEGRAM_BOT_TOKEN`, restart, confirm `GET /api/telegram/status` reports
  `"transport": "webhook"` and `"online": true`, then send `/status` to the
  bot from Telegram and confirm a reply arrives.
- Method-name casing on `setWebhook`/`deleteWebhook` was matched to the
  casing already used (and presumably working) at the pre-existing
  `b.deleteWebhook(...)` call site in `initPollingMode()`, rather than
  introduced fresh — there's no `node_modules` here to check
  `@types/node-telegram-bot-api@0.64.15` directly against, so this defers
  to the codebase's own established, already-shipped usage instead of
  guessing.
