// ─────────────────────────────────────────────────────────────────────────────
// AYZEN Sync Module
//
// Problem this solves: several tables snapshot or reference vault_entries
// (vault_market_listings.preview_data, vault_market_listings.vault_entry_id,
// entity_project_roi.vault_entry_id) but nothing propagates a Vault change
// into them. Edit a vault entry → marketplace listing preview goes stale.
// Ban/delete a vault entry → the marketplace listing selling it stays
// "active" and buyable, and entity_project_roi rows are orphaned.
//
// This module is the single place that reacts to a Vault write and pushes
// the resulting state into every table that keeps its own copy of Vault
// data. Routes call these functions after their own DB write commits —
// they never touch vault_market_listings / entity_project_roi directly.
//
// Adding a new "principle function" dependency (e.g. Project changes should
// push into Marketplace, or Team status should push into shared Vault
// entries) means adding one more sync*() function here and one call site in
// the owning route — not hunting through every consumer table by hand.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface SyncResult {
  ok: boolean;
  action: string;
  affected: Record<string, number>;
  error?: string;
}

function emptyResult(action: string): SyncResult {
  return { ok: true, action, affected: {} };
}

// Statuses that make a vault entry unsellable / unsafe to keep listed.
const UNSELLABLE_VAULT_STATUSES = new Set(["banned", "suspended"]);

/**
 * Rebuild the preview_data snapshot on every active marketplace listing
 * that sells this vault entry, from the vault entry's current row.
 * Call after any vault_entries UPDATE that isn't a status change to
 * banned/suspended (those go through cascadeVaultStatusChange instead).
 */
export async function syncVaultToMarketplacePreview(vaultEntryId: number): Promise<SyncResult> {
  try {
    const entryResult = await db.execute(sql`SELECT * FROM vault_entries WHERE id = ${vaultEntryId}`);
    const entry = entryResult.rows[0] as any;
    if (!entry) return emptyResult("vault_to_marketplace_preview");

    const previewData = JSON.stringify({
      project_name: entry.project_name,
      has_twitter: !!entry.twitter_username,
      has_discord: !!entry.discord_username,
      has_telegram: !!entry.telegram_phone,
      has_email: !!entry.email,
      has_wallet: !!entry.wallet_addresses,
      entity_serial: entry.entity_serial,
    });

    const updateResult = await db.execute(sql`
      UPDATE vault_market_listings
      SET preview_data = ${previewData}
      WHERE vault_entry_id = ${vaultEntryId} AND vault_type = 'entity' AND status = 'active'
    `);

    return {
      ok: true,
      action: "vault_to_marketplace_preview",
      affected: { vault_market_listings: (updateResult as any).rowCount ?? 0 },
    };
  } catch (err: any) {
    return { ok: false, action: "vault_to_marketplace_preview", affected: {}, error: err?.message };
  }
}

/**
 * Pull any active marketplace listing selling this vault entry off the
 * market. Used when the entry becomes unsellable (banned/suspended) or is
 * deleted outright. Does not touch already-sold listings.
 */
export async function delistVaultMarketplaceListings(vaultEntryId: number, reason: string): Promise<SyncResult> {
  try {
    const updateResult = await db.execute(sql`
      UPDATE vault_market_listings
      SET status = 'removed',
          description = COALESCE(description, '') || ${` [auto-removed: ${reason}]`}
      WHERE vault_entry_id = ${vaultEntryId} AND vault_type = 'entity' AND status = 'active'
    `);
    return {
      ok: true,
      action: "delist_vault_marketplace_listings",
      affected: { vault_market_listings: (updateResult as any).rowCount ?? 0 },
    };
  } catch (err: any) {
    return { ok: false, action: "delist_vault_marketplace_listings", affected: {}, error: err?.message };
  }
}

/**
 * Drop entity_project_roi rows that point at a vault entry that no longer
 * exists. These rows have no FK/cascade at the DB level, so they'd
 * otherwise sit around forever as dead data once the vault entry is gone.
 */
export async function pruneOrphanedRoi(vaultEntryId: number): Promise<SyncResult> {
  try {
    const deleteResult = await db.execute(sql`
      DELETE FROM entity_project_roi WHERE vault_entry_id = ${vaultEntryId}
    `);
    return {
      ok: true,
      action: "prune_orphaned_roi",
      affected: { entity_project_roi: (deleteResult as any).rowCount ?? 0 },
    };
  } catch (err: any) {
    return { ok: false, action: "prune_orphaned_roi", affected: {}, error: err?.message };
  }
}

/**
 * Call after a non-status vault_entries UPDATE commits (PATCH /vault/:id
 * without a status change). Keeps marketplace listing previews current.
 */
export async function syncOnVaultUpdate(vaultEntryId: number): Promise<SyncResult[]> {
  return [await syncVaultToMarketplacePreview(vaultEntryId)];
}

/**
 * Call after a vault_entries status UPDATE commits. If the new status
 * makes the entry unsellable, pulls any active listing off the market;
 * otherwise just refreshes the preview like a normal update.
 */
