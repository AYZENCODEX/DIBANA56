/**
 * lib/mail-sending-health.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bounce + Complaint Handling (Phase 3) — account-wide sending health.
 * Phase 1/2 only ever asked "is this ONE recipient a problem?"
 * (lib/mail-recipient-reputation.ts). This asks the broader question: is
 * this USER'S sending, in aggregate, starting to look bad enough to risk
 * the shared Resend domain's reputation? That's the actual thing real
 * ESPs rate-limit or suspend a sending domain over.
 *
 * Called from:
 *   lib/mail-send-queue.ts   -> recordSend()      after a message actually
 *                                                   goes out via Resend
 *   routes/resend-webhook.ts -> recordBounce()     alongside the existing
 *                                recordComplaint()  per-recipient calls
 *   routes/ayzen-mailbox.ts  -> getSendingHealth()  gates POST /send when
 *                                resumeSending()     status === 'paused',
 *                                                    and backs the Settings
 *                                                    health widget + its
 *                                                    resume button
 */
import { db, ayzenMailboxSendingHealthTable, notificationsTable, type AyzenSendingHealthStatus, type AyzenMailboxSendingHealth } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getSendingConfig } from "./mail-sending-config";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function getOrCreateHealth(userId: number): Promise<AyzenMailboxSendingHealth> {
  const [existing] = await db.select().from(ayzenMailboxSendingHealthTable).where(eq(ayzenMailboxSendingHealthTable.userId, userId));
  if (existing) return existing;
  const [created] = await db.insert(ayzenMailboxSendingHealthTable).values({ userId }).onConflictDoNothing().returning();
  if (created) return created;
  const [row] = await db.select().from(ayzenMailboxSendingHealthTable).where(eq(ayzenMailboxSendingHealthTable.userId, userId));
  return row!;
}

// Rolls the window over if it's aged out, zeroing the windowed counters
// but never the lifetime totals. Doesn't touch status/pausedAt — rolling
// into a fresh window doesn't retroactively un-pause an account someone
// needs to actively resume (see resumeSendingHealth() below); it just
// means the *next* evaluation starts from a clean slate.
function rollWindowIfExpired(row: AyzenMailboxSendingHealth, windowDays: number): AyzenMailboxSendingHealth {
  const ageMs = Date.now() - row.windowStartedAt.getTime();
  if (ageMs < windowDays * MS_PER_DAY) return row;
  return { ...row, windowStartedAt: new Date(), sentInWindow: 0, bouncedInWindow: 0, complainedInWindow: 0 };
}

// Basis-point rate, or 0 below the configured minimum sample size — see
// migrations/053's comment on min_sample_size for why: a couple of bad
// sends out of three shouldn't read as a 33%+ bounce rate.
function rateBp(count: number, sent: number, minSample: number): number {
  if (sent < minSample) return 0;
  return Math.round((count / sent) * 10000);
}

function evaluateStatus(row: AyzenMailboxSendingHealth, config: Awaited<ReturnType<typeof getSendingConfig>>): { status: AyzenSendingHealthStatus; reason: string | null } {
  const bounceRate = rateBp(row.bouncedInWindow, row.sentInWindow, config.minSampleSize);
  const complaintRate = rateBp(row.complainedInWindow, row.sentInWindow, config.minSampleSize);

  if (row.complainedInWindow >= config.complaintHardCap) {
    return { status: "paused", reason: `${row.complainedInWindow} spam complaints in the current window` };
  }
  if (complaintRate >= config.pauseComplaintRateBp) {
    return { status: "paused", reason: `Complaint rate ${(complaintRate / 100).toFixed(2)}% is at/above the ${(config.pauseComplaintRateBp / 100).toFixed(2)}% limit` };
  }
  if (bounceRate >= config.pauseBounceRateBp) {
    return { status: "paused", reason: `Bounce rate ${(bounceRate / 100).toFixed(2)}% is at/above the ${(config.pauseBounceRateBp / 100).toFixed(2)}% limit` };
  }
  if (bounceRate >= config.warningBounceRateBp) {
    return { status: "warning", reason: `Bounce rate ${(bounceRate / 100).toFixed(2)}% is elevated` };
  }
  return { status: "healthy", reason: null };
}

async function applyEvaluation(row: AyzenMailboxSendingHealth): Promise<AyzenMailboxSendingHealth> {
  const config = await getSendingConfig();
  const rolled = rollWindowIfExpired(row, config.windowDays);
  const { status, reason } = evaluateStatus(rolled, config);

  // Never auto-downgrade OUT of 'paused' — only evaluateStatus() itself
  // escalating past the threshold, or the user explicitly calling
  // resumeSendingHealth(), can move an account off 'paused'. Otherwise a
  // single good send right after crossing the line would silently
  // unpause an account nobody looked at.
  const nextStatus: AyzenSendingHealthStatus = rolled.status === "paused" && status !== "paused" ? "paused" : status;
  const justPaused = nextStatus === "paused" && rolled.status !== "paused";

  const [updated] = await db.update(ayzenMailboxSendingHealthTable).set({
    windowStartedAt: rolled.windowStartedAt,
    sentInWindow: rolled.sentInWindow,
    bouncedInWindow: rolled.bouncedInWindow,
    complainedInWindow: rolled.complainedInWindow,
    totalSent: rolled.totalSent,
    totalBounced: rolled.totalBounced,
    totalComplained: rolled.totalComplained,
    status: nextStatus,
    updatedAt: new Date(),
    ...(justPaused ? { pausedAt: new Date(), pausedReason: reason } : {}),
  }).where(eq(ayzenMailboxSendingHealthTable.id, rolled.id)).returning();

  if (justPaused) {
    // A single choke point for the notification regardless of which of
    // recordSend/recordBounce/recordComplaint triggered the pause (in
    // practice always the latter two — see recordSend()'s comment).
    await db.insert(notificationsTable).values({
      userId: row.userId,
      type: "mail",
      title: "Sending paused",
      message: `Your account's sending has been paused: ${reason}. Review Problematic Recipients in Settings, then resume sending from there once you're ready.`,
      data: JSON.stringify({ reason }),
    });
  }

  return updated!;
}

