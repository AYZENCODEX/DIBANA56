/**
 * lib/mail-rules.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Evaluates a user's ayzen_mailbox_rules against one inbound message and
 * applies whichever ones match. Called from routes/resend-webhook.ts right
 * after a new inbound message (+ attachments) is stored, and from
 * routes/ayzen-mailbox.ts's "apply to existing mail" rule action.
 *
 * Deliberately simple: one condition per rule (field + contains/equals a
 * value), evaluated case-insensitively. All *matching* rules apply, in
 * ascending `position` order — this mirrors Gmail's "a message can match
 * more than one filter" behavior rather than stopping at the first match.
 * Label and star/read actions accumulate across matching rules; if more
 * than one matching rule sets a folder, the last one (highest position)
 * wins, same as later CSS rules overriding earlier ones — simplest
 * predictable behavior without introducing an explicit priority UI.
 */
import { db, ayzenMailboxMessagesTable, ayzenMailboxMessageLabelsTable, ayzenMailboxRulesTable, ayzenMailboxFoldersTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

type Message = typeof ayzenMailboxMessagesTable.$inferSelect;
type Rule = typeof ayzenMailboxRulesTable.$inferSelect;

function fieldValue(m: Pick<Message, "fromAddr" | "toAddr" | "subject">, field: string): string {
  if (field === "to") return m.toAddr ?? "";
  if (field === "subject") return m.subject ?? "";
  return m.fromAddr ?? "";
}

export function ruleMatches(rule: Rule, m: Pick<Message, "fromAddr" | "toAddr" | "subject">): boolean {
  if (!rule.enabled) return false;
  const haystack = fieldValue(m, rule.field).toLowerCase();
  const needle = rule.value.toLowerCase().trim();
  if (!needle) return false;
  return rule.matchType === "equals" ? haystack === needle : haystack.includes(needle);
}

/**
 * Applies every enabled rule that matches `message` for its owner, in
 * position order. Returns the set of changes actually written so callers
 * (e.g. the webhook) can log what happened. Safe to call with zero rules —
 * this is a no-op cost of one extra SELECT in that case.
 */
export async function applyRulesToMessage(userId: number, message: Message): Promise<{ appliedRuleIds: number[] }> {
  const rules = await db.select().from(ayzenMailboxRulesTable)
    .where(and(eq(ayzenMailboxRulesTable.userId, userId), eq(ayzenMailboxRulesTable.enabled, true)))
    .orderBy(ayzenMailboxRulesTable.position);

  const matched = rules.filter((r) => ruleMatches(r, message));
  if (!matched.length) return { appliedRuleIds: [] };

  const labelIdsToAdd = new Set<number>();
  let markRead = false;
  let star = false;
  let folder: string | null = null;
  let folderId: number | null = null;

  for (const rule of matched) {
    if (rule.actionLabelId) labelIdsToAdd.add(rule.actionLabelId);
    if (rule.actionMarkRead) markRead = true;
    if (rule.actionStar) star = true;
    if (rule.actionFolder) { folder = rule.actionFolder; folderId = rule.actionFolderId ?? null; }
  }

  // Validate any custom-folder target still exists and belongs to this
  // user before moving into it — a rule referencing a since-deleted folder
  // should just skip the move rather than corrupt the message's folder.
  if (folder === "custom") {
    if (folderId == null) { folder = null; folderId = null; }
    else {
      const [f] = await db.select({ id: ayzenMailboxFoldersTable.id }).from(ayzenMailboxFoldersTable)
        .where(and(eq(ayzenMailboxFoldersTable.id, folderId), eq(ayzenMailboxFoldersTable.userId, userId)));
      if (!f) { folder = null; folderId = null; }
    }
  }

  const patch: Partial<Message> = {};
  if (markRead) patch.isRead = true;
  if (star) patch.isStarred = true;
  if (folder) { patch.folder = folder; patch.folderId = folderId; }

  if (Object.keys(patch).length) {
    await db.update(ayzenMailboxMessagesTable).set(patch).where(eq(ayzenMailboxMessagesTable.id, message.id));
  }
  if (labelIdsToAdd.size) {
    // Verify the labels still belong to this user (same defensive check as
    // the folder above) before inserting join rows.
    const valid = await db.select({ id: ayzenMailboxMessageLabelsTable.labelId }).from(ayzenMailboxMessageLabelsTable)
      .where(eq(ayzenMailboxMessageLabelsTable.messageId, message.id)); // existing, to avoid dupes below
    const existing = new Set(valid.map((v) => v.id));
    const toInsert = Array.from(labelIdsToAdd).filter((id) => !existing.has(id));
    if (toInsert.length) {
      await db.insert(ayzenMailboxMessageLabelsTable)
        .values(toInsert.map((labelId) => ({ messageId: message.id, labelId })))
        .onConflictDoNothing();
    }
  }

  return { appliedRuleIds: matched.map((r) => r.id) };
}

/**
 * "Also apply to existing mail" — runs every enabled rule against every
 * message the user already has (inbound only; outbound/drafts were never
 * candidates for inbound-mail rules). Used by the rule-create UI's
 * "apply to existing" checkbox. Capped and sequential rather than batched
 * to keep memory bounded on large mailboxes; this runs rarely (only when a
 * rule is created/edited with the option checked), so it isn't on any hot
 * path a user waits on repeatedly.
 */
export async function applyRulesToExistingMail(userId: number): Promise<{ messagesTouched: number }> {
  const messages = await db.select().from(ayzenMailboxMessagesTable)
    .where(and(eq(ayzenMailboxMessagesTable.userId, userId), eq(ayzenMailboxMessagesTable.direction, "inbound")));
  let touched = 0;
  for (const m of messages) {
    const { appliedRuleIds } = await applyRulesToMessage(userId, m);
    if (appliedRuleIds.length) touched += 1;
  }
  return { messagesTouched: touched };
}