export async function syncOnVaultStatusChange(vaultEntryId: number, newStatus: string): Promise<SyncResult[]> {
  if (UNSELLABLE_VAULT_STATUSES.has(newStatus)) {
    return [await delistVaultMarketplaceListings(vaultEntryId, `vault_status_${newStatus}`)];
  }
  return [await syncVaultToMarketplacePreview(vaultEntryId)];
}

/**
 * Call after a vault_entries DELETE commits. Delists any active listing
 * (a deleted identity can't be sold) and clears out orphaned ROI rows.
 */
export async function syncOnVaultDelete(vaultEntryId: number): Promise<SyncResult[]> {
  return [
    await delistVaultMarketplaceListings(vaultEntryId, "vault_entry_deleted"),
    await pruneOrphanedRoi(vaultEntryId),
  ];
}

/**
 * Re-run every vault sync for a given entry regardless of what changed.
 * Powers the manual "Resync" action (POST /admin/sync/vault/:id) for
 * fixing entries that drifted before this module existed.
 */
export async function reconcileVaultEntry(vaultEntryId: number): Promise<SyncResult[]> {
  const entryResult = await db.execute(sql`SELECT status FROM vault_entries WHERE id = ${vaultEntryId}`);
  const entry = entryResult.rows[0] as any;
  if (!entry) {
    return [await delistVaultMarketplaceListings(vaultEntryId, "vault_entry_deleted"), await pruneOrphanedRoi(vaultEntryId)];
  }
  return syncOnVaultStatusChange(vaultEntryId, entry.status ?? "active");
}

// ─────────────────────────────────────────────────────────────────────────────
// Local Accounts → Marketplace
//
// Same gap as Vault: marketplace-vault.ts snapshots a local_account into
// preview_data (vault_type='local') at listing time and never refreshes it.
// ─────────────────────────────────────────────────────────────────────────────

export async function syncLocalAccountToMarketplacePreview(localAccountId: number): Promise<SyncResult> {
  try {
    const accountResult = await db.execute(sql`SELECT * FROM local_accounts WHERE id = ${localAccountId}`);
    const account = accountResult.rows[0] as any;
    if (!account) return emptyResult("local_account_to_marketplace_preview");

    const previewData = JSON.stringify({
      category: account.category,
      has_2fa: !!account.twofa,
      account_create_date: account.account_create_date,
      followers: account.followers,
    });

    // vault_market_listings has one shared vault_entry_id column for both
    // entity vault entries and local accounts — vault_type is the discriminator
    // (see POST /marketplace/vault/listings: vault_entry_id ?? local_account_id).
    const updateResult = await db.execute(sql`
      UPDATE vault_market_listings
      SET preview_data = ${previewData}
      WHERE vault_entry_id = ${localAccountId} AND vault_type = 'local' AND status = 'active'
    `);

    return {
      ok: true,
      action: "local_account_to_marketplace_preview",
      affected: { vault_market_listings: (updateResult as any).rowCount ?? 0 },
    };
  } catch (err: any) {
    return { ok: false, action: "local_account_to_marketplace_preview", affected: {}, error: err?.message };
  }
}

export async function delistLocalAccountMarketplaceListings(localAccountId: number, reason: string): Promise<SyncResult> {
  try {
    const updateResult = await db.execute(sql`
      UPDATE vault_market_listings
      SET status = 'removed',
          description = COALESCE(description, '') || ${` [auto-removed: ${reason}]`}
      WHERE vault_entry_id = ${localAccountId} AND vault_type = 'local' AND status = 'active'
    `);
    return {
      ok: true,
      action: "delist_local_account_marketplace_listings",
      affected: { vault_market_listings: (updateResult as any).rowCount ?? 0 },
    };
  } catch (err: any) {
    return { ok: false, action: "delist_local_account_marketplace_listings", affected: {}, error: err?.message };
  }
}

/** Call after PUT /local-accounts/:id commits. */
export async function syncOnLocalAccountUpdate(localAccountId: number): Promise<SyncResult[]> {
  return [await syncLocalAccountToMarketplacePreview(localAccountId)];
}

