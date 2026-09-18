/**
 * lib/vault-health.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Vault Health Monitor — Feature 4 of the "Vault ki massive addition" set.
 *
 * Two independent pieces:
 *   1. computeAutoScore()  — derives a 0-10 score from signals already on the
 *      row (lastLoginAt, 2FA presence, password set, email verified-ish).
 *      Called from PATCH /vault/:id when the client doesn't explicitly send
 *      a score, so score stays in sync with the entry's actual state.
 *   2. evalHealthRules()   — the declarative rules engine ("if score < 3,
 *      alert", "if no login for 30 days, warn", "if 2FA missing, flag").
 *      Returns the list of rule ids that currently fire for an entry; the
 *      caller (routes/vault-health.ts) diffs this against last_health_flags
 *      to avoid re-notifying for an issue that's still unresolved.
 */

export type HealthSeverity = "flag" | "warn" | "alert";

export interface HealthRuleHit {
  id: string;
  severity: HealthSeverity;
  message: string;
}

export interface VaultHealthInput {
  score: number;
  lastLoginAt: string | Date | null;
  hasTwitter2fa: boolean | null | undefined; // decrypted presence check, not the value
  hasDiscord2fa: boolean | null | undefined;
  hasTelegram2fa: boolean | null | undefined;
  hasEmail2fa: boolean | null | undefined;
  hasAccountPassword: boolean | null | undefined;
  email: string | null | undefined;
  status: string | null | undefined;
  // Presence of a recovery email on the entry. NOTE: this is a presence check,
  // not a deliverability check — there's no bounce/verification ping in this
  // codebase, so "dead" recovery email is approximated as "no recovery email
  // on file". See evalBackgroundHealthRules() below.
  hasRecoveryEmail?: boolean | null | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Auto-score: starts at 5 (mid-tier default), then adjusted by signals. Clamped 0-10. */
export function computeAutoScore(input: VaultHealthInput): number {
  let score = 5;

  // Login recency
  if (input.lastLoginAt) {
    const days = (Date.now() - new Date(input.lastLoginAt).getTime()) / DAY_MS;
    if (days <= 7) score += 2;
    else if (days <= 30) score += 1;
    else if (days <= 90) score -= 1;
    else score -= 3;
  } else {
    score -= 1; // never logged in / unknown
  }

  // 2FA coverage across linked platforms actually populated on this entry
  const twofaSignals = [input.hasTwitter2fa, input.hasDiscord2fa, input.hasTelegram2fa, input.hasEmail2fa]
    .filter((v) => v !== null && v !== undefined);
  if (twofaSignals.length > 0) {
    const covered = twofaSignals.filter(Boolean).length;
    const ratio = covered / twofaSignals.length;
    score += ratio >= 1 ? 2 : ratio >= 0.5 ? 1 : -1;
  }

  // Password set on account credentials
  if (input.hasAccountPassword) score += 1;
  else score -= 1;

  // Email verified-ish (present at all)
  if (input.email && input.email.trim().length > 0) score += 1;

  // Status overrides — a banned/suspended entity is unhealthy regardless of the rest
  if (input.status === "banned") score = Math.min(score, 1);
  else if (input.status === "suspended") score = Math.min(score, 3);
  else if (input.status === "warning") score = Math.min(score, 5);

  return Math.max(0, Math.min(10, Math.round(score)));
}

/** Declarative health rules — evaluated fresh each check, no state needed here. */
export function evalHealthRules(input: VaultHealthInput): HealthRuleHit[] {
  const hits: HealthRuleHit[] = [];

  if (input.score < 3) {
    hits.push({ id: "low_score", severity: "alert", message: `Health score critically low (${input.score}/10)` });
  }

  if (input.lastLoginAt) {
    const days = (Date.now() - new Date(input.lastLoginAt).getTime()) / DAY_MS;
    if (days >= 30) {
      hits.push({ id: "inactive_30d", severity: "warn", message: `No login for ${Math.floor(days)} days` });
    }
  }

  const twofaSignals = [
    ["twitter", input.hasTwitter2fa],
    ["discord", input.hasDiscord2fa],
    ["telegram", input.hasTelegram2fa],
    ["email", input.hasEmail2fa],
  ] as const;
  const missing2fa = twofaSignals.filter(([, present]) => present === false).map(([name]) => name);
  if (missing2fa.length > 0) {
    hits.push({ id: "missing_2fa", severity: "flag", message: `2FA missing on: ${missing2fa.join(", ")}` });
  }

  if (input.status === "banned" || input.status === "suspended") {
    hits.push({ id: "status_" + input.status, severity: "alert", message: `Entity status is "${input.status}"` });
  }

  return hits;
}

/**
 * Background/daily-scan rules — used by the cron-driven proactive monitor
 * (lib/vault-health-scan.ts), NOT by the on-demand PATCH /vault/:id path.
 * Kept separate from evalHealthRules() above because the two run on
 * different cadences with different thresholds:
 *   - evalHealthRules(): fires on every save, 30-day stale-login threshold,
 *     no re-notify diffing needed here.
 *   - evalBackgroundHealthRules(): fires once/day even if the user hasn't
 *     touched the entry, catches things sooner (14-day threshold) since the
 *     whole point is surfacing risk *before* the user would otherwise notice.
 */
export function evalBackgroundHealthRules(input: VaultHealthInput): HealthRuleHit[] {
  const hits: HealthRuleHit[] = [];

  if (input.score < 3) {
    hits.push({ id: "low_score", severity: "alert", message: `Health score critically low (${input.score}/10)` });
  }

  if (input.lastLoginAt) {
    const days = (Date.now() - new Date(input.lastLoginAt).getTime()) / DAY_MS;
    if (days >= 14) {
      hits.push({ id: "stale_login_14d", severity: "warn", message: `No login for ${Math.floor(days)} days` });
    }
  } else {
    hits.push({ id: "never_logged_in", severity: "warn", message: "No login recorded for this entity yet" });
  }

  const twofaSignals = [
    ["twitter", input.hasTwitter2fa],
    ["discord", input.hasDiscord2fa],
    ["telegram", input.hasTelegram2fa],
    ["email", input.hasEmail2fa],
  ] as const;
  const missing2fa = twofaSignals.filter(([, present]) => present === false).map(([name]) => name);
  if (missing2fa.length > 0) {
    hits.push({ id: "missing_2fa", severity: "flag", message: `2FA missing on: ${missing2fa.join(", ")}` });
  }

  // Recovery-email presence check — see the field comment on hasRecoveryEmail
  // for why this is a presence proxy rather than a true liveness check.
  if (input.email && !input.hasRecoveryEmail) {
    hits.push({ id: "dead_recovery_email", severity: "warn", message: "No recovery email on file for this entity" });
  }

  if (input.status === "banned" || input.status === "suspended") {
    hits.push({ id: "status_" + input.status, severity: "alert", message: `Entity status is "${input.status}"` });
  }

  return hits;
}

export function severityEmoji(s: HealthSeverity): string {
  return s === "alert" ? "🚨" : s === "warn" ? "⚠️" : "🏳️";
}

/**
 * Multi-type automatic scan — background rules for KYC Entity, Wallet, and
 * Local Account, run daily by the same cron as Entity (see
 * lib/vault-health-scan.ts). Deliberately simple presence/staleness checks,
 * not the full declarative health_rules engine — mirrors
 * evalBackgroundHealthRules() above (14-day staleness, missing-2FA flag,
 * banned/suspended alert) so all four vault surfaces read the same at a
 * glance, just against each type's own columns.
 */
export interface KycHealthInput {
  hasEmail2fa: boolean;
  hasAccountTwofa: boolean;
  hasEmailBackup: boolean;
  hasAccountBackup: boolean;
  hasRecoveryEmail: boolean;
  lastLoginAt: string | Date | null;
  status: string | null | undefined;
}

export function evalKycBackgroundHealthRules(input: KycHealthInput): HealthRuleHit[] {
  const hits: HealthRuleHit[] = [];

  if (!input.hasEmail2fa && !input.hasAccountTwofa) {
    hits.push({ id: "missing_2fa", severity: "flag", message: "No 2FA (email or account) configured" });
  }
  if (!input.hasEmailBackup && !input.hasAccountBackup) {
    hits.push({ id: "missing_backup_codes", severity: "flag", message: "No backup codes stored" });
  }
  if (!input.hasRecoveryEmail) {
    hits.push({ id: "dead_recovery_email", severity: "warn", message: "No recovery email on file" });
  }
  if (input.lastLoginAt) {
    const days = (Date.now() - new Date(input.lastLoginAt).getTime()) / DAY_MS;
    if (days >= 14) hits.push({ id: "stale_login_14d", severity: "warn", message: `No login for ${Math.floor(days)} days` });
  } else {
    hits.push({ id: "never_logged_in", severity: "warn", message: "No login recorded yet" });
  }
  if (input.status === "banned" || input.status === "suspended") {
    hits.push({ id: "status_" + input.status, severity: "alert", message: `KYC entity status is "${input.status}"` });
  }

  return hits;
}

export interface WalletHealthInput {
  hasSeedPhrase: boolean;
  lastSyncedAt: string | Date | null;
}

export function evalWalletBackgroundHealthRules(input: WalletHealthInput): HealthRuleHit[] {
  const hits: HealthRuleHit[] = [];

  if (!input.hasSeedPhrase) {
    hits.push({ id: "no_seed_backup", severity: "flag", message: "No seed phrase backed up for this wallet" });
  }
  if (input.lastSyncedAt) {
    const days = (Date.now() - new Date(input.lastSyncedAt).getTime()) / DAY_MS;
    if (days >= 14) hits.push({ id: "stale_sync_14d", severity: "warn", message: `Not synced for ${Math.floor(days)} days` });
  } else {
    hits.push({ id: "never_synced", severity: "warn", message: "Balance has never been synced" });
  }

  return hits;
}

export interface LocalAccountHealthInput {
  hasTwofa: boolean;
  hasBackupCodes: boolean;
  hasRecoveryEmail: boolean;
  lastLoginAt: string | Date | null;
  status: string | null | undefined;
}

export function evalLocalAccountBackgroundHealthRules(input: LocalAccountHealthInput): HealthRuleHit[] {
  const hits: HealthRuleHit[] = [];

  if (!input.hasTwofa) {
    hits.push({ id: "missing_2fa", severity: "flag", message: "No 2FA configured" });
  }
  if (!input.hasBackupCodes) {
    hits.push({ id: "missing_backup_codes", severity: "flag", message: "No backup codes stored" });
  }
  if (!input.hasRecoveryEmail) {
    hits.push({ id: "dead_recovery_email", severity: "warn", message: "No recovery email on file" });
  }
  if (input.lastLoginAt) {
    const days = (Date.now() - new Date(input.lastLoginAt).getTime()) / DAY_MS;
    if (days >= 14) hits.push({ id: "stale_login_14d", severity: "warn", message: `No login for ${Math.floor(days)} days` });
  }
  if (input.status === "banned" || input.status === "suspended") {
    hits.push({ id: "status_" + input.status, severity: "alert", message: `Account status is "${input.status}"` });
  }

  return hits;
}

// Data Entity (kyc_data_entities) — 5th surface on the daily scan. Unlike
// the other four, a Data Entity has no login/2FA/status of its own: it's a
// standalone identity/KYC-document record that a KYC Entity or Vault Entity
// links to (see routes/kyc-data-entities.ts). "Health" here means
// completeness of the identity record itself, plus a nudge if it's been
// sitting around unused for a while.
export interface DataEntityHealthInput {
  hasNidNumber: boolean;
  hasName: boolean;
  hasBirthDate: boolean;
  hasPhoto1: boolean;
  hasPhoto2: boolean;
  used: boolean;
  createdAt: string | Date | null;
}

export function evalDataEntityBackgroundHealthRules(input: DataEntityHealthInput): HealthRuleHit[] {
  const hits: HealthRuleHit[] = [];

  if (!input.hasNidNumber) {
    hits.push({ id: "missing_nid", severity: "flag", message: "No NID/ID number on file" });
  }
  if (!input.hasName) {
    hits.push({ id: "missing_name", severity: "flag", message: "No name on file" });
  }
  if (!input.hasBirthDate) {
    hits.push({ id: "missing_birth_date", severity: "flag", message: "No birth date on file" });
  }
  if (!input.hasPhoto1 && !input.hasPhoto2) {
    hits.push({ id: "missing_photos", severity: "warn", message: "No ID document photos attached" });
  }
  if (!input.used && input.createdAt) {
    const days = (Date.now() - new Date(input.createdAt).getTime()) / DAY_MS;
    if (days >= 30) {
      hits.push({ id: "unused_stale_30d", severity: "warn", message: `Not linked to any entity for ${Math.floor(days)} days` });
    }
  }

  return hits;
}
