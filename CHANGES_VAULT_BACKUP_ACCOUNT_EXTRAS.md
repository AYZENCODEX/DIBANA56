# CHANGES — Feature 15m: Vault Backup Coverage Expansion — Account & Platform Extras

Closes the remaining coverage gap in the Vault Backup blob: the last set of
per-user tables this app tracks that weren't part of `/vault/snapshot/export`
or the automatic backup cron yet.

## The gap

`buildVaultSnapshotPayload()` already bundled Vault/Local/KYC/Game entities
and everything hanging off them (15h/15i), the native mailbox/projects/
tasks/finance/profile (15d), the Wallet Hub (15e), the activity trace (15f),
and Emergency Access (15j). Seven more account-scoped tables were still
outside every backup:

- **`notifications`** — in-app notification history.
- **`referrals`** — both directions: referrals this user made, and
  referrals this user was the recipient of.
- **`subscriptions`** — this user's billing/plan state (plan, status,
  CoinGate order id/url, lifetime flag).
- **`support_tickets` / `support_messages`** — this user's support threads,
  including agent replies on those threads.
- **`api_keys`** — developer API keys, metadata only.
- **`passkey_credentials`** — WebAuthn credentials.
- **`polymarket_trades`** — real-money Polymarket trade history placed
  through this user's AYZEN wallet.

## What changed

**Backend**
- `lib/vault-snapshot-extra.ts` — added `gatherAccountExtrasSnapshot()`,
  returning:
  - `notifications` — capped to the most recent `ACCOUNT_EXTRAS_LIMIT`
    (2000) rows, same unbounded-growth reasoning as the activity trace's
    `ACTIVITY_TRACE_LIMIT`.
  - `referralsMade` / `referralsReceived` — `referrer_id` and `referred_id`
    respectively, same "both directions matter" pattern
    `sharesOwned`/`sharesReceived` and `grantsOwned`/`grantsAsContact`
    already use.
  - `subscription` — single row or `null` (`user_id` is unique on this
    table).
  - `supportTickets` / `supportMessages` — tickets this user opened, plus
    every message on those tickets (joined via `ticket_id`, same child-table
    pattern the finance/mailbox-attachment queries already use).
  - `apiKeys` — **`key_hash` stripped**, same reasoning
    `gatherUserProfileSnapshot()` already uses for `password_hash`: a hash
    of a bearer secret has no place in a blob that can eventually be
    re-decrypted by anyone holding the export password.
  - `passkeys` — included in full; `credential_id`/`public_key` are the
    public half of a key pair (see `schema/passkeys.ts`'s doc comment), not
    a secret.
  - `polymarketTrades` — local audit/display log of trades placed through
    this user's wallet.

  Every query uses the same `.catch(() => [])` degrade-to-empty pattern as
  the rest of this file.
- `routes/vault-snapshot.ts` — `buildVaultSnapshotPayload()` now also calls
  `gatherAccountExtrasSnapshot()` and nests the result under a new
  `accountExtras` key (same shape/treatment as `finance`/`profile`/
  `emergencyAccess`: included in every backup, counted, **not**
  auto-restored — see below). Snapshot `version` bumped to `6`. New
  `accountExtrasCount` returned alongside the other per-surface counts,
  threaded through `storeSnapshotRow()` / `POST /vault/snapshot/export` /
  `GET /vault/snapshots` / the activity-log payload, same as
  `entityCoverageCount`/`emergencyAccessCount` before it.
- `lib/vault-backup-schedule-cron.ts` — `runVaultBackupSchedule()` now
  threads `accountExtrasCount` through to `storeSnapshotRow()` too, so
  scheduled/automatic backups carry the same count as manual exports.
- `migrations/064_ayzen_vault_backup_account_extras.sql` — adds
  `account_extras_count` to `vault_snapshots` (applied by hand against
  Supabase, same convention as migrations 055–063: not wired into
  `index.ts`'s boot-time `MIGRATIONS` array).
- `lib/db/src/schema/vault-snapshots.ts` — adds the matching
  `accountExtrasCount` column.

**Frontend**
- `lib/vault-snapshot-api.ts` — `StoredSnapshot` gains an optional
  `accountExtrasCount`.
- `pages/user/vault-snapshot.tsx` — the Stored Backups list row now shows a
  `+N account` badge (tooltip: "Notifications, referrals, subscription,
  support, API keys, passkeys, Polymarket trades") next to the existing
  entities/wallets/attachments/automatic badges, whenever a backup carries
  any of this surface.

## Why not auto-restored

Same category as `finance`/`profile`/`activity`/`entityCoverage`/
`emergencyAccess`: a notification, a support thread, or a billing/
subscription record is exactly the kind of "replay old workflow state as
if it just happened" case those are already excluded for. Re-inserting a
user's own `api_keys`/`passkey_credentials` rows with fresh ids would also
just create dead, unusable credential records — the actual bearer secret
behind an API key was never stored in the first place (only its hash,
which is deliberately excluded from the backup too), and a passkey
fundamentally needs its physical authenticator present to ever be created
— there's no "restore" that could work for either. Backed up for
reference/manual disaster recovery from the raw JSON, same treatment every
other reference-only surface above already gets.

## Not touched

- `otp_codes`, `encryption_keys`, `vault_security` (Vault's own PIN/2FA/
  password hashes) — all credential/key material in the same category as
  `password_hash`, deliberately excluded, same reasoning as the account
  profile's own exclusion list.
- `settings`, `config_entries`, `dev_nav_items`, `page_layouts`,
  `broadcasts`, `admin_wallet_ledger`, `uptime_pings` — platform-wide admin
  data, not this user's own data, same reasoning the projects/tasks
  catalogs were already excluded for in Feature 15d.
