-- 067_ayzen_encryption_keys_delete_guard.sql
-- Run this once in Supabase SQL Editor. Run AFTER 066.
--
-- Gap #3 from the vault-backup disaster-recovery runbook: deleting a row
-- from encryption_keys (namespaces "vault" and "vault-backup") permanently
-- destroys that DEK version. Every row still encrypted under it — vault
-- fields, or stored vault_snapshots backups — becomes undecryptable forever
-- (envelopeDecryptBackup throws "Envelope key vN is unavailable", and
-- decryptField returns "[decryption failed: unknown key version]"). Until
-- now this was only a code-comment convention ("nothing else should write
-- here" / "old versions are kept forever") with no enforcement.
--
-- This adds a BEFORE DELETE trigger that unconditionally raises an
-- exception — no application code path deletes from this table today (only
-- loadKeyManager()/rotateKey()/loadBackupEnvelopeKeyManager()/
-- rotateBackupEnvelopeKey() write to it, and scripts/src/reencrypt-vault.ts
-- migrates row *contents* elsewhere, never touches encryption_keys itself),
-- so this should never fire in normal operation. If a real reason to remove
-- a row ever comes up (e.g. purging a namespace nobody uses anymore, only
-- after every row referencing that DEK version is confirmed gone), drop the
-- trigger for that one operation and recreate it immediately after.

CREATE OR REPLACE FUNCTION prevent_encryption_keys_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'encryption_keys rows are never deleted — namespace=% version=% still protects data that may only be decryptable under it. See migration 067.', OLD.namespace, OLD.version;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_encryption_keys_delete ON encryption_keys;
CREATE TRIGGER trg_prevent_encryption_keys_delete
  BEFORE DELETE ON encryption_keys
  FOR EACH ROW
  EXECUTE FUNCTION prevent_encryption_keys_delete();
