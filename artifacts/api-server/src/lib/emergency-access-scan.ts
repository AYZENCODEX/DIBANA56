/**
 * lib/emergency-access-scan.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The actual dead-man-switch check, run daily by
 * lib/emergency-access-cron.ts. Kept separate from the cron wiring itself —
 * same split as vault-health-scan.ts/vault-health-cron.ts and
 * vault-trash-purge.ts/vault-trash-cron.ts elsewhere in this codebase, so
 * the scan stays independently testable/callable.
 *
 * For every active, confirmed emergency contact whose owner has had no
 * users.last_active_at update for at least wait_days, and who doesn't
 * already have a live grant (pending/approved), this creates one
 * emergency_access_grants row and emails the owner a last-chance warning —
 * it never emails the contact or approves anything itself; that only
 * happens once an admin acts (routes/emergency-access.ts).
 */
import { db, emergencyAccessGrantsTable, notificationsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { sendEmail } from "./email";
import { logger } from "./logger";

export async function scanForTriggeredEmergencyAccess(): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT c.id AS contact_id, c.user_id AS owner_user_id, c.contact_name, c.wait_days,
           u.email AS owner_email, u.username AS owner_username, u.last_active_at
    FROM emergency_contacts c
    JOIN users u ON u.id = c.user_id
    WHERE c.status = 'active'
      AND c.confirmed_at IS NOT NULL
      AND u.last_active_at IS NOT NULL
      AND u.last_active_at < NOW() - (c.wait_days || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM emergency_access_grants g
        WHERE g.contact_id = c.id AND g.status IN ('pending_admin_review', 'approved')
      )
  `);

  let triggered = 0;
  for (const row of candidates.rows as any[]) {
    try {
      await db.insert(emergencyAccessGrantsTable).values({
        contactId: row.contact_id,
        ownerUserId: row.owner_user_id,
        status: "pending_admin_review",
        ownerInactiveSinceAt: row.last_active_at,
      });

      await db.insert(notificationsTable).values({
        userId: row.owner_user_id,
        type: "security",
        title: "Emergency access triggered",
        message: `${row.contact_name} is eligible for emergency vault access after ${row.wait_days} days of inactivity. Log in to cancel this if you're okay.`,
      });

      if (row.owner_email) {
        await sendEmail({
          to: row.owner_email,
          subject: "AYZEN — Emergency Access has been triggered on your vault",
          html: `<p>Hi ${row.owner_username ?? ""},</p>
            <p>Your nominated emergency contact <strong>${row.contact_name}</strong> is now eligible to request access to your vault, because your account has been inactive for ${row.wait_days}+ days.</p>
            <p>This request still requires admin approval before any access is granted. If you're okay, simply log in — this cancels the pending request automatically the moment you use your account, or you can cancel it directly from Vault Security → Emergency Access.</p>`,
          text: `Emergency access has been triggered by inactivity. Log in to AYZEN to cancel it if this was a mistake.`,
        });
      }

      triggered++;
    } catch (err) {
      logger.error({ err, contactId: row.contact_id }, "Failed to create emergency_access_grants row");
    }
  }
  return triggered;
}
