/**
 * lib/mail-notification-digest.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bounce + Complaint Handling (Phase 4) — digest/batching for the
 * per-message "Message bounced" / "Spam complaint received" notifications
 * Phase 1 fires individually (routes/resend-webhook.ts). Fine for an
 * occasional bounce, noisy for a high-volume sender having a genuinely
 * bad stretch. Reuses Phase 3's per-user ayzen_mailbox_sending_health row
 * rather than adding a new table — see migrations/054 for what each new
 * column means.
 *
 * Deliberately does NOT touch the other Bounce + Complaint notifications
 * (per-recipient "address flagged/blocked" from Phase 1/2, or the
 * account-wide "sending paused" from Phase 3) — those already only fire
 * once per threshold crossing, not once per event, so they're not the
 * noisy ones this is for.
 *
 * Flow:
 *   shouldNotifyIndividually(userId, kind) -> called from
 *     routes/resend-webhook.ts BEFORE inserting the per-message
 *     notification; returns false (and quietly accumulates a pending
 *     count instead) once this user has had too many individual
 *     notifications in too short a window.
 *   startMailDigestCron() -> called once at boot (index.ts), same
 *     node-cron pattern as lib/mail-schedule-cron.ts's backstop sweep.
 *     On each tick, flushPendingDigests() sends ONE summary notification
 *     per user with anything pending, then zeroes the pending counts and
 *     the burst counter — so the next quiet period goes back to
 *     individual notifications rather than staying in digest mode
 *     forever.
 */
import { db, ayzenMailboxSendingHealthTable, notificationsTable } from "@workspace/db";
import { eq, or, gt } from "drizzle-orm";
import cron from "node-cron";
import { getSendingConfig } from "./mail-sending-config";
import { getOrCreateHealth } from "./mail-sending-health";
import { logger } from "./logger";
import { logBus } from "./log-bus";

const MS_PER_MIN = 60_000;

export type DigestNotificationKind = "bounce" | "complaint";

// Called from routes/resend-webhook.ts right before it would otherwise
// insert an individual "Message bounced"/"Spam complaint received"
// notification. Returns true if that individual notification should still
// go out; false if this event has instead been folded into this user's
// pending digest count (caller should skip the individual insert).
export async function shouldNotifyIndividually(userId: number, kind: DigestNotificationKind): Promise<boolean> {
  const config = await getSendingConfig();
  const row = await getOrCreateHealth(userId);

  const windowExpired = !row.burstWindowStartedAt
    || Date.now() - row.burstWindowStartedAt.getTime() > config.digestBurstMinutes * MS_PER_MIN;

  const burstCount = (windowExpired ? 0 : row.burstNotifCount) + 1;
  const sendIndividually = burstCount <= config.digestTriggerCount;

  await db.update(ayzenMailboxSendingHealthTable).set({
    burstNotifCount: burstCount,
    ...(windowExpired ? { burstWindowStartedAt: new Date() } : {}),
    ...(sendIndividually ? {} : {
      digestPendingBounces: kind === "bounce" ? row.digestPendingBounces + 1 : row.digestPendingBounces,
      digestPendingComplaints: kind === "complaint" ? row.digestPendingComplaints + 1 : row.digestPendingComplaints,
    }),
  }).where(eq(ayzenMailboxSendingHealthTable.id, row.id));

  return sendIndividually;
}

// One flush pass — sends a single batched notification per user with
// anything pending, then resets both the pending counts AND the burst
// counter (so a user who's gone quiet since the last flush drops back
// into "every bounce notifies individually" rather than being stuck in
// digest mode from one old burst forever).
export async function flushPendingDigests(): Promise<{ usersFlushed: number }> {
  const pending = await db.select().from(ayzenMailboxSendingHealthTable)
    .where(or(gt(ayzenMailboxSendingHealthTable.digestPendingBounces, 0), gt(ayzenMailboxSendingHealthTable.digestPendingComplaints, 0)));

  for (const row of pending) {
    const parts: string[] = [];
    if (row.digestPendingBounces > 0) parts.push(`${row.digestPendingBounces} message${row.digestPendingBounces === 1 ? "" : "s"} bounced`);
    if (row.digestPendingComplaints > 0) parts.push(`${row.digestPendingComplaints} spam complaint${row.digestPendingComplaints === 1 ? "" : "s"}`);

    await db.insert(notificationsTable).values({
      userId: row.userId,
      type: "mail",
      title: "Bounce/complaint summary",
      message: `Since your last update: ${parts.join(" and ")}. Individual notifications paused while your volume was high — see Sending Health in Settings for details.`,
      data: JSON.stringify({ bounces: row.digestPendingBounces, complaints: row.digestPendingComplaints }),
    });

    await db.update(ayzenMailboxSendingHealthTable).set({
      digestPendingBounces: 0,
      digestPendingComplaints: 0,
      burstNotifCount: 0,
      burstWindowStartedAt: null,
      lastDigestSentAt: new Date(),
    }).where(eq(ayzenMailboxSendingHealthTable.id, row.id));
  }

  return { usersFlushed: pending.length };
}

let scheduled = false;

// Mirrors lib/mail-schedule-cron.ts's startMailScheduleCron() exactly —
// same guard-against-double-init, same env-var-overridable expression,
// same "validate before scheduling" defensiveness. Cadence defaults to
// every 15 minutes; MAIL_DIGEST_CRON overrides it same as
// MAIL_SCHEDULE_CRON does for the other cron.
export function startMailDigestCron(): void {
  if (scheduled) return;
  scheduled = true;

  const expr = process.env.MAIL_DIGEST_CRON ?? "*/15 * * * *";
  if (!cron.validate(expr)) {
    logger.warn({ expr }, "MAIL_DIGEST_CRON is not a valid cron expression — bounce/complaint digest flush disabled");
    logBus.warn(`Bounce/complaint digest flush disabled: invalid schedule "${expr}"`);
    return;
  }

  cron.schedule(expr, () => {
    flushPendingDigests().catch((err) => {
      logger.error({ err }, "Bounce/complaint digest flush failed");
      logBus.error(`Bounce/complaint digest flush failed: ${err?.message ?? err}`);
    });
  });

  logBus.system(`✅ Bounce/complaint digest flush scheduled ("${expr}")`);
  logger.info({ expr }, "Bounce/complaint digest flush scheduled");
}
