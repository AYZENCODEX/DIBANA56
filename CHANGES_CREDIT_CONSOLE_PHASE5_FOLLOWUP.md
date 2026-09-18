# PHASE 5 follow-up — Admin Credit Console + expanded metered actions

Builds on `services/credit-meter.ts` (the original Phase 5 consumption
layer). Two things added:

1. **Admin credit console** (`routes/admin-credit-console.ts`) — admins can
   now view every metered action and reprice/waive it without a deploy.
2. **Nine new metered actions**, wired into the actual route handlers, per
   request: vault entity view + credential access (Sylo), mail view/send/
   template (Wisp), wallet create/transaction (Ryft), project enroll + task
   submit (workspace-level).

## New DB objects (migration `107_ayzen_credit_action_pricing.sql`)

- `credit_action_pricing` — one row per action an admin has repriced or
  toggled. No row = use the code default in `METERED_ACTIONS`. Nothing
  pre-seeded.
- `credit_transactions.action_key` (nullable) — lets usage debits/refunds
  say which metered action they came from, so admin usage stats don't have
  to parse the free-text `notes` column.

## `services/credit-meter.ts` changes

- `MeteredAction["app"]` gained `"sylo"` and `"workspace"`.
- `METERED_ACTIONS` gained: `sylo.vault_entity_view` (1cr),
  `sylo.credential_access` (5cr), `wisp.mail_view` (1cr), `wisp.mail_send`
  (2cr), `wisp.template_use` (2cr), `ryft.wallet_create` (3cr),
  `ryft.wallet_tx` (5cr), `workspace.project_use` (2cr),
  `workspace.task_submit` (2cr).
- `getMeteredAction()` is now **async** and resolves the code default
  merged with any `credit_action_pricing` override (15s in-memory cache,
  invalidated immediately on an admin write). `requireCreditBalance`,
  `hasCreditBalance`, and `chargeCredits` all now await it — an admin price
  change takes effect on the very next request, no restart needed.
- `enabled: false` on an override waives the fee (effective cost 0). It
  never blocks the action — consistent with the master plan's §5 "tiers
  aren't feature walls" principle. `chargeCredits` short-circuits on
  cost === 0 with no ledger row, so waived actions don't spam the log.
- New `getEffectiveActions()` (list with overrides applied — powers both
  `GET /credits` and the admin console) and `invalidateActionPricingCache()`.
- `routes/credits.ts`'s `GET /credits` now serves `getEffectiveActions()`
  instead of the raw static map, so the price shown to users always
  matches what `chargeCredits()` will actually deduct.

## Admin credit console API (`routes/admin-credit-console.ts`, `requireAdmin`)

| Endpoint | What it does |
|---|---|
| `GET /admin/credits/actions` | Every action + code default + override + effective cost, grouped by app |
| `PATCH /admin/credits/actions/:key` | Set `cost` and/or `enabled` for an existing action key. Can't invent new keys — new metered endpoints stay a code change |
| `DELETE /admin/credits/actions/:key` | Clear the override, revert to code default |
| `GET /admin/credits/usage` | Real spend per action from `credit_transactions` (charge count + total credits), sorted by spend |

## Newly metered endpoints (charge-on-success, same two-step pattern as the original Phase 5 integrations)

| Route | Action key | Cost |
|---|---|---|
| `GET /vault/:id` | `sylo.vault_entity_view` | 1 |
| `GET /vault/:id/seed` | `sylo.credential_access` | 5 |
| `GET /ayzen-email/mailbox/:id` | `wisp.mail_view` | 1 |
| `POST /ayzen-email/mailbox/send` | `wisp.mail_send` | 2 |
| `POST /ayzen-email/mailbox/templates` | `wisp.template_use` | 2 |
| `POST /wallets` | `ryft.wallet_create` | 3 |
| `POST /wallets/:id/send`, `POST /wallets/:id/withdraw` | `ryft.wallet_tx` | 5 |
| `POST /projects/:id/enroll` | `workspace.project_use` | 2 |
| `POST /tasks/:id/submit` | `workspace.task_submit` | 2 |

Every one of these follows the existing rule: `requireCreditBalance(...)` is
a pre-flight check only (after every existing auth/ownership gate on that
route — never reordered ahead of them), and `chargeCredits(...)` is called
only once the action has actually succeeded (row inserted / tx broadcast /
message durably queued), never before. A 404/409/validation failure never
touches the ledger. Each response includes a `_credits: { charged,
newBalance } | null` field, same shape the original Phase 5 integrations
(`ai.ts`, `marketplace.ts`) already return.

## Known tension with the master plan (§5), by design of this request

The master plan states vault view / basic wallet / basic mail should never
be metered — this follow-up deliberately meters vault entity view and mail
view (both priced low, at 1 credit) because that was explicitly requested.
Worth revisiting the price — or waiving it via the new admin console — if
routine browsing volume makes 1 credit/view feel punitive in practice.

## Not included in this pass

- No frontend/admin UI screens — API layer only.
- Skarn and Astra still have no route files in this codebase (per the
  master plan, Skarn is Phase 4 / Astra v2 is Phase 6), so their metered
  actions (`skarn.automation_run`, `astra.premium_widget`) stay defined in
  `METERED_ACTIONS` but unwired, same as before this change.
