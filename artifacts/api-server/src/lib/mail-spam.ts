/**
 * lib/mail-spam.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Sender reputation for the native mailbox's Spam + Block feature — one row
 * per (user, sender email) in ayzen_mailbox_sender_reputation (see
 * migrations/046_ayzen_mailbox_spam_block.sql). Backs three things:
 *
 *   1. Block sender / Allow sender — routes/ayzen-mailbox.ts's
 *      POST /mailbox/senders/block|allow set `status`; consulted here by
 *      evaluateInboundReputation(), called from routes/resend-webhook.ts
 *      before a new inbound message is stored.
 *   2. "Mark spam" reporting — recordSpamReport() bumps a per-sender
 *      counter; once it crosses AUTO_SPAM_REPORT_THRESHOLD, that sender's
 *      future inbound auto-routes to Spam even without an explicit Block.
 *   3. Basic rate control — a rolling-window message count per sender;
 *      crossing RATE_LIMIT_MAX_PER_WINDOW auto-routes to Spam too, so a
 *      sudden flood from one address doesn't fill Inbox.
 *
 * Deliberately simple, same spirit as lib/mail-rules.ts: fixed thresholds a
 * user can reason about, not a scored/ML classifier. Never blocks storage
 * of a message — a blocked/flooding sender's mail is still kept, just
 * filed into Spam instead of Inbox, same as every other spam classification
 * in this mailbox.
 */
import { db, ayzenMailboxSenderReputationTable, type AyzenSenderStatus } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

const AUTO_SPAM_REPORT_THRESHOLD = 3;
const RATE_LIMIT_MAX_PER_WINDOW = 20;
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// Splits "Name <email@x.com>" (or a bare address) down to just the address,
// lowercased. Same shape as the local parseAddr() in routes/ayzen-mailbox.ts,
// duplicated here (rather than imported) since that one isn't exported and
// this needs to be usable from routes/resend-webhook.ts too.
export function extractEmail(raw: string): string {
  const first = raw.split(",")[0]?.trim() ?? raw.trim();
  const m = first.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
  return (m ? m[2]! : first).trim().toLowerCase();
}

// Same idea as extractEmail(), but for a raw To/Cc/Bcc field that may carry
// more than one comma-separated address — e.g. "a@x.com, "B" <b@x.com>".
// Used by the Bounce + Complaint Handling send-time check
// (lib/mail-recipient-reputation.ts's checkOutboundRecipients(), called
// from routes/ayzen-mailbox.ts's POST /send) to check every recipient on
// the message, not just the first.
export function extractAllEmails(raw: string): string[] {
  return raw.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^"?([^"<]*)"?\s*<([^>]+)>$/);
      return (m ? m[2]! : part).trim().toLowerCase();
    })
    .filter((email) => email.includes("@"));
}

function findReputation(userId: number, email: string) {
  return db.select().from(ayzenMailboxSenderReputationTable)
    .where(and(
      eq(ayzenMailboxSenderReputationTable.userId, userId),
      sql`lower(${ayzenMailboxSenderReputationTable.email}) = ${email}`,
    ));
}

async function getOrCreateReputation(userId: number, email: string) {
  const [existing] = await findReputation(userId, email);
  if (existing) return existing;
  const [created] = await db.insert(ayzenMailboxSenderReputationTable)
    .values({ userId, email }).onConflictDoNothing().returning();
  if (created) return created;
  // Lost a create race against a concurrent call for the same sender (e.g.
  // two inbound webhooks landing at once) — the other insert already won,
  // just read it back.
  const [row] = await findReputation(userId, email);
  return row;
}

export async function getSenderStatus(userId: number, rawEmail: string): Promise<AyzenSenderStatus> {
  const email = extractEmail(rawEmail);
  const [row] = await findReputation(userId, email);
  return (row?.status as AyzenSenderStatus | undefined) ?? "neutral";
}

export async function setSenderStatus(userId: number, rawEmail: string, status: AyzenSenderStatus): Promise<void> {
  const email = extractEmail(rawEmail);
  if (!email) return;
  const row = await getOrCreateReputation(userId, email);
  await db.update(ayzenMailboxSenderReputationTable).set({ status }).where(eq(ayzenMailboxSenderReputationTable.id, row.id));
}

// Bumps a sender's spam-report count — called when the user marks a
// message from them as spam (single message or via bulk "spam" action).
export async function recordSpamReport(userId: number, rawEmail: string): Promise<void> {
  const email = extractEmail(rawEmail);
  if (!email) return;
  const row = await getOrCreateReputation(userId, email);
  await db.update(ayzenMailboxSenderReputationTable)
    .set({ spamReports: row.spamReports + 1 }).where(eq(ayzenMailboxSenderReputationTable.id, row.id));
}

// "Not spam" — mirrors most providers: pulling a message back out of Spam
// also clears any manual Block on that sender and resets their report
// count, since saying "not spam" means the user didn't actually want that
// sender auto-spammed going forward.
export async function clearSenderSpamFlags(userId: number, rawEmail: string): Promise<void> {
  const email = extractEmail(rawEmail);
  if (!email) return;
  const [row] = await findReputation(userId, email);
  if (!row) return;
  await db.update(ayzenMailboxSenderReputationTable)
    .set({ spamReports: 0, status: row.status === "blocked" ? "neutral" : row.status })
    .where(eq(ayzenMailboxSenderReputationTable.id, row.id));
}

export async function listSenders(userId: number, status: "blocked" | "allowed") {
  return db.select().from(ayzenMailboxSenderReputationTable)
    .where(and(eq(ayzenMailboxSenderReputationTable.userId, userId), eq(ayzenMailboxSenderReputationTable.status, status)))
    .orderBy(ayzenMailboxSenderReputationTable.email);
}

/**
 * Called from routes/resend-webhook.ts right before a new inbound message
 * is stored. Reads (creating if new) the sender's reputation row, applies
 * the rolling-window rate counter, and decides whether this message should
 * land in Spam instead of Inbox.
 */
export async function evaluateInboundReputation(userId: number, rawFrom: string): Promise<{ folder: "inbox" | "spam" }> {
  const email = extractEmail(rawFrom);
  if (!email) return { folder: "inbox" };

  const row = await getOrCreateReputation(userId, email);
  const now = new Date();

  if (row.status === "blocked") {
    await db.update(ayzenMailboxSenderReputationTable).set({ lastReceivedAt: now }).where(eq(ayzenMailboxSenderReputationTable.id, row.id));
    return { folder: "spam" };
  }
  if (row.status === "allowed") {
    await db.update(ayzenMailboxSenderReputationTable).set({ lastReceivedAt: now }).where(eq(ayzenMailboxSenderReputationTable.id, row.id));
    return { folder: "inbox" };
  }

  // Neutral sender — apply the two "basic reputation" heuristics: too many
  // prior spam reports, or too many messages inside the current window.
  const windowExpired = !row.windowStartedAt || (now.getTime() - row.windowStartedAt.getTime()) > RATE_WINDOW_MS;
  const receivedInWindow = windowExpired ? 1 : row.receivedInWindow + 1;
  const windowStartedAt = windowExpired ? now : row.windowStartedAt;

  await db.update(ayzenMailboxSenderReputationTable)
    .set({ receivedInWindow, windowStartedAt, lastReceivedAt: now })
    .where(eq(ayzenMailboxSenderReputationTable.id, row.id));

  const autoSpam = row.spamReports >= AUTO_SPAM_REPORT_THRESHOLD || receivedInWindow > RATE_LIMIT_MAX_PER_WINDOW;
  return { folder: autoSpam ? "spam" : "inbox" };
}
