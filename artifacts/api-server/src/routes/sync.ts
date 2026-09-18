import { Router } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";
import {
  reconcileVaultEntry, syncVaultToMarketplacePreview, delistVaultMarketplaceListings, pruneOrphanedRoi,
  syncLocalAccountToMarketplacePreview, delistLocalAccountMarketplaceListings,
  syncOnProjectDelete, unlinkTeamVaultEntries, resolvePendingSubmissionsForDeletedTask, syncSubscriptionExpiry,
} from "../services/sync";

const router = Router();

// ── GET /admin/sync/status — drift report across known gaps ─────────────────
router.get("/admin/sync/status", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const orphanedListings = await db.execute(sql`
      SELECT vml.id, vml.title, vml.vault_entry_id, vml.status
      FROM vault_market_listings vml
      LEFT JOIN vault_entries ve ON ve.id = vml.vault_entry_id
      WHERE vml.status = 'active' AND vml.vault_type = 'entity'
        AND (ve.id IS NULL OR ve.status IN ('banned', 'suspended'))
    `);
    const orphanedLocalListings = await db.execute(sql`
      SELECT vml.id, vml.title, vml.vault_entry_id AS local_account_id, vml.status
      FROM vault_market_listings vml
      LEFT JOIN local_accounts la ON la.id = vml.vault_entry_id
      WHERE vml.status = 'active' AND vml.vault_type = 'local' AND la.id IS NULL
    `);
    const orphanedRoi = await db.execute(sql`
      SELECT epr.id, epr.vault_entry_id, epr.project_id
      FROM entity_project_roi epr
      LEFT JOIN vault_entries ve ON ve.id = epr.vault_entry_id
      WHERE ve.id IS NULL
    `);
    const orphanedProjectRoi = await db.execute(sql`
      SELECT epr.id, epr.vault_entry_id, epr.project_id
      FROM entity_project_roi epr
      LEFT JOIN projects p ON p.id = epr.project_id
      WHERE p.id IS NULL
    `);
    const orphanedUserProjects = await db.execute(sql`
      SELECT up.id, up.user_id, up.project_id
      FROM user_projects up
      LEFT JOIN projects p ON p.id = up.project_id
      WHERE p.id IS NULL
    `).catch(() => ({ rows: [] as any[] }));
    const orphanedEnrollments = await db.execute(sql`
      SELECT pe.id, pe.user_id, pe.project_id
      FROM project_enrollments pe
      LEFT JOIN projects p ON p.id = pe.project_id
      WHERE p.id IS NULL
    `).catch(() => ({ rows: [] as any[] }));

    const orphanedTeamVault = await db.execute(sql`
      SELECT ve.id, ve.project_name, ve.team_id
      FROM vault_entries ve
      LEFT JOIN teams t ON t.id = ve.team_id
      WHERE ve.team_id IS NOT NULL AND t.id IS NULL
    `).catch(() => ({ rows: [] as any[] }));
    const stuckTaskSubmissions = await db.execute(sql`
      SELECT ts.id, ts.task_id, ts.user_id
      FROM task_submissions ts
      LEFT JOIN tasks t ON t.id = ts.task_id
      WHERE ts.status = 'pending' AND t.id IS NULL
    `).catch(() => ({ rows: [] as any[] }));
    const expiredSubscriptions = await db.execute(sql`
      SELECT user_id, plan, expires_at
      FROM subscriptions
      WHERE is_lifetime = false AND expires_at IS NOT NULL AND expires_at < NOW() AND plan != 'free'
    `).catch(() => ({ rows: [] as any[] }));

    res.json({
      vault: { driftedListings: orphanedListings.rows, driftedCount: orphanedListings.rows.length },
      localAccounts: { driftedListings: orphanedLocalListings.rows, driftedCount: orphanedLocalListings.rows.length },
      roi: {
        orphanedByVaultEntry: orphanedRoi.rows,
        orphanedByProject: orphanedProjectRoi.rows,
        orphanedCount: orphanedRoi.rows.length + orphanedProjectRoi.rows.length,
      },
      projects: {
        orphanedUserProjects: (orphanedUserProjects as any).rows,
        orphanedEnrollments: (orphanedEnrollments as any).rows,
      },
      teams: { danglingVaultLinks: (orphanedTeamVault as any).rows, danglingCount: (orphanedTeamVault as any).rows.length },
      tasks: { stuckPendingSubmissions: (stuckTaskSubmissions as any).rows, stuckCount: (stuckTaskSubmissions as any).rows.length },
      subscriptions: { expiredNotDowngraded: (expiredSubscriptions as any).rows, expiredCount: (expiredSubscriptions as any).rows.length },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to compute sync status" });
  }
});

// ── POST /admin/sync/vault/:id — reconcile one vault entry's dependents ─────
router.post("/admin/sync/vault/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const results = await reconcileVaultEntry(id);
  res.json({ vaultEntryId: id, results });
});

