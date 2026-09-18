import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

// Generic subject-scoped activity log (see lib/db/src/schema/activity-log.ts
// for the table shape and why it's generic). Phase 4 uses subject_type
// "project_enrollment" with subject_id = project_enrollments.id; Phase 15
// will add subject_type "team" on the same table.

export async function logSubjectActivity(
  subjectType: string,
  subjectId: number | null | undefined,
  action: string,
  opts: { actorUserId?: number | null; amount?: number | null; meta?: Record<string, unknown> | null } = {},
): Promise<void> {
  if (!subjectId) return;
  try {
    const metaJson = opts.meta ? `'${JSON.stringify(opts.meta).replace(/'/g, "''")}'` : "NULL";
    const actorVal = opts.actorUserId ? String(opts.actorUserId) : "NULL";
    const amountVal = opts.amount !== undefined && opts.amount !== null && !Number.isNaN(Number(opts.amount))
      ? String(Number(opts.amount)) : "NULL";
    await db.execute(sql.raw(
      `INSERT INTO activity_log (subject_type, subject_id, action, actor_user_id, amount, meta, created_at)
       VALUES ('${subjectType.replace(/'/g, "''")}', ${subjectId}, '${action.replace(/'/g, "''")}', ${actorVal}, ${amountVal}, ${metaJson}, NOW())`
    ));
  } catch {
    // Best-effort logging — never let a log-write failure break the caller's action.
  }
}

