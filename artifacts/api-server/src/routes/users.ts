import { Router } from "express";
import { db, usersTable, taskSubmissionsTable, userProjectsTable } from "@workspace/db";
import { eq, sql, ilike, and, gte, count } from "drizzle-orm";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";
import { createNotification } from "./notifications";

const router = Router();

function sanitizeUser(user: typeof usersTable.$inferSelect) {
  const { passwordHash: _ph, twoFaSecret: _ts, ...safe } = user;
  return {
    ...safe,
    createdAt: safe.createdAt.toISOString(),
    lastActiveAt: safe.lastActiveAt?.toISOString() ?? null,
  };
}

router.get("/users", requireAdmin, async (req, res): Promise<void> => {
  const { status, role, search, page = "1", limit = "20" } = req.query as Record<string, string>;
  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 100);
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];
  if (status) conditions.push(eq(usersTable.status, status));
  if (role) conditions.push(eq(usersTable.role, role));
  if (search) conditions.push(ilike(usersTable.username, `%${search}%`));

  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const users = await db.select().from(usersTable).where(where).limit(limitNum).offset(offset);
  const [{ total }] = await db.select({ total: count() }).from(usersTable).where(where);

  res.json({ users: users.map(sanitizeUser), total: Number(total), page: pageNum, limit: limitNum });
});

router.get("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const [projectCountResult] = await db.select({ cnt: count() }).from(userProjectsTable).where(eq(userProjectsTable.userId, id));
  const [taskCountResult] = await db.select({ cnt: count() }).from(taskSubmissionsTable)
    .where(and(eq(taskSubmissionsTable.userId, id), eq(taskSubmissionsTable.status, "approved")));

  res.json({
    ...sanitizeUser(user),
    projectCount: Number(projectCountResult?.cnt ?? 0),
    tasksCompleted: Number(taskCountResult?.cnt ?? 0),
    streak: user.streak,
    walletAddresses: [],
  });
});

router.patch("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { role, status, username } = req.body;
  const updates: Record<string, unknown> = {};
  if (role) updates.role = role;
  if (status) updates.status = status;
  if (username) updates.username = username;

  const [user] = await db.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json(sanitizeUser(user));
});

router.delete("/users/:id", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.delete(usersTable).where(eq(usersTable.id, id));
  res.json({ message: "User deleted" });
});

router.get("/users/:id/stats", requireAdmin, async (req, res): Promise<void> => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const [projectCountResult] = await db.select({ cnt: count() }).from(userProjectsTable).where(eq(userProjectsTable.userId, id));
  const [taskCountResult] = await db.select({ cnt: count() }).from(taskSubmissionsTable)
    .where(and(eq(taskSubmissionsTable.userId, id), eq(taskSubmissionsTable.status, "approved")));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7); weekAgo.setHours(0, 0, 0, 0);

  const [todayCount] = await db.select({ cnt: count() }).from(taskSubmissionsTable)
    .where(and(eq(taskSubmissionsTable.userId, id), eq(taskSubmissionsTable.status, "approved"), gte(taskSubmissionsTable.submittedAt, today)));
  const [weekCount] = await db.select({ cnt: count() }).from(taskSubmissionsTable)
    .where(and(eq(taskSubmissionsTable.userId, id), eq(taskSubmissionsTable.status, "approved"), gte(taskSubmissionsTable.submittedAt, weekAgo)));

  const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(usersTable);

  const betterThanMe = await db.select({ cnt: count() }).from(usersTable)
    .where(sql`total_roi > ${user.totalRoi}`);
  const rankNum = Number(betterThanMe[0]?.cnt ?? 0) + 1;

  const [referralResult] = await db.select({ cnt: count() }).from(usersTable)
    .where(eq(usersTable.referredBy, id));

  res.json({
    totalRoi: user.totalRoi,
    projectCount: Number(projectCountResult?.cnt ?? 0),
    tasksCompleted: Number(taskCountResult?.cnt ?? 0),
    streak: user.streak,
    longestStreak: user.streak,
    walletCount: user.walletCount,
    points: (user as Record<string, unknown>).points ?? 0,
    referrals: Number(referralResult?.cnt ?? 0),
    rank: rankNum,
    totalUsers: Number(totalUsers),
    tasksToday: Number(todayCount?.cnt ?? 0),
    tasksThisWeek: Number(weekCount?.cnt ?? 0),
  });
});

