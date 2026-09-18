-- 091_ayzen_oidc_clients_registration_status.sql
-- OIDC Roadmap — Season 4, Phase 8c: Pending/Unverified State + Abuse
-- Prevention.
-- Run this once in Supabase SQL Editor. Run AFTER 090.
--
-- Phase 8a shipped a working `POST /oidc/register` with no gate at all —
-- that file's own header documented this explicitly as a known,
-- documented mid-roadmap gap ("a client created via 8a is immediately
-- usable... until 8c lands"). This migration is 8c's own column: a
-- three-state `registration_status` (`'pending'` | `'approved'` |
-- `'suspended'`) that `lib/oidc-client-validation.ts`'s
-- `validateOidcClientId()` (this same pass) now enforces on every
-- `/oidc/authorize` and `/oidc/token` request.
--
-- DEFAULT IS 'pending', BUT EVERY EXISTING ROW IS BACKFILLED TO 'approved'
-- — these are two different values on purpose, not an inconsistency:
--   - New rows going forward (from `POST /oidc/register`, Phase 8a) should
--     default to `'pending'` — an unreviewed, dynamically-registered
--     client is exactly what 8c's own roadmap text says needs a human
--     admin's approval (Phase 9d, not yet built) before it can be used.
--   - Every row that ALREADY EXISTS at the moment this migration runs is,
--     by construction, one of two things: a first-party client Season
--     1-3's own seed script created (Sylo/Ryft/Wisp/Verve/Zynth —
--     already fully trusted, `is_first_party = TRUE`, has been in active
--     production use since long before this column existed), or a
--     dynamically-registered client from Phase 8a that a real caller
--     already integrated against before 8c's gate existed. Defaulting
--     EITHER kind to `'pending'` and leaving it there would break every
--     first-party app's login on the next `/oidc/authorize` call the
--     instant this migration runs — an outage this migration must not
--     cause. The immediate backfill UPDATE below is what prevents that:
--     it runs in the same migration, so there is no window where a
--     previously-working client is suddenly rejected.
--   - This does mean a client registered via 8a BEFORE this migration
--     runs is grandfathered into `'approved'` even though it was never
--     actually reviewed by anyone — a one-time, unavoidable consequence
--     of adding an approval gate after registration already existed
--     without one, not a loophole this migration is trying to hide. Any
--     client registered via 8a AFTER this migration runs gets the real
--     `'pending'` default and is subject to 8c's gate immediately.
ALTER TABLE oidc_clients ADD COLUMN IF NOT EXISTS registration_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE oidc_clients DROP CONSTRAINT IF EXISTS oidc_clients_registration_status_check;
ALTER TABLE oidc_clients ADD CONSTRAINT oidc_clients_registration_status_check
  CHECK (registration_status IN ('pending', 'approved', 'suspended'));

-- Backfill: every row that exists RIGHT NOW (before any post-migration
-- `POST /oidc/register` call can create a new one) becomes 'approved'.
-- See the header above for why this one-time UPDATE, not the column
-- DEFAULT, is what protects already-working clients.
UPDATE oidc_clients SET registration_status = 'approved' WHERE registration_status = 'pending';
