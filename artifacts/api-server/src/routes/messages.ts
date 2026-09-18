import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { broadcastToUser } from "./events";
import { requireAuth, getRequestUser } from "../middlewares/auth";

const router = Router();

// GET /messages/conversations — list conversations (distinct users)
router.get("/messages/conversations", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  try {
    const rows = await db.execute(sql.raw(`
      SELECT
        CASE WHEN m.from_user_id = ${userId} THEN m.to_user_id ELSE m.from_user_id END as other_user_id,
        u.username as other_username,
        u.avatar_url as other_avatar,
        u.role as other_role,
        MAX(m.created_at) as last_message_at,
        (SELECT content FROM messages WHERE (from_user_id = ${userId} AND to_user_id = other_user_id) OR (from_user_id = other_user_id AND to_user_id = ${userId}) ORDER BY created_at DESC LIMIT 1) as last_message,
        COUNT(CASE WHEN m.to_user_id = ${userId} AND m.is_read = FALSE THEN 1 END) as unread_count
      FROM messages m
      LEFT JOIN users u ON u.id = CASE WHEN m.from_user_id = ${userId} THEN m.to_user_id ELSE m.from_user_id END
      WHERE m.from_user_id = ${userId} OR m.to_user_id = ${userId}
      GROUP BY other_user_id, u.username, u.avatar_url, u.role
      ORDER BY last_message_at DESC
    `));
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /messages/:otherUserId — get messages with a specific user
router.get("/messages/:otherUserId", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const otherId = parseInt(Array.isArray(req.params.otherUserId) ? req.params.otherUserId[0] : req.params.otherUserId, 10);

  try {
    const rows = await db.execute(sql.raw(`
      SELECT m.*, u.username as from_username, u.avatar_url as from_avatar
      FROM messages m
      LEFT JOIN users u ON u.id = m.from_user_id
      WHERE (m.from_user_id = ${userId} AND m.to_user_id = ${otherId})
         OR (m.from_user_id = ${otherId} AND m.to_user_id = ${userId})
      ORDER BY m.created_at ASC
      LIMIT 100
    `));

    // Mark received messages as read
    await db.execute(sql.raw(
      `UPDATE messages SET is_read = TRUE WHERE from_user_id = ${otherId} AND to_user_id = ${userId} AND is_read = FALSE`
    ));

    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// POST /messages/:toUserId — send a message
router.post("/messages/:toUserId", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const toId = parseInt(Array.isArray(req.params.toUserId) ? req.params.toUserId[0] : req.params.toUserId, 10);
  const { content } = req.body;

  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  try {
    const result = await db.execute(sql.raw(
      `INSERT INTO messages (from_user_id, to_user_id, content) VALUES (${userId}, ${toId}, '${content.replace(/'/g, "''")}') RETURNING *`
    ));
    const msg = result.rows[0] as any;

    // Notify recipient via SSE
    broadcastToUser(toId, "new_message", {
      id: msg.id, fromUserId: userId, content: msg.content, createdAt: msg.created_at
    });

    res.status(201).json(msg);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /messages/users/search?q= — search users to message
router.get("/messages/users/search", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  const q = (req.query.q as string || "").trim();
  if (!q) { res.json([]); return; }

  try {
    const rows = await db.execute(sql.raw(
      `SELECT id, username, avatar_url, role FROM users WHERE username ILIKE '%${q.replace(/'/g, "''")}%' AND id != ${userId} LIMIT 10`
    ));
    res.json(rows.rows);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /messages/unread/count — get unread message count for current user
router.get("/messages/unread/count", requireAuth, async (req, res): Promise<void> => {
  const { userId } = getRequestUser(req)!;
  try {
    const result = await db.execute(sql.raw(
      `SELECT COUNT(*) as count FROM messages WHERE to_user_id = ${userId} AND is_read = FALSE`
    ));
    res.json({ count: Number((result.rows[0] as any)?.count ?? 0) });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