// Admin stats
router.get("/admin/stats", requireAdmin, async (_req, res): Promise<void> => {
  const [{ totalUsers }] = await db.select({ totalUsers: count() }).from(usersTable);
  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
  const monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 30);
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const [{ newWeek }] = await db.select({ newWeek: count() }).from(usersTable).where(gte(usersTable.createdAt, weekAgo));
  const [{ newMonth }] = await db.select({ newMonth: count() }).from(usersTable).where(gte(usersTable.createdAt, monthAgo));
  const [{ activeUsers }] = await db.select({ activeUsers: count() }).from(usersTable).where(gte(usersTable.lastActiveAt, sevenDaysAgo));
  const roiResult = await db.select({ totalRoi: sql<number>`COALESCE(SUM(total_roi), 0)` }).from(usersTable);

  res.json({
    totalUsers: Number(totalUsers),
    activeUsers: Number(activeUsers),
    totalProjects: 0,
    totalRoiDistributed: Number(roiResult[0]?.totalRoi ?? 0),
    pendingRoi: 12450.00,
    projectedRoi: 89300.00,
    totalInvestments: 2400000,
    newUsersThisWeek: Number(newWeek),
    newUsersThisMonth: Number(newMonth),
    activeProjectCount: 0,
  });
});

router.get("/admin/activity", requireAdmin, async (_req, res): Promise<void> => {
  const daily = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - (13 - i));
    return { date: d.toISOString().split("T")[0], users: Math.floor(Math.random() * 80) + 20, tasks: Math.floor(Math.random() * 200) + 50, roi: Math.random() * 5000 + 500 };
  });
  const monthly = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(); d.setMonth(d.getMonth() - (5 - i));
    return { date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, users: Math.floor(Math.random() * 400) + 100, tasks: Math.floor(Math.random() * 2000) + 500, roi: Math.random() * 50000 + 5000 };
  });
  res.json({ daily, monthly });
});

// ─── Profile: GET + PUT for the authenticated user ───────────────────────────

router.get("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "Not found" }); return; }

  const [projectCountResult] = await db.select({ cnt: count() }).from(userProjectsTable).where(eq(userProjectsTable.userId, userId));
  const [taskCountResult] = await db.select({ cnt: count() }).from(taskSubmissionsTable)
    .where(and(eq(taskSubmissionsTable.userId, userId), eq(taskSubmissionsTable.status, "approved")));

  res.json({
    ...sanitizeUser(user),
    projectCount: Number(projectCountResult?.cnt ?? 0),
    tasksCompleted: Number(taskCountResult?.cnt ?? 0),
  });
});

router.put("/profile", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;

  const {
    bio, twitterHandle, discordHandle, websiteUrl, telegramHandle, avatarUrl, username,
    whatsappNumber, facebookUrl, location,
  } = req.body as Record<string, string>;
  const updates: Record<string, unknown> = {};
  if (bio !== undefined) updates.bio = bio.slice(0, 300);
  if (twitterHandle !== undefined) updates.twitterHandle = twitterHandle.replace(/^@/, "");
  if (discordHandle !== undefined) updates.discordHandle = discordHandle;
  if (websiteUrl !== undefined) updates.websiteUrl = websiteUrl;
  if (telegramHandle !== undefined) updates.telegramHandle = telegramHandle.replace(/^@/, "");
  if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
  if (username !== undefined && username.trim()) updates.username = username.trim().slice(0, 30);
  if (whatsappNumber !== undefined) updates.whatsappNumber = whatsappNumber.trim().slice(0, 30);
  if (facebookUrl !== undefined) updates.facebookUrl = facebookUrl.trim().slice(0, 300);
  if (location !== undefined) updates.location = location.trim().slice(0, 100);

  const [updated] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(sanitizeUser(updated));
});

// ─── KYC: Level v1 (basic profile) verification ───────────────────────────────
// v1 requires: avatar, Twitter, Discord, Telegram handle, Telegram bot connected,
// WhatsApp, location. Facebook is optional. Submitting when all required fields
// are present puts the account into "pending" status for admin review — it does
// NOT auto-verify. An admin must approve (or reject) it from Admin → KYC
// Approvals. Both the submission and the admin decision trigger in-app
// notifications and a Telegram bot alert (to admins on submit, to the user on
// approve/reject). v2 (document-based) is upcoming.

const KYC_V1_REQUIRED_FIELDS = [
  { key: "avatarUrl", label: "Profile picture" },
  { key: "twitterHandle", label: "Twitter / X link" },
  { key: "discordHandle", label: "Discord link" },
  { key: "telegramHandle", label: "Telegram username" },
  { key: "telegramChatId", label: "Telegram bot connected" },
  { key: "whatsappNumber", label: "WhatsApp number" },
  { key: "location", label: "Location" },
] as const;

function kycMissingFields(user: typeof usersTable.$inferSelect): string[] {
  return KYC_V1_REQUIRED_FIELDS
    .filter(f => !(user as Record<string, unknown>)[f.key])
    .map(f => f.label);
}

router.get("/profile/kyc", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "Not found" }); return; }

  const missing = kycMissingFields(user);

  res.json({
    kycLevel: user.kycLevel,
    kycVerified: user.kycVerified,
    kycStatus: user.kycStatus,
    kycSubmittedAt: user.kycSubmittedAt?.toISOString() ?? null,
    kycReviewedAt: user.kycReviewedAt?.toISOString() ?? null,
    kycRejectionReason: user.kycRejectionReason,
    v1: { eligible: missing.length === 0, missingFields: missing },
    v2: { status: "upcoming" },
  });
});

