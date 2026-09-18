/**
 * lib/mail-recipient-reputation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bounce + Complaint Handling (Phase 1) — recipient reputation for outbound
 * mail, one row per (user, recipient email) in
 * ayzen_mailbox_recipient_reputation (see
 * migrations/052_ayzen_mailbox_bounce_complaint.sql). The outbound mirror of
 * lib/mail-spam.ts's sender reputation for inbound — same shape, same
 * "fixed thresholds a user can reason about" philosophy, deliberately not a
 * scored/ML classifier.
 *
 * Called from routes/resend-webhook.ts's handleDeliveryEvent() as each
 * Resend outbound lifecycle event comes in:
 *
 *   email.bounced    -> recordBounce()      -> may flag the address
 *   email.complained -> recordComplaint()   -> always blocks the address
 *   email.delivered  -> recordDelivery()    -> resets the bounce streak
 *
 * Phase 1 only *records* reputation and notifies the user — nothing here
 * stops a send. Phase 2 is what makes routes/ayzen-mailbox.ts's POST /send
 * actually call getRecipientStatus() and warn/block before sending to a
 * flagged/blocked address. getRecipientStatus() and listProblematicRecipients()
 * already exist below so Phase 2 has something to call.
 */
import { db, ayzenMailboxRecipientReputationTable, type AyzenRecipientStatus } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getSendingConfig } from "./mail-sending-config";

// How many *consecutive* bounces (no successful delivery in between) before
// an address is auto-flagged. Deliberately more than 1 — a single bounce is
// often transient (mailbox full, receiving server hiccup), so this only
// fires once bouncing looks like a pattern rather than a blip.
// Bounce + Complaint Handling (Phase 3): now admin-tunable — see
// ayzen_mailbox_sending_config.bounce_flag_threshold (migrations/053) and
// lib/mail-sending-config.ts. This was a hardcoded constant in Phase 2.

function findReputation(userId: number, email: string) {
  return db.select().from(ayzenMailboxRecipientReputationTable)
    .where(and(
      eq(ayzenMailboxRecipientReputationTable.userId, userId),
      sql`lower(${ayzenMailboxRecipientReputationTable.email}) = ${email}`,
    ));
}

async function getOrCreateReputation(userId: number, email: string) {
  const [existing] = await findReputation(userId, email);
  if (existing) return existing;
  const [created] = await db.insert(ayzenMailboxRecipientReputationTable)
    .values({ userId, email }).onConflictDoNothing().returning();
  if (created) return created;
  // Lost a create race against a concurrent call for the same recipient
  // (e.g. two webhook events for the same address landing at once) — the
  // other insert already won, just read it back.
  const [row] = await findReputation(userId, email);
  return row;
}

export async function getRecipientStatus(userId: number, rawEmail: string): Promise<AyzenRecipientStatus> {
  const email = rawEmail.trim().toLowerCase();
  const [row] = await findReputation(userId, email);
  return (row?.status as AyzenRecipientStatus | undefined) ?? "ok";
}

/**
 * A hard bounce for this (user, recipient). Bumps both the lifetime
 * bounce_count and the consecutive-bounce streak; once the streak crosses
 * BOUNCE_FLAG_THRESHOLD, flags the address (if it isn't already flagged or
 * blocked — blocked stays blocked, and re-flagging an already-flagged
 * address would just clobber the original flagged_at for no reason).
 *
 * Returns whether this call is what pushed the address into 'flagged', so
 * the webhook handler knows whether to fire the extra "address flagged"
 * notification on top of the per-message bounce notification.
 */
export async function recordBounce(userId: number, rawEmail: string): Promise<{ status: AyzenRecipientStatus; justFlagged: boolean }> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { status: "ok", justFlagged: false };
  const row = await getOrCreateReputation(userId, email);
  if (!row) return { status: "ok", justFlagged: false };

  const consecutiveBounces = row.consecutiveBounces + 1;
  const bounceFlagThreshold = (await getSendingConfig()).bounceFlagThreshold;
  const shouldFlag = row.status === "ok" && consecutiveBounces >= bounceFlagThreshold;
  const status: AyzenRecipientStatus = shouldFlag ? "flagged" : (row.status as AyzenRecipientStatus);

  await db.update(ayzenMailboxRecipientReputationTable).set({
    bounceCount: row.bounceCount + 1,
    consecutiveBounces,
    lastBounceAt: new Date(),
    status,
    ...(shouldFlag ? { flaggedAt: new Date() } : {}),
  }).where(eq(ayzenMailboxRecipientReputationTable.id, row.id));

  return { status, justFlagged: shouldFlag };
}

