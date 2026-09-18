-- 086_ayzen_user_sessions_origin_client.sql
-- OIDC Roadmap — Season 3, Phase 6e-b: Sylo Integration.
-- Run this once in Supabase SQL Editor. Run AFTER 085.
--
-- Phase 6d-c flagged this as the one thing 6e itself would still need to
-- solve, not 6d: "Logout Token-এর sub/sid কোন user_sessions.jti-এর সাথে
-- মেলে তা resolve করার জন্য একটা mapping দরকার" — a mapping from an
-- inbound Logout Token's `sub` (a userId) to WHICH of that user's
-- `user_sessions` rows are actually Sylo's, since session-exchange
-- (routes/auth.ts's `POST /auth/session-exchange`, reused by both AYZEN
-- Astra and, per Phase 5b-e, sylo-oidc-session-exchange.ts) writes a
-- session row that looks identical to every other one: same table, same
-- createSession() call, no prior column that says which caller it was for.
--
-- Without this column, the only thing a Logout Token's `sub` (userId)
-- alone could resolve to is "every active session this user has,
-- anywhere" — which is too broad: revoking one browser tab's Central
-- session (`POST /auth/logout`, single `jti`) must not silently also
-- sign that same user out of a SECOND, unrelated Central browser tab
-- just because both happen to be the same user. It must reach exactly
-- Sylo's own session(s) for that user, nothing else.
--
-- `origin_client_id` is that missing tag: the `oidc_clients.client_id`
-- (e.g. 'sylo') a session was minted on behalf of, written once at
-- `createSession()` time, never mutated after. NULL is not "unknown" —
-- it is the correct, common case: every session opened by the ordinary
-- Central login flow or by the pre-existing AYZEN Astra extension
-- exchange (neither of which is "on behalf of" any OIDC client) keeps
-- this NULL, exactly as before this column existed. Only a session
-- opened by `POST /auth/session-exchange` WITH a recognized `client_id`
-- in its body (Sylo's own call, sylo-oidc-session-exchange.ts) gets a
-- non-null value. See lib/sessions.ts's `revokeSessionsByUserAndOriginClient()`,
-- the one reader, and routes/oidc-backchannel-logout.ts, its one caller.
--
-- No FOREIGN KEY to oidc_clients(client_id): a client row COULD be
-- deleted (out of this phase's scope, no such admin path exists yet)
-- while old session rows still reference its former client_id — this
-- column is a historical tag on the session, not a live join target, so
-- a dangling value must never block a session write/read the way a FK
-- violation would.
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS origin_client_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_origin_client
  ON user_sessions(user_id, origin_client_id)
  WHERE revoked_at IS NULL;
