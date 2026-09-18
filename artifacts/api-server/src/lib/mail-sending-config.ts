/**
 * lib/mail-sending-config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Bounce + Complaint Handling (Phase 3) — the admin-tunable thresholds
 * lib/mail-sending-health.ts and lib/mail-recipient-reputation.ts read
 * instead of hardcoding, backed by the singleton
 * ayzen_mailbox_sending_config row (migrations/053).
 *
 * Read on essentially every send/bounce/complaint event, so it's cached
 * in-process for CONFIG_TTL_MS rather than queried every time — a few
 * seconds of staleness on a threshold change is a fine trade for not
 * adding a DB round-trip to every mail event. getSendingConfig() self-heals
 * (creates the row with defaults) if it's ever missing, same as
 * getOrCreateReputation() in mail-recipient-reputation.ts does for a new
 * recipient.
 */
import { db, ayzenMailboxSendingConfigTable, type AyzenMailboxSendingConfig } from "@workspace/db";
import { eq } from "drizzle-orm";

const CONFIG_TTL_MS = 30_000;
let cached: { value: AyzenMailboxSendingConfig; at: number } | null = null;

export async function getSendingConfig(): Promise<AyzenMailboxSendingConfig> {
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.value;

  let [row] = await db.select().from(ayzenMailboxSendingConfigTable).where(eq(ayzenMailboxSendingConfigTable.id, 1));
  if (!row) {
    [row] = await db.insert(ayzenMailboxSendingConfigTable).values({ id: 1 }).onConflictDoNothing().returning();
    if (!row) [row] = await db.select().from(ayzenMailboxSendingConfigTable).where(eq(ayzenMailboxSendingConfigTable.id, 1));
  }
  cached = { value: row!, at: Date.now() };
  return row!;
}

// Admin-only (routes/ayzen-mailbox.ts's PATCH /admin/mail-sending-config
// gates this behind requireAdmin) — updates whichever fields are passed
// and invalidates the cache so the new values take effect on the next
// read rather than waiting out CONFIG_TTL_MS.
export async function updateSendingConfig(patch: Partial<Omit<AyzenMailboxSendingConfig, "id" | "updatedAt">>): Promise<AyzenMailboxSendingConfig> {
  await getSendingConfig(); // ensures the singleton row exists before updating it
  const [row] = await db.update(ayzenMailboxSendingConfigTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ayzenMailboxSendingConfigTable.id, 1))
    .returning();
  cached = { value: row!, at: Date.now() };
  return row!;
}
