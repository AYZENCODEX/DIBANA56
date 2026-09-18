import { Router } from "express";
import { db, usersTable, referralsTable } from "@workspace/db";
import { eq, desc, count, and, sql } from "drizzle-orm";
import * as crypto from "crypto";
import { requireAuth, requireAdmin, getRequestUser } from "../middlewares/auth";

const router = Router();

function generateReferralCode(): string {
  return "AYZN" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// ── GET /api/referrals/me — my code + stats ────────────────────────────────
router.get("/referrals/me", requireAuth, async (req, res): Promise<void> => {
  const auth = getRequestUser(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  // Generate code if missing
  let code = user.referralCode;
  if (!code) {
    let unique = false;
    while (!unique) {
      code = generateReferralCode();
      const existing = await db.select().from(usersTable).where(eq(usersTable.referralCode, code));
      if (existing.length === 0) unique = true;
    }
    await db.update(usersTable).set({ referralCode: code }).where(eq(usersTable.id, auth.userId));
  }

  const refs = await db.select().from(referralsTable).where(eq(referralsTable.referrerId, auth.userId));
  const totalRewards = refs.reduce((s, r) => s + (r.rewardPaid ? r.rewardAmount : 0), 0);
  const pendingRewards = refs.reduce((s, r) => s + (!r.rewardPaid ? r.rewardAmount : 0), 0);

  res.json({
    code,
    link: `https://ayzen.tech/ref/${code}`,
    totalReferrals: refs.length,
    paidReferrals: refs.filter(r => r.rewardPaid).length,
    pendingReferrals: refs.filter(r => !r.rewardPaid).length,
    totalRewards,
    pendingRewards,
    rewardPerReferral: 10,
  });
});

// ── GET /api/referrals/list — referred users ───────────────────────────────
router.get("/referrals/list", requireAuth, async (req, res): Promise<void> => {
  const auth = getRequestUser(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const rows = await db
    .select({
      referralId: referralsTable.id,
      referredId: referralsTable.referredId,
      codeUsed: referralsTable.codeUsed,
      rewardAmount: referralsTable.rewardAmount,
      rewardPaid: referralsTable.rewardPaid,
      paidAt: referralsTable.paidAt,
      createdAt: referralsTable.createdAt,
      username: usersTable.username,
      email: usersTable.email,
      status: usersTable.status,
      joinedAt: usersTable.createdAt,
    })
    .from(referralsTable)
    .innerJoin(usersTable, eq(referralsTable.referredId, usersTable.id))
    .where(eq(referralsTable.referrerId, auth.userId))
    .orderBy(desc(referralsTable.createdAt));

  res.json(rows.map(r => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    paidAt: r.paidAt?.toISOString() ?? null,
    joinedAt: r.joinedAt.toISOString(),
  })));
});

// ── POST /api/referrals/apply — apply someone's code ──────────────────────
router.post("/referrals/apply", requireAuth, async (req, res): Promise<void> => {
  const auth = getRequestUser(req);
  if (!auth) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { code } = req.body as { code: string };
  if (!code) { res.status(400).json({ error: "code is required" }); return; }

  const [me] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!me) { res.status(404).json({ error: "User not found" }); return; }
  if (me.referredBy) { res.status(400).json({ error: "You already used a referral code" }); return; }

  const [referrer] = await db.select().from(usersTable).where(eq(usersTable.referralCode, code.toUpperCase().trim()));
  if (!referrer) { res.status(404).json({ error: "Invalid referral code" }); return; }
  if (referrer.id === auth.userId) { res.status(400).json({ error: "Cannot use your own referral code" }); return; }

  await db.update(usersTable).set({ referredBy: referrer.id }).where(eq(usersTable.id, auth.userId));
  await db.insert(referralsTable).values({
    referrerId: referrer.id,
    referredId: auth.userId,
    codeUsed: code.toUpperCase().trim(),
    rewardAmount: 10,
    rewardPaid: false,
  });

  res.json({ message: "Referral code applied successfully", referrerUsername: referrer.username });
});