/**
 * A spam complaint for this (user, recipient). Unlike bounces, one
 * complaint is enough — matches how real ESPs/mailbox providers treat a
 * complaint as a hard signal the recipient doesn't want mail from this
 * sender, not something that needs a pattern to confirm. Always escalates
 * straight to 'blocked' regardless of current status.
 *
 * Returns whether the address was *not already* blocked before this call,
 * so the webhook handler can decide whether the "address blocked" flag
 * notification is new information or a repeat.
 */
export async function recordComplaint(userId: number, rawEmail: string): Promise<{ justBlocked: boolean }> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return { justBlocked: false };
  const row = await getOrCreateReputation(userId, email);
  if (!row) return { justBlocked: false };

  const justBlocked = row.status !== "blocked";

  await db.update(ayzenMailboxRecipientReputationTable).set({
    complaintCount: row.complaintCount + 1,
    lastComplaintAt: new Date(),
    status: "blocked",
    ...(justBlocked ? { flaggedAt: new Date() } : {}),
  }).where(eq(ayzenMailboxRecipientReputationTable.id, row.id));

  return { justBlocked };
}

// A successful delivery to this recipient — resets the consecutive-bounce
// streak (repeated *failures* is the signal a flag should track, not a
// lifetime tally: an address that bounced a few times long ago and has
// delivered fine since isn't currently problematic). Does not touch
// status — an address a user already flagged/blocked stays that way until
// they clear it themselves; one delivery succeeding doesn't erase a spam
// complaint.
export async function recordDelivery(userId: number, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!email) return;
  const [row] = await findReputation(userId, email);
  if (!row) return; // never bounced/complained before — nothing to reset
  if (row.consecutiveBounces === 0 && row.lastDeliveredAt) return; // nothing changed
  await db.update(ayzenMailboxRecipientReputationTable)
    .set({ consecutiveBounces: 0, lastDeliveredAt: new Date() })
    .where(eq(ayzenMailboxRecipientReputationTable.id, row.id));
}

// Manually clears a flag/block a user set (or that accumulated
// automatically) — e.g. a "This isn't actually a bad address" action.
// Resets the counters too, not just status, so a cleared address starts
// clean rather than one more bounce away from re-flagging instantly.
export async function clearRecipientFlag(userId: number, rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  const [row] = await findReputation(userId, email);
  if (!row) return;
  await db.update(ayzenMailboxRecipientReputationTable).set({
    status: "ok",
    consecutiveBounces: 0,
    flaggedAt: null,
  }).where(eq(ayzenMailboxRecipientReputationTable.id, row.id));
}

// Powers a "problematic recipients" list — flagged/blocked addresses only,
// newest flag first.
export async function listProblematicRecipients(userId: number) {
  return db.select().from(ayzenMailboxRecipientReputationTable)
    .where(and(eq(ayzenMailboxRecipientReputationTable.userId, userId), sql`status != 'ok'`))
    .orderBy(sql`flagged_at DESC NULLS LAST`);
}

/**
 * Bounce + Complaint Handling (Phase 2) — the send-time enforcement piece
 * Phase 1 deliberately left undone. Called from routes/ayzen-mailbox.ts's
 * POST /send with every To/Cc/Bcc address on the outgoing message, before
 * the send is actually queued.
 *
 * 'blocked' (at least one spam complaint, or a manual block) always hard-
 * stops the send — no override, same as the plan's "hard block for
 * blocked": the only way past it is clearing the flag first via
 * DELETE /problematic-recipients/:email. 'flagged' (repeated bounces)
 * doesn't stop anything itself — it's returned so the route can ask the
 * caller to confirm, which is a softer gate than 'blocked' gets since a
 * bounce streak is a weaker signal than an actual complaint.
 */
export async function checkOutboundRecipients(userId: number, rawEmails: string[]): Promise<{
  blocked: string[];
  flagged: { email: string; bounceCount: number; consecutiveBounces: number }[];
}> {
  const blocked: string[] = [];
  const flagged: { email: string; bounceCount: number; consecutiveBounces: number }[] = [];

  // Dedupe (the same address can legitimately appear in both To and Cc) so
  // the caller doesn't see it listed twice.
  const seen = new Set<string>();
  for (const raw of rawEmails) {
    const email = raw.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const [row] = await findReputation(userId, email);
    if (!row) continue;
    if (row.status === "blocked") blocked.push(email);
    else if (row.status === "flagged") flagged.push({ email, bounceCount: row.bounceCount, consecutiveBounces: row.consecutiveBounces });
  }

  return { blocked, flagged };
}
