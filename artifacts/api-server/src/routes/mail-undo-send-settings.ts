/**
 * routes/mail-undo-send-settings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Undo Send, Phase 2. Lets the logged-in user choose how long their "Undo"
 * window stays open after hitting Send — Gmail-style 5/10/20/30s — instead
 * of the single operator-set MAIL_UNDO_SEND_WINDOW_MS env var every user was
 * stuck with in Phase 1. routes/ayzen-mailbox.ts's POST /send reads
 * users.mailUndoSendWindowMs (this route's PATCH target) when it enqueues an
 * immediate send; this file only owns the preference itself, same division
 * of responsibility as routes/digest-settings.ts (preference) vs
 * lib/vault-health-scan.ts (the thing that actually uses it).
 */
import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth, getRequestUser } from "../middlewares/auth";
import { UNDO_SEND_WINDOW_CHOICES_MS, type UndoSendWindowChoiceMs } from "../lib/mail-send-queue";

const router = Router();

// ── GET /users/me/undo-send-window — current preference + the valid choices,
// so the frontend never has to hardcode the 5/10/20/30s list separately. ──
router.get("/users/me/undo-send-window", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }
  const [row] = await db
    .select({ mailUndoSendWindowMs: usersTable.mailUndoSendWindowMs })
    .from(usersTable)
    .where(eq(usersTable.id, user.userId));
  if (!row) { res.status(404).json({ error: "User not found" }); return; }
  res.json({
    undoSendWindowMs: row.mailUndoSendWindowMs,
    choices: UNDO_SEND_WINDOW_CHOICES_MS,
  });
});

// ── PATCH /users/me/undo-send-window — body { undoSendWindowMs } ───────────
router.patch("/users/me/undo-send-window", requireAuth, async (req, res): Promise<void> => {
  const user = getRequestUser(req);
  if (!user) { res.status(401).json({ error: "Unauthorized" }); return; }

  const value = Number(req.body?.undoSendWindowMs);
  // Deliberately a closed set rather than clampUndoSendWindowMs()'s general
  // 5-30s range: clampUndoSendWindowMs() exists to defensively re-clamp
  // whatever a user row already holds (including one hand-edited outside
  // this route), but PATCH itself should only ever accept the exact
  // Gmail-style choices Settings actually offers, not any value in between.
  if (!UNDO_SEND_WINDOW_CHOICES_MS.includes(value as UndoSendWindowChoiceMs)) {
    res.status(400).json({
      error: `undoSendWindowMs must be one of: ${UNDO_SEND_WINDOW_CHOICES_MS.join(", ")}`,
    });
    return;
  }

  await db.update(usersTable).set({ mailUndoSendWindowMs: value }).where(eq(usersTable.id, user.userId));
  res.json({ ok: true, undoSendWindowMs: value });
});

export default router;