/** Call after DELETE /local-accounts/:id commits. */
export async function syncOnLocalAccountDelete(localAccountId: number): Promise<SyncResult[]> {
  return [await delistLocalAccountMarketplaceListings(localAccountId, "local_account_deleted")];
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects → enrollments / ROI
//
// DELETE /projects/:id only removes the projects row. user_projects,
// project_enrollments, and entity_project_roi rows that reference the
// deleted project_id are left behind — orphaned joins/tasks tab and ROI
// summaries that silently reference a project that no longer exists.
// ─────────────────────────────────────────────────────────────────────────────

export async function syncOnProjectDelete(projectId: number): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  try {
    const r = await db.execute(sql`DELETE FROM user_projects WHERE project_id = ${projectId}`);
    results.push({ ok: true, action: "prune_user_projects", affected: { user_projects: (r as any).rowCount ?? 0 } });
  } catch (err: any) {
    results.push({ ok: false, action: "prune_user_projects", affected: {}, error: err?.message });
  }
  try {
    const r = await db.execute(sql`DELETE FROM project_enrollments WHERE project_id = ${projectId}`);
    results.push({ ok: true, action: "prune_project_enrollments", affected: { project_enrollments: (r as any).rowCount ?? 0 } });
  } catch (err: any) {
    results.push({ ok: false, action: "prune_project_enrollments", affected: {}, error: err?.message });
  }
  try {
    const r = await db.execute(sql`DELETE FROM entity_project_roi WHERE project_id = ${projectId}`);
    results.push({ ok: true, action: "prune_project_roi", affected: { entity_project_roi: (r as any).rowCount ?? 0 } });
  } catch (err: any) {
    results.push({ ok: false, action: "prune_project_roi", affected: {}, error: err?.message });
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Teams → shared vault entries
//
// team_members / team_messages / team_missions / team_join_requests /
// team_favorites / team_announcements / team_activity_log all have
// `REFERENCES teams(id) ON DELETE CASCADE` at the DB level already, so
// disbanding a team cleans those up automatically — no gap there.
//
// vault_entries.team_id is different: it's a plain column with no FK
// (POST /teams/:id/vault tags a real, individually-owned vault entry with
// the team's id to mark it "shared"). Disbanding the team left that tag
// dangling — the vault entry pointed at a team_id that no longer existed.
// The entry itself is real user data, so the fix is to null the tag (falls
// back to a normal personal vault entry), not delete the entry.
// ─────────────────────────────────────────────────────────────────────────────

export async function unlinkTeamVaultEntries(teamId: number): Promise<SyncResult> {
  try {
    const r = await db.execute(sql`UPDATE vault_entries SET team_id = NULL WHERE team_id = ${teamId}`);
    return { ok: true, action: "unlink_team_vault_entries", affected: { vault_entries: (r as any).rowCount ?? 0 } };
  } catch (err: any) {
    return { ok: false, action: "unlink_team_vault_entries", affected: {}, error: err?.message };
  }
}

/** Call after DELETE /teams/:id commits (after the teams row is gone, so the CASCADE FKs have already fired). */
export async function syncOnTeamDelete(teamId: number): Promise<SyncResult[]> {
  return [await unlinkTeamVaultEntries(teamId)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tasks → pending submissions
//
// DELETE /tasks/:id had no cascade at all. task_submissions.task_id has no
// FK, so submissions for a deleted task stuck around forever. Approved/
// rejected submissions are a real payout record (AZN already awarded via
// awardXpAsAzn) and must not be touched. Pending submissions, though, can
// never be reviewed once the task is gone — they'd sit in the admin queue
// forever pointing at nothing, so those get auto-rejected with a reason.
// ─────────────────────────────────────────────────────────────────────────────

export async function resolvePendingSubmissionsForDeletedTask(taskId: number): Promise<SyncResult> {
  try {
    const r = await db.execute(sql`
      UPDATE task_submissions
      SET status = 'rejected', rejection_reason = 'Task was deleted', reviewed_at = NOW()
      WHERE task_id = ${taskId} AND status = 'pending'
    `);
    return { ok: true, action: "resolve_pending_submissions_for_deleted_task", affected: { task_submissions: (r as any).rowCount ?? 0 } };
  } catch (err: any) {
    return { ok: false, action: "resolve_pending_submissions_for_deleted_task", affected: {}, error: err?.message };
  }
}

/** Call after DELETE /tasks/:id commits. */
export async function syncOnTaskDelete(taskId: number): Promise<SyncResult[]> {
  return [await resolvePendingSubmissionsForDeletedTask(taskId)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions → plan/feature gates
//
// expiresAt is set on purchase but nothing ever checks it. GET /subscription
// and GET /content/plan-limits both read `plan` straight off the row, so a
// user whose paid plan expired keeps pro/enterprise limits forever — time
// passing is a change that never propagated. Lifetime subscriptions
// (isLifetime) are exempt by definition.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Self-healing check: if this user's subscription has expired and isn't
 * lifetime, downgrade it to free/expired in the DB right now, then return
 * whether a downgrade happened. Call before reading `plan` for gating.
 */
export async function syncSubscriptionExpiry(userId: number): Promise<SyncResult> {
  try {
    const r = await db.execute(sql`
      UPDATE subscriptions
      SET plan = 'free', status = 'expired', updated_at = NOW()
      WHERE user_id = ${userId} AND is_lifetime = false
        AND expires_at IS NOT NULL AND expires_at < NOW() AND plan != 'free'
    `);
    return { ok: true, action: "sync_subscription_expiry", affected: { subscriptions: (r as any).rowCount ?? 0 } };
  } catch (err: any) {
    return { ok: false, action: "sync_subscription_expiry", affected: {}, error: err?.message };
  }
}