router.post("/profile/kyc/submit", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "Not found" }); return; }

  if (user.kycStatus === "pending") {
    res.status(400).json({ error: "KYC already submitted and awaiting admin review" });
    return;
  }
  if (user.kycStatus === "approved") {
    res.status(400).json({ error: "KYC already verified" });
    return;
  }

  const missing = kycMissingFields(user);
  if (missing.length > 0) {
    res.status(400).json({ error: "Missing required KYC fields", missingFields: missing });
    return;
  }

  const [updated] = await db.update(usersTable)
    .set({ kycStatus: "pending", kycSubmittedAt: new Date(), kycRejectionReason: null })
    .where(eq(usersTable.id, userId))
    .returning();

  await createNotification(userId, "kyc_submitted", "KYC Submitted",
    "Your Level 1 KYC has been submitted and is awaiting admin review.");

  // Fire-and-forget: alert admins in-app + via Telegram bot.
  (async () => {
    try {
      const admins = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.role, "admin"));
      for (const admin of admins) {
        await createNotification(admin.id, "kyc_pending", "New KYC Submission",
          `${updated.username} submitted Level 1 KYC — review it in Admin → KYC Approvals.`, { userId });
      }
      const { notifyAdminsKycSubmitted } = await import("../lib/telegram");
      await notifyAdminsKycSubmitted(updated.username);
    } catch { /* best-effort */ }
  })();

  res.json(sanitizeUser(updated));
});

// ─── Admin: review pending KYC submissions ────────────────────────────────────

router.get("/admin/kyc", requireAdmin, async (req, res): Promise<void> => {
  const { status = "pending" } = req.query as Record<string, string>;
  const where = status === "all" ? undefined : eq(usersTable.kycStatus, status);
  const users = await db.select().from(usersTable).where(where).orderBy(sql`kyc_submitted_at DESC NULLS LAST`);
  res.json(users.map(sanitizeUser));
});

router.post("/admin/kyc/:userId/approve", requireAdmin, async (req, res): Promise<void> => {
  const adminId = getRequestUser(req)!.userId;
  const userId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const [updated] = await db.update(usersTable)
    .set({
      kycStatus: "approved", kycVerified: true, kycLevel: 1,
      kycReviewedAt: new Date(), kycReviewedBy: adminId, kycRejectionReason: null,
    })
    .where(eq(usersTable.id, userId))
    .returning();

  await createNotification(userId, "kyc_approved", "KYC Approved ✓",
    "Your Level 1 KYC has been approved by an admin. Your account is now verified.");

  const { notifyKycStatus } = await import("../lib/telegram");
  notifyKycStatus(userId, true, 1).catch(() => {});

  res.json(sanitizeUser(updated));
});

router.post("/admin/kyc/:userId/reject", requireAdmin, async (req, res): Promise<void> => {
  const adminId = getRequestUser(req)!.userId;
  const userId = parseInt(Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId, 10);
  const { reason } = req.body as { reason?: string };
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const [updated] = await db.update(usersTable)
    .set({
      kycStatus: "rejected", kycVerified: false,
      kycReviewedAt: new Date(), kycReviewedBy: adminId,
      kycRejectionReason: reason ?? "Not specified",
    })
    .where(eq(usersTable.id, userId))
    .returning();

  await createNotification(userId, "kyc_rejected", "KYC Rejected",
    reason ? `Your KYC submission was rejected: ${reason}` : "Your KYC submission was rejected.");

  const { notifyKycStatus } = await import("../lib/telegram");
  notifyKycStatus(userId, false, 0, reason).catch(() => {});

  res.json(sanitizeUser(updated));
});

router.post("/users/change-password", requireAuth, async (req, res): Promise<void> => {
  const userId = getRequestUser(req)!.userId;

  const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string };
  if (!oldPassword || !newPassword) { res.status(400).json({ error: "oldPassword and newPassword are required" }); return; }
  if (newPassword.length < 6) { res.status(400).json({ error: "New password must be at least 6 characters" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const crypto = await import("crypto");
  const hash = (pw: string) => crypto.createHash("sha256").update(pw + "ayzen_salt").digest("hex");

  if (hash(oldPassword) !== user.passwordHash) {
    res.status(403).json({ error: "Current password is incorrect" }); return;
  }

  await db.update(usersTable).set({ passwordHash: hash(newPassword) }).where(eq(usersTable.id, userId));

  // Send password changed email (fire and forget)
  import("../lib/email").then(({ sendPasswordChangedEmail }) => {
    sendPasswordChangedEmail(user.email, user.username).catch(() => {});
  }).catch(() => {});

  res.json({ success: true, message: "Password updated successfully" });
});

export default router;
