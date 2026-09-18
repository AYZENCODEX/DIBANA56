import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";

const router = Router();

// XP per day (caps at day 30)
function calcXP(streakDay: number): number {
  if (streakDay >= 30) return 150;
  if (streakDay >= 14) return 75;
  if (streakDay >= 7)  return 50;
  if (streakDay >= 3)  return 25;
  return 10;
}

// AZN per day
function calcAZN(streakDay: number): number {
  if (streakDay >= 30) return 5;
  if (streakDay >= 14) return 2;
  if (streakDay >= 7)  return 1;
  if (streakDay >= 3)  return 0.5;
  return 0.1;
}

// Milestone labels
function getMilestone(day: number): string | null {
  if (day === 3)  return "3-Day Streak 🔥";
  if (day === 7)  return "7-Day Streak ⚡";
  if (day === 14) return "2-Week Veteran 💎";
  if (day === 30) return "30-Day Legend 🏆";
  if (day === 100) return "100-Day Master 👑";
  return null;
}

// ─── GET /checkin/status ───────────────────────────────────────────────────────
router.get("/checkin/status", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    // Latest checkin
    const lastR = await pool.query(
      `SELECT checked_in_date, streak_day, xp_earned, azn_earned
       FROM user_checkins WHERE user_id=$1 ORDER BY checked_in_date DESC LIMIT 1`,
      [userId]
    );
    const todayStr = new Date().toISOString().slice(0, 10);
    const last = lastR.rows[0] ?? null;
    const lastDateStr = last?.checked_in_date
      ? new Date(last.checked_in_date).toISOString().slice(0, 10)
      : null;

    const checkedInToday = lastDateStr === todayStr;
    // Streak: if last checkin was yesterday, streak is still active
    const yesterdayStr = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const streakAlive = lastDateStr === todayStr || lastDateStr === yesterdayStr;
    const currentStreak = streakAlive ? (last?.streak_day ?? 0) : 0;
    const nextStreak = currentStreak + 1;

    // Total stats
    const totalR = await pool.query(
      `SELECT COUNT(*) as days, COALESCE(SUM(xp_earned),0) as total_xp, COALESCE(SUM(azn_earned),0) as total_azn
       FROM user_checkins WHERE user_id=$1`,
      [userId]
    );
    const stats = totalR.rows[0];

    // Recent 7 checkins for calendar
    const recentR = await pool.query(
      `SELECT checked_in_date FROM user_checkins WHERE user_id=$1 ORDER BY checked_in_date DESC LIMIT 7`,
      [userId]
    );
    const recentDates = recentR.rows.map(r => new Date(r.checked_in_date).toISOString().slice(0, 10));

    res.json({
      checkedInToday,
      currentStreak,
      nextStreak,
      nextXP: calcXP(nextStreak),
      nextAZN: calcAZN(nextStreak),
      nextMilestone: getMilestone(nextStreak),
      totalDays: Number(stats.days),
      totalXP: Number(stats.total_xp),
      totalAZN: Number(stats.total_azn),
      recentDates,
      lastCheckin: last,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─── POST /checkin ─────────────────────────────────────────────────────────────
router.post("/checkin", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const todayStr = new Date().toISOString().slice(0, 10);

    // Check already done today
    const todayR = await client.query(
      `SELECT id FROM user_checkins WHERE user_id=$1 AND checked_in_date::date = $2::date FOR UPDATE`,
      [userId, todayStr]
    );
    if (todayR.rows.length > 0) {
      await client.query("ROLLBACK");
      res.status(400).json({ error: "Already checked in today!" });
      return;
    }

    // Get last checkin to determine streak
    const lastR = await client.query(
      `SELECT checked_in_date, streak_day FROM user_checkins WHERE user_id=$1 ORDER BY checked_in_date DESC LIMIT 1`,
      [userId]
    );
    const last = lastR.rows[0];
    const yesterdayStr = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    const lastDateStr = last?.checked_in_date
      ? new Date(last.checked_in_date).toISOString().slice(0, 10)
      : null;

    const prevStreak = lastDateStr === yesterdayStr ? (last?.streak_day ?? 0) : 0;
    const streakDay = prevStreak + 1;
    const xpEarned = calcXP(streakDay);
    const aznEarned = calcAZN(streakDay);
    const milestone = getMilestone(streakDay);

    // Insert checkin
    await client.query(
      `INSERT INTO user_checkins (user_id, checked_in_date, streak_day, xp_earned, azn_earned)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, todayStr, streakDay, xpEarned, aznEarned]
    );

    // Update streak counters on users table (best-effort; columns are optional)
    await client.query(
      `UPDATE users SET streak = $1, longest_streak = GREATEST(COALESCE(longest_streak, 0), $1) WHERE id = $2`,
      [streakDay, userId]
    );

    // Award AZN via credits table (upsert on user_id)
    await client.query(
      `INSERT INTO credits (user_id, balance, azn_balance, total_purchased, total_spent, created_at, updated_at)
       VALUES ($1, 0, $2, 0, 0, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET azn_balance = credits.azn_balance + $2, updated_at = NOW()`,
      [userId, aznEarned]
    );

    await client.query("COMMIT");

    res.json({
      ok: true,
      streakDay,
      xpEarned,
      aznEarned,
      milestone,
      message: milestone
        ? `🎉 ${milestone}! You earned ${xpEarned} XP + ${aznEarned} AZN`
        : `✅ Day ${streakDay} check-in! +${xpEarned} XP +${aznEarned} AZN`,
    });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── GET /checkin/history ──────────────────────────────────────────────────────
router.get("/checkin/history", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const r = await pool.query(
      `SELECT checked_in_date, streak_day, xp_earned, azn_earned
       FROM user_checkins WHERE user_id=$1 ORDER BY checked_in_date DESC LIMIT 90`,
      [userId]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
