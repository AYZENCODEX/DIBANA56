-- 081_ayzen_oidc_authorization_codes_consumed.sql
-- OIDC Roadmap — Season 2, Phase 3c-e: Single-Use Consumption.
-- Run this once in Supabase SQL Editor. Run AFTER 080.
--
-- Migration 080's own header named this column out loud and deferred it:
--   "there is deliberately NO 'consumed'/'redeemed' column yet ... that is
--   explicitly Phase 3c-e's job ('Atomically consume the code'), which gets
--   to decide HOW a code is invalidated (a status column vs. deleting the
--   row vs. something else) once it's the phase actually implementing that
--   behavior."
-- This is that phase. The decision: a single nullable `consumed_at`
-- TIMESTAMP, not a `status` enum and not row deletion.
--
-- WHY A TIMESTAMP, NOT A STATUS ENUM
-- Migration 078 (Phase 1C) modeled jwt_signing_keys.status as a three-value
-- enum ('active'/'retiring'/'retired') because that table genuinely has
-- three meaningfully different states a row can be read in. An
-- authorization code has exactly two: unused (`consumed_at IS NULL`) or
-- used (`consumed_at IS NOT NULL`) — a boolean's worth of information. A
-- timestamp encodes that same boolean (NULL vs. NOT NULL) while ALSO
-- recording *when* it was redeemed for free, which a bare `consumed BOOLEAN`
-- would not — useful for incident review ("was this code redeemed before or
-- after the reported compromise window") without a second column or a
-- separate audit table.
--
-- WHY NOT ROW DELETION
-- Deleting a row on redemption would make `oidc.code.replay` (the roadmap's
-- own section 5 observability event) undetectable: a replayed request for a
-- code that no longer exists at all is indistinguishable from a replayed
-- request for a code that never existed in the first place, or a typo'd
-- code. Keeping the (still-hashed, still-unusable) row and marking it
-- consumed instead lets Phase 3c's token endpoint tell those apart —
-- `code_hash` still resolves to a real row, it just fails single-use rather
-- than lookup.
--
-- ATOMICITY
-- "Atomically consume" (this sub-phase's own name) is a property of the
-- STATEMENT Phase 3c's token endpoint issues against this column
-- (`UPDATE ... SET consumed_at = now() WHERE code_hash = $1 AND consumed_at
-- IS NULL RETURNING *`, see lib/oidc-authorization-code-consumption.ts),
-- not of the column itself. This migration only has to make that statement
-- possible — a single UPDATE that both checks "is this still unused" and
-- claims it in one round trip needs nothing from the schema beyond the
-- nullable column below; Postgres's own row-level locking during that
-- UPDATE is what actually prevents two concurrent redemption attempts from
-- both winning.
ALTER TABLE oidc_authorization_codes
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP;

-- Supports the token endpoint's replay-detection read path (a second,
-- non-authoritative SELECT purely to decide whether a failed redemption was
-- a genuine replay vs. a code that never existed, for the
-- oidc.code.replay/oidc.token.failed observability split — see
-- lib/oidc-authorization-code-consumption.ts). Partial index (only rows
-- that HAVE been consumed) since that is the only subset this read path
-- ever filters on; unconsumed rows are already found by the code_hash
-- unique index from migration 080.
CREATE INDEX IF NOT EXISTS oidc_authorization_codes_consumed_at_idx
  ON oidc_authorization_codes(code_hash)
  WHERE consumed_at IS NOT NULL;