// Called from lib/mail-send-queue.ts right after a message actually goes
// out via Resend (the "accepted" transition) — the denominator every rate
// above is measured against.
export async function recordSend(userId: number): Promise<void> {
  const row = await getOrCreateHealth(userId);
  const rolled = rollWindowIfExpired(row, (await getSendingConfig()).windowDays);
  await applyEvaluation({ ...rolled, sentInWindow: rolled.sentInWindow + 1, totalSent: rolled.totalSent + 1 });
}

// Called from routes/resend-webhook.ts's email.bounced handling, alongside
// the existing per-recipient recordBounce() from mail-recipient-reputation.ts.
export async function recordBounce(userId: number): Promise<void> {
  const row = await getOrCreateHealth(userId);
  const rolled = rollWindowIfExpired(row, (await getSendingConfig()).windowDays);
  await applyEvaluation({ ...rolled, bouncedInWindow: rolled.bouncedInWindow + 1, totalBounced: rolled.totalBounced + 1 });
}

// Called from routes/resend-webhook.ts's email.complained handling.
export async function recordComplaint(userId: number): Promise<void> {
  const row = await getOrCreateHealth(userId);
  const rolled = rollWindowIfExpired(row, (await getSendingConfig()).windowDays);
  await applyEvaluation({ ...rolled, complainedInWindow: rolled.complainedInWindow + 1, totalComplained: rolled.totalComplained + 1 });
}

// Read-only view for routes/ayzen-mailbox.ts's POST /send gate and the
// Settings health widget. Cheap — just rolls the window in memory for
// display, doesn't write (no reason to write on a read).
export async function getSendingHealth(userId: number) {
  const row = await getOrCreateHealth(userId);
  const config = await getSendingConfig();
  const rolled = rollWindowIfExpired(row, config.windowDays);
  return {
    status: rolled.status as AyzenSendingHealthStatus,
    pausedAt: rolled.pausedAt,
    pausedReason: rolled.pausedReason,
    sentInWindow: rolled.sentInWindow,
    bouncedInWindow: rolled.bouncedInWindow,
    complainedInWindow: rolled.complainedInWindow,
    totalSent: rolled.totalSent,
    totalBounced: rolled.totalBounced,
    totalComplained: rolled.totalComplained,
    bounceRateBp: rateBp(rolled.bouncedInWindow, rolled.sentInWindow, config.minSampleSize),
    complaintRateBp: rateBp(rolled.complainedInWindow, rolled.sentInWindow, config.minSampleSize),
    windowDays: config.windowDays,
    // Bounce + Complaint Handling (Phase 4) — digest state, so the
    // Settings widget can show "3 notifications batched" instead of
    // silently going quiet during a high-volume burst.
    digestPendingBounces: rolled.digestPendingBounces,
    digestPendingComplaints: rolled.digestPendingComplaints,
    lastDigestSentAt: rolled.lastDigestSentAt,
  };
}

// The user's explicit "I've fixed my list, let me send again" action
// (Settings → Problematic Recipients' sibling health widget). Re-evaluates
// from the account's CURRENT counts rather than force-clearing — if the
// window hasn't rolled over and the rate is still at/above the pause
// threshold, this re-evaluation lands right back on 'paused' and the
// caller is told so, rather than being allowed to immediately resume into
// the same problem.
export async function resumeSendingHealth(userId: number): Promise<{ resumed: boolean; status: AyzenSendingHealthStatus }> {
  const row = await getOrCreateHealth(userId);
  const config = await getSendingConfig();
  const rolled = rollWindowIfExpired(row, config.windowDays);
  const { status, reason } = evaluateStatus(rolled, config);

  const [updated] = await db.update(ayzenMailboxSendingHealthTable).set({
    windowStartedAt: rolled.windowStartedAt,
    sentInWindow: rolled.sentInWindow,
    bouncedInWindow: rolled.bouncedInWindow,
    complainedInWindow: rolled.complainedInWindow,
    status,
    updatedAt: new Date(),
    ...(status === "paused" ? { pausedAt: new Date(), pausedReason: reason } : { pausedAt: null, pausedReason: null }),
  }).where(eq(ayzenMailboxSendingHealthTable.id, rolled.id)).returning();

  return { resumed: status !== "paused", status: updated!.status as AyzenSendingHealthStatus };
}
