-- 068_ayzen_dr_test_reports.sql
-- DR Evidence Collector — Phase 1 (Backup Integrity stage only).
-- See dr-evidence-collector-design.md for the full multi-phase design.
--
-- Applied by hand against Supabase (same convention already used for
-- migrations 055-067: not wired into index.ts's boot-time MIGRATIONS array).
-- Run AFTER 067.
--
-- Phase 1 proves, on demand, that a scheduled (envelope-mode) vault backup
-- is actually restorable-in-principle: its checksum still matches what was
-- recorded at write time (verifyStoredChecksum(), routes/vault-snapshot.ts)
-- and it still decrypts under a live envelope key
-- (envelopeDecryptBackup(), lib/vault-backup-envelope.ts). Both functions
-- already existed for the manual/scheduled backup paths — Phase 1 adds no
-- new crypto, just a place to record the result as evidence.
--
-- This is a SUBSET of the full table in dr-evidence-collector-design.md §3.
-- Columns that only make sense once restore exists (isolated_schema_name,
-- restore_result, records_expected/restored, rto_ms — Phase 2) and the hash
-- chain (report_hash, prev_report_hash, runner_version — Phase 3) are left
-- for their own later migrations to ALTER TABLE in, matching how this
-- codebase grew vault_snapshots incrementally (migrations 056-065) rather
-- than pre-adding columns nothing writes to yet.
--
-- This table never stores plaintext/decrypted content — see the column
-- comments below and lib/dr-test-runner.ts.

CREATE TABLE IF NOT EXISTS dr_test_reports (
  id SERIAL PRIMARY KEY,
  test_id TEXT NOT NULL UNIQUE,
  triggered_by TEXT NOT NULL DEFAULT 'manual',
  snapshot_id INTEGER NOT NULL,
  encryption_mode TEXT NOT NULL DEFAULT 'envelope',
  key_version INTEGER,
  backup_checksum TEXT,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  checksum_result TEXT,
  decryption_result TEXT,
  overall_result TEXT NOT NULL,
  failure_stage TEXT,
  failure_reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dr_test_reports_created_idx ON dr_test_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS dr_test_reports_snapshot_idx ON dr_test_reports(snapshot_id);
CREATE INDEX IF NOT EXISTS dr_test_reports_result_idx ON dr_test_reports(overall_result);
