-- 053_ayzen_mailbox_sending_health.sql
-- Bounce + Complaint Handling (Phase 3) — see CHANGES_BOUNCE_COMPLAINT_PHASE3.md.
--
-- Phase 1/2 only ever reasoned per-recipient (is THIS address a problem?).
-- This adds the account-wide view: is THIS USER'S sending, in aggregate,
-- starting to look bad enough that it risks the shared Resend domain's
-- reputation? That's what actually gets a sending domain rate-limited or
-- suspended by real ESPs — not any one bounced/complained message.
--
--   ayzen_mailbox_sending_health — one row per user (lib/mail-sending-health.ts):
--     * sent_in_window / bounced_in_window / complained_in_window — a
--       rolling window (see sending_config.window_days below), reset back
--       to 0 once window_started_at falls outside the window rather than
--       kept forever, so a bad stretch a user has since fixed doesn't keep
--       them paused indefinitely.
--     * total_sent / total_bounced / total_complained — lifetime, never
--       reset, shown alongside the windowed numbers for context.
--     * status — 'healthy' | 'warning' | 'paused'. Evaluated after every
--       send/bounce/complaint against sending_config's thresholds;
--       'paused' blocks POST /send entirely (account-wide, not just to
--       the specific problem recipient) until the user manually resumes
--       from Settings.
--     * paused_at / paused_reason — when/why, so Settings can show it and
--       the resume flow can re-evaluate from a known state.
--
--   ayzen_mailbox_sending_config — a SINGLETON row (id always 1) of
--     admin-tunable thresholds, read by both lib/mail-sending-health.ts
--     (account-wide pause) and lib/mail-recipient-reputation.ts
--     (per-recipient flag threshold — Phase 2's bounce_flag_threshold was
--     a hardcoded constant; Phase 3 moves it here). Rates are stored as
--     basis points (1/100th of a percent — e.g. 500 = 5.00%) to keep
--     comparisons exact integers rather than floats.
CREATE TABLE IF NOT EXISTS ayzen_mailbox_sending_health (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  window_started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  sent_in_window INTEGER NOT NULL DEFAULT 0,
  bounced_in_window INTEGER NOT NULL DEFAULT 0,
  complained_in_window INTEGER NOT NULL DEFAULT 0,
  total_sent INTEGER NOT NULL DEFAULT 0,
  total_bounced INTEGER NOT NULL DEFAULT 0,
  total_complained INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'healthy',
  paused_at TIMESTAMP,
  paused_reason TEXT,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ayzen_mailbox_sending_config (
  id INTEGER PRIMARY KEY DEFAULT 1,
  -- Phase 2's per-recipient BOUNCE_FLAG_THRESHOLD, now admin-tunable.
  bounce_flag_threshold INTEGER NOT NULL DEFAULT 3,
  -- Account-wide rolling window, in days.
  window_days INTEGER NOT NULL DEFAULT 30,
  -- Rates below only apply once sent_in_window >= min_sample_size — below
  -- that, one or two bad sends would swing the rate wildly and shouldn't
  -- pause an account that's barely sent anything yet.
  min_sample_size INTEGER NOT NULL DEFAULT 20,
  warning_bounce_rate_bp INTEGER NOT NULL DEFAULT 500,   -- 5.00%
  pause_bounce_rate_bp INTEGER NOT NULL DEFAULT 1000,    -- 10.00%
  pause_complaint_rate_bp INTEGER NOT NULL DEFAULT 50,   -- 0.50%
  -- Independent of rate/sample size — this many complaints in the current
  -- window pauses the account outright, since complaints are a strong
  -- enough signal not to need a rate to back them up.
  complaint_hard_cap INTEGER NOT NULL DEFAULT 5,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT ayzen_mailbox_sending_config_singleton CHECK (id = 1)
);

INSERT INTO ayzen_mailbox_sending_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