// ── GET /api/admin/referrals — admin: all referrals ───────────────────────
router.get("/admin/referrals", requireAdmin, async (req, res): Promise<void> => {

  const { status, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = parseInt(page, 10);
  const limitNum = Math.min(parseInt(limit, 10), 100);
  const offset = (pageNum - 1) * limitNum;

  const referrer = usersTable;
  const referred = { ...usersTable } as typeof usersTable;

  const rows = await db
    .select({
      id: referralsTable.id,
      codeUsed: referralsTable.codeUsed,
      rewardAmount: referralsTable.rewardAmount,
      rewardPaid: referralsTable.rewardPaid,
      paidAt: referralsTable.paidAt,
      createdAt: referralsTable.createdAt,
      referrerId: referralsTable.referrerId,
      referredId: referralsTable.referredId,
    })
    .from(referralsTable)
    .orderBy(desc(referralsTable.createdAt))
    .limit(limitNum)
    .offset(offset);

  // Enrich with usernames
  const allUserIds = [...new Set(rows.flatMap(r => [r.referrerId, r.referredId]))];
  const users = allUserIds.length > 0
    ? await db.select({ id: usersTable.id, username: usersTable.username, email: usersTable.email })
        .from(usersTable)
        .where(sql`${usersTable.id} = ANY(${sql.raw(`ARRAY[${allUserIds.join(",")}]::int[]`)})`)
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  const [{ total }] = await db.select({ total: count() }).from(referralsTable);

  // Stats
  const [{ totalRefs }] = await db.select({ totalRefs: count() }).from(referralsTable);
  const [{ paidRefs }] = await db.select({ paidRefs: count() }).from(referralsTable).where(eq(referralsTable.rewardPaid, true));
  const [{ uniqueReferrers }] = await db.select({ uniqueReferrers: sql<number>`count(distinct referrer_id)` }).from(referralsTable);
  const totalRewardsResult = await db.select({ total: sql<number>`COALESCE(SUM(reward_amount), 0)` }).from(referralsTable).where(eq(referralsTable.rewardPaid, true));

  res.json({
    referrals: rows.map(r => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      paidAt: r.paidAt?.toISOString() ?? null,
      referrerUsername: userMap[r.referrerId]?.username ?? `User#${r.referrerId}`,
      referrerEmail: userMap[r.referrerId]?.email ?? "",
      referredUsername: userMap[r.referredId]?.username ?? `User#${r.referredId}`,
      referredEmail: userMap[r.referredId]?.email ?? "",
    })),
    total: Number(total),
    stats: {
      totalReferrals: Number(totalRefs),
      paidReferrals: Number(paidRefs),
      uniqueReferrers: Number(uniqueReferrers),
      totalRewardsPaid: Number(totalRewardsResult[0]?.total ?? 0),
    },
  });
});

// ── PATCH /api/admin/referrals/:id/reward — mark paid ─────────────────────
router.patch("/admin/referrals/:id/reward", requireAdmin, async (req, res): Promise<void> => {

  const id = parseInt(req.params.id as string, 10);
  const [updated] = await db.update(referralsTable)
    .set({ rewardPaid: true, paidAt: new Date() })
    .where(eq(referralsTable.id, id))
    .returning();

  if (!updated) { res.status(404).json({ error: "Referral not found" }); return; }
  res.json({ ...updated, createdAt: updated.createdAt.toISOString(), paidAt: updated.paidAt?.toISOString() ?? null });
});

// ── GET /api/admin/referrals/leaderboard ──────────────────────────────────
router.get("/admin/referrals/leaderboard", requireAdmin, async (req, res): Promise<void> => {

  const rows = await db
    .select({
      referrerId: referralsTable.referrerId,
      total: count(),
      paid: sql<number>`COUNT(*) FILTER (WHERE reward_paid = true)`,
      earnings: sql<number>`COALESCE(SUM(reward_amount) FILTER (WHERE reward_paid = true), 0)`,
    })
    .from(referralsTable)
    .groupBy(referralsTable.referrerId)
    .orderBy(desc(count()))
    .limit(10);

  const ids = rows.map(r => r.referrerId);
  const users = ids.length > 0
    ? await db.select({ id: usersTable.id, username: usersTable.username, email: usersTable.email, referralCode: usersTable.referralCode })
        .from(usersTable)
        .where(sql`${usersTable.id} = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`)
    : [];
  const userMap = Object.fromEntries(users.map(u => [u.id, u]));

  res.json(rows.map(r => ({
    referrerId: r.referrerId,
    username: userMap[r.referrerId]?.username ?? `User#${r.referrerId}`,
    code: userMap[r.referrerId]?.referralCode ?? "",
    totalReferrals: Number(r.total),
    paidReferrals: Number(r.paid),
    totalEarnings: Number(r.earnings),
  })));
});

export default router;
