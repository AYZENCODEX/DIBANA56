-- 017_emergency_access.sql
-- Feature 16: Emergency Access / Dead-Man Switch. See
-- lib/db/src/schema/emergency-access.ts for the full design note.

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_user_id INTEGER,
  wait_days INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active',
  invite_token TEXT,
  confirmed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS emergency_contacts_user_idx ON emergency_contacts(user_id);
CREATE INDEX IF NOT EXISTS emergency_contacts_status_idx ON emergency_contacts(status);

CREATE TABLE IF NOT EXISTS emergency_access_grants (
  id SERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  owner_user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_admin_review',
  owner_inactive_since_at TIMESTAMP,
  triggered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  cancelled_at TIMESTAMP,
  admin_reviewed_by INTEGER,
  admin_reviewed_at TIMESTAMP,
  admin_note TEXT,
  access_token_hash TEXT,
  access_token_expires_at TIMESTAMP,
  accessed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS emergency_grants_owner_idx ON emergency_access_grants(owner_user_id);
CREATE INDEX IF NOT EXISTS emergency_grants_contact_idx ON emergency_access_grants(contact_id);
CREATE INDEX IF NOT EXISTS emergency_grants_status_idx ON emergency_access_grants(status);