// ── POST /admin/sync/vault/reconcile-all — sweep every vault entry ─────────
// Fixes drift that accumulated before this sync module existed (stale
// previews, listings still active for banned/deleted entries, orphaned ROI).
router.post("/admin/sync/vault/reconcile-all", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const entries = await db.execute(sql`SELECT id, status FROM vault_entries`);
    const summary = { refreshed: 0, delisted: 0, roiPruned: 0, entriesProcessed: 0 };

    for (const row of entries.rows as any[]) {
      summary.entriesProcessed++;
      if (row.status === "banned" || row.status === "suspended") {
        const r = await delistVaultMarketplaceListings(row.id, `vault_status_${row.status}`);
        summary.delisted += r.affected.vault_market_listings ?? 0;
      } else {
        const r = await syncVaultToMarketplacePreview(row.id);
        summary.refreshed += r.affected.vault_market_listings ?? 0;
      }
    }

    // Any listing/ROI row pointing at a vault entry that no longer exists at all
    const deletedRefs = await db.execute(sql`
      SELECT DISTINCT vault_entry_id FROM vault_market_listings
      WHERE vault_type = 'entity' AND vault_entry_id IS NOT NULL
        AND vault_entry_id NOT IN (SELECT id FROM vault_entries)
      UNION
      SELECT DISTINCT vault_entry_id FROM entity_project_roi
      WHERE vault_entry_id NOT IN (SELECT id FROM vault_entries)
    `);
    for (const row of deletedRefs.rows as any[]) {
      const d = await delistVaultMarketplaceListings(row.vault_entry_id, "vault_entry_deleted");
      const p = await pruneOrphanedRoi(row.vault_entry_id);
      summary.delisted += d.affected.vault_market_listings ?? 0;
      summary.roiPruned += p.affected.entity_project_roi ?? 0;
    }

    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Reconcile-all failed" });
  }
});

// ── POST /admin/sync/local-accounts/reconcile-all — sweep local accounts ────
router.post("/admin/sync/local-accounts/reconcile-all", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const accounts = await db.execute(sql`SELECT id FROM local_accounts`);
    let refreshed = 0;
    for (const row of accounts.rows as any[]) {
      const r = await syncLocalAccountToMarketplacePreview(row.id);
      refreshed += r.affected.vault_market_listings ?? 0;
    }

    const deletedRefs = await db.execute(sql`
      SELECT DISTINCT vault_entry_id AS local_account_id FROM vault_market_listings
      WHERE vault_type = 'local' AND status = 'active'
        AND vault_entry_id NOT IN (SELECT id FROM local_accounts)
    `);
    let delisted = 0;
    for (const row of deletedRefs.rows as any[]) {
      const d = await delistLocalAccountMarketplaceListings(row.local_account_id, "local_account_deleted");
      delisted += d.affected.vault_market_listings ?? 0;
    }

    res.json({ accountsProcessed: accounts.rows.length, refreshed, delisted });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Reconcile-all failed" });
  }
});

// ── POST /admin/sync/projects/reconcile-orphans — clean up dangling refs ────
// For projects deleted before this sync module existed — new deletes are
// already cascaded automatically by DELETE /projects/:id.
router.post("/admin/sync/projects/reconcile-orphans", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const orphanedProjectIds = await db.execute(sql`
      SELECT DISTINCT project_id FROM (
        SELECT project_id FROM user_projects WHERE project_id NOT IN (SELECT id FROM projects)
        UNION
        SELECT project_id FROM project_enrollments WHERE project_id NOT IN (SELECT id FROM projects)
        UNION
        SELECT project_id FROM entity_project_roi WHERE project_id NOT IN (SELECT id FROM projects)
      ) t
    `).catch(() => ({ rows: [] as any[] }));

    const summary = { projectsProcessed: 0, results: [] as unknown[] };
    for (const row of (orphanedProjectIds as any).rows as any[]) {
      summary.projectsProcessed++;
      summary.results.push({ projectId: row.project_id, results: await syncOnProjectDelete(row.project_id) });
    }
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Reconcile-orphans failed" });
  }
});

// ── POST /admin/sync/teams/reconcile-orphans — unlink vault entries from deleted teams ──
router.post("/admin/sync/teams/reconcile-orphans", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const orphanedTeamIds = await db.execute(sql`
      SELECT DISTINCT ve.team_id
      FROM vault_entries ve
      LEFT JOIN teams t ON t.id = ve.team_id
      WHERE ve.team_id IS NOT NULL AND t.id IS NULL
    `);
    let unlinked = 0;
    for (const row of orphanedTeamIds.rows as any[]) {
      const r = await unlinkTeamVaultEntries(row.team_id);
      unlinked += r.affected.vault_entries ?? 0;
    }
    res.json({ teamsProcessed: orphanedTeamIds.rows.length, vaultEntriesUnlinked: unlinked });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Reconcile-orphans failed" });
  }
});

// ── POST /admin/sync/tasks/reconcile-orphans — resolve submissions stuck on deleted tasks ──
router.post("/admin/sync/tasks/reconcile-orphans", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const orphanedTaskIds = await db.execute(sql`
      SELECT DISTINCT ts.task_id
      FROM task_submissions ts
      LEFT JOIN tasks t ON t.id = ts.task_id
      WHERE ts.status = 'pending' AND t.id IS NULL
    `);
    let resolved = 0;
    for (const row of orphanedTaskIds.rows as any[]) {
      const r = await resolvePendingSubmissionsForDeletedTask(row.task_id);
      resolved += r.affected.task_submissions ?? 0;
    }
    res.json({ tasksProcessed: orphanedTaskIds.rows.length, submissionsResolved: resolved });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Reconcile-orphans failed" });
  }
});

// ── POST /admin/sync/subscriptions/reconcile-all — downgrade every expired subscription ──
router.post("/admin/sync/subscriptions/reconcile-all", requireAdmin, async (_req, res): Promise<void> => {
  try {
    const expired = await db.execute(sql`
      SELECT user_id FROM subscriptions
      WHERE is_lifetime = false AND expires_at IS NOT NULL AND expires_at < NOW() AND plan != 'free'
    `);
    let downgraded = 0;
    for (const row of expired.rows as any[]) {
      const r = await syncSubscriptionExpiry(row.user_id);
      downgraded += r.affected.subscriptions ?? 0;
    }
    res.json({ usersProcessed: expired.rows.length, downgraded });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Reconcile-all failed" });
  }
});

export default router;
