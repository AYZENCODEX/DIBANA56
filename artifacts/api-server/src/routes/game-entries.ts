import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { encryptField, decryptRow, decryptRows } from "../lib/vault-crypto";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";

const router = Router();

// `game_entries` has one owner column (`user_id`) — plain single-owner
// shape, same as everywhere else in this series. Matches the file's own
// `db.execute(sql.raw(...))` style (id is already integer-validated by
// the route below before this builder ever sees it).
const GAME_ENTRY_OWNER_SENTINEL_NONE = -1;
const gameEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string);
  if (Number.isNaN(id)) return { type: "game_entry", id: req.params.id, ownerId: GAME_ENTRY_OWNER_SENTINEL_NONE };
  const result = await db.execute(sql.raw(`SELECT user_id FROM game_entries WHERE id = ${id} LIMIT 1`));
  const row = result.rows[0] as any;
  return { type: "game_entry", id, ownerId: row?.user_id ?? GAME_ENTRY_OWNER_SENTINEL_NONE };
};
function requireGameEntryOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, gameEntryResource, { onDecision: pepDecisionObserver, onDeny });
}

// Credential columns encrypted at rest (see lib/vault-crypto.ts).
const GAME_SENSITIVE_FIELDS = ["account_password", "email_password", "email_2fa", "email_backup_code"] as const;

// Safely escape a string for SQL — mirrors routes/kyc.ts
const safe = (v: unknown) => v === null || v === undefined || v === "" ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
// tags is stored as a jsonb column — safely embed as a JSON array literal
const safeTags = (v: unknown) => {
  const arr = Array.isArray(v) ? v.filter(t => typeof t === "string" && t.trim()).map(t => t.trim()) : [];
  return `'${JSON.stringify(arr).replace(/'/g, "''")}'::jsonb`;
};

// ─── GET /game-entries — list user's game entities ─────────────────────────
router.get("/game-entries", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const category = (req.query.category as string) || null;
  try {
    const q = category
      ? sql.raw(`SELECT * FROM game_entries WHERE user_id = ${userId} AND category = ${safe(category)} ORDER BY created_at DESC`)
      : sql.raw(`SELECT * FROM game_entries WHERE user_id = ${userId} ORDER BY created_at DESC`);
    const result = await db.execute(q);
    res.json(decryptRows(result.rows as any[], GAME_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /game-entries — create game entity ────────────────────────────────
router.post("/game-entries", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const {
    category = "Other",
    // Account
    username = null, accountPassword = null, notes = null,
    // Email
    email = null, emailPassword = null, email2fa = null, emailBackupCode = null,
    // Info
    rank = null, level = null, accountAge = null, tags = [],
  } = req.body;

  if (!category) { res.status(400).json({ error: "Category required" }); return; }

  try {
    const result = await db.execute(sql.raw(`
      INSERT INTO game_entries
        (user_id, category, username, account_password, notes,
         email, email_password, email_2fa, email_backup_code,
         rank, level, account_age, tags)
      VALUES
        (${userId}, ${safe(category)}, ${safe(username)}, ${safe(encryptField(accountPassword))}, ${safe(notes)},
         ${safe(email)}, ${safe(encryptField(emailPassword))}, ${safe(encryptField(email2fa))}, ${safe(encryptField(emailBackupCode))},
         ${safe(rank)}, ${safe(level)}, ${safe(accountAge)}, ${safeTags(tags)})
      RETURNING *
    `));
    res.status(201).json(decryptRow(result.rows[0] as any, GAME_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /game-entries/:id — fetch single game entity ───────────────────────
// Was previously missing entirely (list + create + update + delete existed,
// no single-fetch) — added here alongside the sylo.game_entry_view metering
// so game entities get the same individually-configurable "view" rate local
// accounts and KYC entities now have. Must stay registered AFTER the literal
// "/game-entries" list route above, same ordering rule as local-accounts.ts/
// kyc.ts, so Express doesn't try to parse a literal path segment as :id.
router.get("/game-entries/:id", requireAuth, requireGameEntryOwnership("game_entry.read", (_req, res) => { res.status(404).json({ error: "Not found" }); }), requireCreditBalance("sylo.game_entry_view"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(`SELECT * FROM game_entries WHERE id = ${id} AND user_id = ${userId} LIMIT 1`));
    if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    // Charge-on-success: only after the row was actually found — a 404 above
    // never touches the ledger. Mirrors vault.ts's GET /vault/:id pattern.
    const charge = await chargeCredits(userId, "sylo.game_entry_view");
    res.json({ ...decryptRow(result.rows[0] as any, GAME_SENSITIVE_FIELDS), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PUT /game-entries/:id — update game entity ─────────────────────────────
router.put("/game-entries/:id", requireAuth, requireGameEntryOwnership("game_entry.update", (_req, res) => { res.status(404).json({ error: "Not found or forbidden" }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const {
    category, username, accountPassword, notes,
    email, emailPassword, email2fa, emailBackupCode,
    rank, level, accountAge, tags,
  } = req.body;

  try {
    const result = await db.execute(sql.raw(`
      UPDATE game_entries SET
        category = ${safe(category)}, username = ${safe(username)}, account_password = ${safe(encryptField(accountPassword))}, notes = ${safe(notes)},
        email = ${safe(email)}, email_password = ${safe(encryptField(emailPassword))}, email_2fa = ${safe(encryptField(email2fa))}, email_backup_code = ${safe(encryptField(emailBackupCode))},
        rank = ${safe(rank)}, level = ${safe(level)}, account_age = ${safe(accountAge)},
        tags = ${tags !== undefined ? safeTags(tags) : "tags"},
        updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
    if (!result.rows.length) { res.status(404).json({ error: "Not found or forbidden" }); return; }
    res.json(decryptRow(result.rows[0] as any, GAME_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /game-entries/:id — delete game entity ──────────────────────────
router.delete("/game-entries/:id", requireAuth, requireGameEntryOwnership("game_entry.delete", (_req, res) => { res.json({ success: true }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    await db.execute(sql.raw(`DELETE FROM game_entries WHERE id = ${id} AND user_id = ${userId}`));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

export default router;