export interface ActivityLogEntry {
  id: number;
  action: string;
  actorUserId: number | null;
  amount: number | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface SubjectActivitySummary {
  entries: ActivityLogEntry[];
  totals: {
    daysActive: number;
    totalReward: number;
    rewardPerDay: number | null;
    currentlyActive: boolean;
  };
}

/**
 * Pure totals computation shared by getSubjectActivitySummary (one subject)
 * and getUserEnrollmentsOverview (Phase 9A — many subjects aggregated) so
 * both derive "days active" / "total reward" from the same rule instead of
 * two slightly-different reimplementations drifting apart.
 */
export function computeActivityTotals(entries: ActivityLogEntry[]): {
  daysActive: number;
  totalReward: number;
  rewardPerDay: number | null;
  currentlyActive: boolean;
} {
  // Cumulative days active — sum every enrolled→left interval, plus the
  // open interval from the last "enrolled" to now if still active.
  let daysActive = 0;
  let openSince: Date | null = null;
  let currentlyActive = false;
  for (const e of entries) {
    if (e.action === "enrolled") {
      openSince = new Date(e.createdAt);
      currentlyActive = true;
    } else if (e.action === "left" || e.action === "disqualified" || e.action === "banned" || e.action === "cancelled") {
      if (openSince) {
        daysActive += (new Date(e.createdAt).getTime() - openSince.getTime()) / 86_400_000;
        openSince = null;
      }
      currentlyActive = false;
    }
  }
  if (openSince) {
    daysActive += (Date.now() - openSince.getTime()) / 86_400_000;
  }

  const totalReward = entries
    .filter(e => e.action === "reward" && e.amount !== null)
    .reduce((s, e) => s + (e.amount ?? 0), 0);

  return {
    daysActive: Math.round(daysActive * 100) / 100,
    totalReward: Math.round(totalReward * 100) / 100,
    rewardPerDay: daysActive > 0 ? Math.round((totalReward / daysActive) * 100) / 100 : null,
    currentlyActive,
  };
}

/**
 * Reads the full log for a subject plus computed totals — totals are always
 * derived from the log rows here, never stored, so they can't drift out of
 * sync with the individual events (Phase 4 acceptance requirement).
 */
export async function getSubjectActivitySummary(
  subjectType: string,
  subjectId: number,
): Promise<SubjectActivitySummary> {
  const rows = await db.execute(sql.raw(
    `SELECT id, action, actor_user_id, amount, meta, created_at
     FROM activity_log
     WHERE subject_type = '${subjectType.replace(/'/g, "''")}' AND subject_id = ${subjectId}
     ORDER BY created_at ASC`
  ));

  const entries: ActivityLogEntry[] = (rows.rows as any[]).map(r => ({
    id: Number(r.id),
    action: r.action,
    actorUserId: r.actor_user_id !== null ? Number(r.actor_user_id) : null,
    amount: r.amount !== null ? Number(r.amount) : null,
    meta: r.meta ? JSON.parse(r.meta) : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));

  return { entries, totals: computeActivityTotals(entries) };
}

// ─── Phase 9A — Enroll sidebar Projects Overview ───────────────────────────
//
// Aggregates every project_enrollment the user has across ALL their
// projects/entities into the 8-9 stat widgets + chart data the Overview
// page needs. Two queries total (enrollments, then their activity_log rows)
// — per-enrollment totals reuse computeActivityTotals above instead of a
// third bespoke aggregation rule, and are summed in JS rather than stored,
// same "never drifts" guarantee as getSubjectActivitySummary.
export interface EnrollmentsOverview {
  summary: {
    totalProjects: number;
    totalEnrollments: number;
    activeEnrollments: number;
    disqualifiedCount: number;
    bannedCount: number;
    cancelledCount: number;
    totalReward: number;
    totalDaysActive: number;
    avgRewardPerDay: number | null;
  };
  statusBreakdown: { status: string; count: number }[];
  rewardsByProject: { projectId: number; projectName: string; totalReward: number }[];
  enrollmentsOverTime: { month: string; count: number }[];
  activityHeatmap: { day: string; count: number }[];
}

export async function getUserEnrollmentsOverview(userId: number): Promise<EnrollmentsOverview> {
  const enrollmentsRes = await db.execute(sql.raw(
    `SELECT pe.id, pe.project_id, pe.status, pe.enrolled_at, p.name as project_name
     FROM project_enrollments pe
     JOIN projects p ON p.id = pe.project_id
     WHERE pe.user_id = ${userId}`
  ));
  const enrollments = enrollmentsRes.rows as any[];
  const enrollmentIds = enrollments.map(e => Number(e.id));

  let logRows: any[] = [];
  if (enrollmentIds.length > 0) {
    const logRes = await db.execute(sql.raw(
      `SELECT subject_id, action, amount, created_at
       FROM activity_log
       WHERE subject_type = 'project_enrollment' AND subject_id IN (${enrollmentIds.join(",")})
       ORDER BY created_at ASC`
    ));
    logRows = logRes.rows as any[];
  }

  const bySubject = new Map<number, ActivityLogEntry[]>();
  for (const r of logRows) {
    const sid = Number(r.subject_id);
    const entry: ActivityLogEntry = {
      id: 0, action: r.action, actorUserId: null,
      amount: r.amount !== null ? Number(r.amount) : null,
      meta: null, createdAt: new Date(r.created_at).toISOString(),
    };
    if (!bySubject.has(sid)) bySubject.set(sid, []);
    bySubject.get(sid)!.push(entry);
  }

  let totalReward = 0;
  let totalDaysActive = 0;
  const rewardByProject = new Map<number, { projectName: string; totalReward: number }>();

  for (const enr of enrollments) {
    const id = Number(enr.id);
    const totals = computeActivityTotals(bySubject.get(id) ?? []);
    totalReward += totals.totalReward;
    totalDaysActive += totals.daysActive;
    if (totals.totalReward > 0) {
      const pid = Number(enr.project_id);
      const existing = rewardByProject.get(pid) ?? { projectName: enr.project_name as string, totalReward: 0 };
      existing.totalReward += totals.totalReward;
      rewardByProject.set(pid, existing);
    }
  }

  const statusCounts: Record<string, number> = { active: 0, disqualified: 0, banned: 0, cancelled: 0 };
  for (const enr of enrollments) {
    const s = String(enr.status ?? "active");
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const monthCounts = new Map<string, number>();
  for (const enr of enrollments) {
    const d = new Date(enr.enrolled_at);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
  }

  const dayCounts = new Map<string, number>();
  const cutoff = Date.now() - 365 * 86_400_000;
  for (const r of logRows) {
    const t = new Date(r.created_at).getTime();
    if (t < cutoff) continue;
    const day = new Date(r.created_at).toISOString().split("T")[0];
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  return {
    summary: {
      totalProjects: new Set(enrollments.map(e => Number(e.project_id))).size,
      totalEnrollments: enrollments.length,
      activeEnrollments: statusCounts.active ?? 0,
      disqualifiedCount: statusCounts.disqualified ?? 0,
      bannedCount: statusCounts.banned ?? 0,
      cancelledCount: statusCounts.cancelled ?? 0,
      totalReward: Math.round(totalReward * 100) / 100,
      totalDaysActive: Math.round(totalDaysActive * 100) / 100,
      avgRewardPerDay: totalDaysActive > 0 ? Math.round((totalReward / totalDaysActive) * 100) / 100 : null,
    },
    statusBreakdown: Object.entries(statusCounts).map(([status, count]) => ({ status, count })),
    rewardsByProject: [...rewardByProject.entries()]
      .map(([projectId, v]) => ({ projectId, projectName: v.projectName, totalReward: Math.round(v.totalReward * 100) / 100 }))
      .sort((a, b) => b.totalReward - a.totalReward)
      .slice(0, 8),
    enrollmentsOverTime: [...monthCounts.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    activityHeatmap: [...dayCounts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

// ─── Phase 9B — Per-project dedicated dashboard ────────────────────────────
//
// Same aggregation rule as getUserEnrollmentsOverview (one project_enrollments
// scan + one activity_log scan, totals derived via computeActivityTotals —
// never stored), just filtered down to a single project instead of every
// project the user has. Powers pages/user/project-dashboard.tsx (Phase 9B),
// which reuses this instead of a third bespoke aggregation.
export interface ProjectEnrollmentsOverview {
  summary: {
    totalEnrollments: number;
    activeEnrollments: number;
    disqualifiedCount: number;
    bannedCount: number;
    cancelledCount: number;
    totalReward: number;
    totalDaysActive: number;
    avgRewardPerDay: number | null;
  };
  statusBreakdown: { status: string; count: number }[];
  rewardsByEntity: { vaultEntryId: number; entityName: string; totalReward: number }[];
  activityHeatmap: { day: string; count: number }[];
}

export async function getProjectEnrollmentsOverview(userId: number, projectId: number): Promise<ProjectEnrollmentsOverview> {
  const enrollmentsRes = await db.execute(sql.raw(
    `SELECT pe.id, pe.vault_entry_id, pe.status, pe.enrolled_at,
            COALESCE(ve.project_name, 'Unknown entity') as entity_name
     FROM project_enrollments pe
     LEFT JOIN vault_entries ve ON ve.id = pe.vault_entry_id
     WHERE pe.user_id = ${userId} AND pe.project_id = ${projectId}`
  ));
  const enrollments = enrollmentsRes.rows as any[];
  const enrollmentIds = enrollments.map(e => Number(e.id));

  let logRows: any[] = [];
  if (enrollmentIds.length > 0) {
    const logRes = await db.execute(sql.raw(
      `SELECT subject_id, action, amount, created_at
       FROM activity_log
       WHERE subject_type = 'project_enrollment' AND subject_id IN (${enrollmentIds.join(",")})
       ORDER BY created_at ASC`
    ));
    logRows = logRes.rows as any[];
  }

  const bySubject = new Map<number, ActivityLogEntry[]>();
  for (const r of logRows) {
    const sid = Number(r.subject_id);
    const entry: ActivityLogEntry = {
      id: 0, action: r.action, actorUserId: null,
      amount: r.amount !== null ? Number(r.amount) : null,
      meta: null, createdAt: new Date(r.created_at).toISOString(),
    };
    if (!bySubject.has(sid)) bySubject.set(sid, []);
    bySubject.get(sid)!.push(entry);
  }

  let totalReward = 0;
  let totalDaysActive = 0;
  const rewardByEntity = new Map<number, { entityName: string; totalReward: number }>();

  for (const enr of enrollments) {
    const id = Number(enr.id);
    const totals = computeActivityTotals(bySubject.get(id) ?? []);
    totalReward += totals.totalReward;
    totalDaysActive += totals.daysActive;
    if (totals.totalReward > 0) {
      const veId = Number(enr.vault_entry_id);
      const existing = rewardByEntity.get(veId) ?? { entityName: enr.entity_name as string, totalReward: 0 };
      existing.totalReward += totals.totalReward;
      rewardByEntity.set(veId, existing);
    }
  }

  const statusCounts: Record<string, number> = { active: 0, disqualified: 0, banned: 0, cancelled: 0 };
  for (const enr of enrollments) {
    const s = String(enr.status ?? "active");
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const dayCounts = new Map<string, number>();
  const cutoff = Date.now() - 365 * 86_400_000;
  for (const r of logRows) {
    const t = new Date(r.created_at).getTime();
    if (t < cutoff) continue;
    const day = new Date(r.created_at).toISOString().split("T")[0];
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  return {
    summary: {
      totalEnrollments: enrollments.length,
      activeEnrollments: statusCounts.active ?? 0,
      disqualifiedCount: statusCounts.disqualified ?? 0,
      bannedCount: statusCounts.banned ?? 0,
      cancelledCount: statusCounts.cancelled ?? 0,
      totalReward: Math.round(totalReward * 100) / 100,
      totalDaysActive: Math.round(totalDaysActive * 100) / 100,
      avgRewardPerDay: totalDaysActive > 0 ? Math.round((totalReward / totalDaysActive) * 100) / 100 : null,
    },
    statusBreakdown: Object.entries(statusCounts).map(([status, count]) => ({ status, count })),
    rewardsByEntity: [...rewardByEntity.entries()]
      .map(([vaultEntryId, v]) => ({ vaultEntryId, entityName: v.entityName, totalReward: Math.round(v.totalReward * 100) / 100 }))
      .sort((a, b) => b.totalReward - a.totalReward)
      .slice(0, 8),
    activityHeatmap: [...dayCounts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}

// ─── Phase 10A — Enroll sidebar Entities Overview ──────────────────────────
//
// Mirrors getUserEnrollmentsOverview (Phase 9A) exactly — same two-query
// shape (enrollments, then their activity_log rows), same
// computeActivityTotals reuse for per-enrollment totals summed in JS — just
// grouped by vault_entry_id (entity) instead of project_id, since this
// powers the Entities section's Overview tab
// (pages/user/enroll-entities.tsx) instead of the Projects section's.
export interface EntitiesOverview {
  summary: {
    totalEntities: number;
    totalEnrollments: number;
    activeEnrollments: number;
    disqualifiedCount: number;
    bannedCount: number;
    cancelledCount: number;
    totalReward: number;
    totalDaysActive: number;
    avgRewardPerDay: number | null;
  };
  statusBreakdown: { status: string; count: number }[];
  rewardsByEntity: { vaultEntryId: number; entityName: string; totalReward: number }[];
  enrollmentsOverTime: { month: string; count: number }[];
  activityHeatmap: { day: string; count: number }[];
}

export async function getUserEntitiesOverview(userId: number): Promise<EntitiesOverview> {
  const enrollmentsRes = await db.execute(sql.raw(
    `SELECT pe.id, pe.vault_entry_id, pe.status, pe.enrolled_at,
            COALESCE(ve.project_name, 'Unknown entity') as entity_name
     FROM project_enrollments pe
     LEFT JOIN vault_entries ve ON ve.id = pe.vault_entry_id
     WHERE pe.user_id = ${userId}`
  ));
  const enrollments = enrollmentsRes.rows as any[];
  const enrollmentIds = enrollments.map(e => Number(e.id));

  let logRows: any[] = [];
  if (enrollmentIds.length > 0) {
    const logRes = await db.execute(sql.raw(
      `SELECT subject_id, action, amount, created_at
       FROM activity_log
       WHERE subject_type = 'project_enrollment' AND subject_id IN (${enrollmentIds.join(",")})
       ORDER BY created_at ASC`
    ));
    logRows = logRes.rows as any[];
  }

  const bySubject = new Map<number, ActivityLogEntry[]>();
  for (const r of logRows) {
    const sid = Number(r.subject_id);
    const entry: ActivityLogEntry = {
      id: 0, action: r.action, actorUserId: null,
      amount: r.amount !== null ? Number(r.amount) : null,
      meta: null, createdAt: new Date(r.created_at).toISOString(),
    };
    if (!bySubject.has(sid)) bySubject.set(sid, []);
    bySubject.get(sid)!.push(entry);
  }

  let totalReward = 0;
  let totalDaysActive = 0;
  const rewardByEntity = new Map<number, { entityName: string; totalReward: number }>();

  for (const enr of enrollments) {
    const id = Number(enr.id);
    const totals = computeActivityTotals(bySubject.get(id) ?? []);
    totalReward += totals.totalReward;
    totalDaysActive += totals.daysActive;
    if (totals.totalReward > 0) {
      const veId = Number(enr.vault_entry_id);
      const existing = rewardByEntity.get(veId) ?? { entityName: enr.entity_name as string, totalReward: 0 };
      existing.totalReward += totals.totalReward;
      rewardByEntity.set(veId, existing);
    }
  }

  const statusCounts: Record<string, number> = { active: 0, disqualified: 0, banned: 0, cancelled: 0 };
  for (const enr of enrollments) {
    const s = String(enr.status ?? "active");
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const monthCounts = new Map<string, number>();
  for (const enr of enrollments) {
    const d = new Date(enr.enrolled_at);
    const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthCounts.set(month, (monthCounts.get(month) ?? 0) + 1);
  }

  const dayCounts = new Map<string, number>();
  const cutoff = Date.now() - 365 * 86_400_000;
  for (const r of logRows) {
    const t = new Date(r.created_at).getTime();
    if (t < cutoff) continue;
    const day = new Date(r.created_at).toISOString().split("T")[0];
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
  }

  return {
    summary: {
      totalEntities: new Set(enrollments.map(e => Number(e.vault_entry_id))).size,
      totalEnrollments: enrollments.length,
      activeEnrollments: statusCounts.active ?? 0,
      disqualifiedCount: statusCounts.disqualified ?? 0,
      bannedCount: statusCounts.banned ?? 0,
      cancelledCount: statusCounts.cancelled ?? 0,
      totalReward: Math.round(totalReward * 100) / 100,
      totalDaysActive: Math.round(totalDaysActive * 100) / 100,
      avgRewardPerDay: totalDaysActive > 0 ? Math.round((totalReward / totalDaysActive) * 100) / 100 : null,
    },
    statusBreakdown: Object.entries(statusCounts).map(([status, count]) => ({ status, count })),
    rewardsByEntity: [...rewardByEntity.entries()]
      .map(([vaultEntryId, v]) => ({ vaultEntryId, entityName: v.entityName, totalReward: Math.round(v.totalReward * 100) / 100 }))
      .sort((a, b) => b.totalReward - a.totalReward)
      .slice(0, 8),
    enrollmentsOverTime: [...monthCounts.entries()]
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    activityHeatmap: [...dayCounts.entries()]
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => a.day.localeCompare(b.day)),
  };
}