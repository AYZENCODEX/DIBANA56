import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export async function logActivity(
  userId: number,
  action: string,
  entityType?: string | null,
  entityId?: number | null,
  entityName?: string | null,
  meta?: Record<string, unknown> | null,
): Promise<void> {
  if (!userId || userId <= 0) return;
  try {
    const metaJson = meta ? `'${JSON.stringify(meta).replace(/'/g, "''")}'` : "NULL";
    const entityTypeVal = entityType ? `'${entityType.replace(/'/g, "''")}'` : "NULL";
    const entityIdVal = entityId ? String(entityId) : "NULL";
    const entityNameVal = entityName ? `'${entityName.replace(/'/g, "''")}'` : "NULL";
    await db.execute(sql.raw(
      `INSERT INTO user_activity (user_id, action, entity_type, entity_id, entity_name, meta, created_at)
       VALUES (${userId}, '${action.replace(/'/g, "''")}', ${entityTypeVal}, ${entityIdVal}, ${entityNameVal}, ${metaJson}, NOW())`
    ));
  } catch {}
}
