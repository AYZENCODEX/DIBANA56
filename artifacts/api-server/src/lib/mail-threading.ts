/**
 * lib/mail-threading.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One place for the "which conversation does this message belong to" logic,
 * shared by the inbound webhook (routes/resend-webhook.ts) and the outbound
 * send/draft routes (routes/ayzen-mailbox.ts) so a thread doesn't fork just
 * because a reply came in one path and a reply-to-that-reply went out the
 * other.
 */
import { db, ayzenMailboxMessagesTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

/** Splits a References header into its individual Message-IDs, oldest first. */
export function parseReferences(references: string | null | undefined): string[] {
  if (!references) return [];
  return references.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Figures out the thread_id a new message (inbound or outbound) should join.
 *
 *   1. If In-Reply-To or References name a Message-ID we already have on
 *      file for this user, join that message's thread — this is the normal
 *      case for any reply within an existing conversation.
 *   2. Otherwise, if there *is* an In-Reply-To/References chain but none of
 *      those ids match anything we've stored (e.g. we only ever saw a later
 *      reply, or the thread started before this mailbox existed), anchor the
 *      thread to the oldest known ancestor id instead of starting a fresh
 *      thread — so if an earlier or later message in that same chain does
 *      show up, it still joins the same conversation.
 *   3. Otherwise this is the start of a new conversation: use its own
 *      Message-ID (falling back to a caller-supplied id) as the thread root.
 */
export async function resolveThreadId(
  userId: number,
  inReplyTo: string | null | undefined,
  references: string | null | undefined,
  ownMessageId: string | null | undefined,
): Promise<string> {
  const refs = parseReferences(references);
  const candidateIds = Array.from(new Set([inReplyTo, ...refs].filter((v): v is string => !!v)));

  if (candidateIds.length) {
    const matches = await db.select({ messageId: ayzenMailboxMessagesTable.messageId, threadId: ayzenMailboxMessagesTable.threadId })
      .from(ayzenMailboxMessagesTable)
      .where(and(eq(ayzenMailboxMessagesTable.userId, userId), inArray(ayzenMailboxMessagesTable.messageId, candidateIds)));
    if (matches.length) return matches[0].threadId;
    // No ancestor on file — anchor to the oldest id in the chain (References
    // is ordered oldest-first; fall back to In-Reply-To alone if that's all
    // we have) so a later-arriving message in the same chain still matches.
    return refs[0] ?? inReplyTo!;
  }

  return ownMessageId ?? `anon-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
