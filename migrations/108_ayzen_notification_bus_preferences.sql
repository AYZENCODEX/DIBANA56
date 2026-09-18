-- 108_ayzen_notification_bus_preferences.sql
-- AYZEN Workspace — Phase 7: Notification Bus (master plan §6/§11/§7 Phase 7).
-- Run this once in Supabase SQL Editor. Run AFTER 107.
--
-- IDEMPOTENT — every statement is safe to re-run (IF NOT EXISTS), matching
-- every other migration in this directory.
--
-- What this adds, and why it's small:
-- The bus itself (lib/notification-bus.ts) is a routing layer over channels
-- that already exist — `notifications` (in-app bell), `telegram.ts`
-- (sendToUser), `email.ts` (sendEmail), and the SSE broadcaster in
-- `routes/events.ts` (Astra toolbar badge). None of those need new storage.
-- The one new thing the bus needs is a per-user, per-category channel
-- preference so the Workspace hub's "one settings screen controls all
-- channels for all apps" (master plan §11) has somewhere to read/write.
--
-- Opt-OUT model, not opt-in: a user with no row for a category gets every
-- channel on by default (mirrors the "core stays accessible" posture the
-- Credits hard-stop uses in reverse — here it's "notifications stay on
-- unless you turn them off", not "off unless you pay"). A row only exists
-- once a user has actually changed something away from the default.

CREATE TABLE IF NOT EXISTS notification_preferences (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  category     TEXT NOT NULL,                     -- 'ryft' | 'skarn' | 'verve' | 'warde' | 'sylo' | 'wisp' | 'system'
  in_app       BOOLEAN NOT NULL DEFAULT true,      -- notification bell (workspace.ayzen.tech)
  telegram     BOOLEAN NOT NULL DEFAULT true,
  email        BOOLEAN NOT NULL DEFAULT true,
  astra        BOOLEAN NOT NULL DEFAULT true,      -- browser-extension toolbar badge (SSE)
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(user_id, category)
);

CREATE INDEX IF NOT EXISTS idx_notification_preferences_user ON notification_preferences(user_id);
