import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership, requirePublicAudit } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { syncOnLocalAccountUpdate, syncOnLocalAccountDelete } from "../services/sync";
import { encryptField, decryptRow, decryptRows } from "../lib/vault-crypto";
import { streamFantasticReceiptPdf } from "../lib/receipt-theme";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";

const router = Router();

// Public receipt link token — same possession-is-auth model as
// finance_ledger_entries.receipt_token (routes/finance.ts). See the
// "Public receipt link" section near the bottom of this file.
function generateReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}
function receiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/receipt/local/${receiptToken}`;
}

// Credential columns encrypted at rest (see lib/vault-crypto.ts).
const LOCAL_SENSITIVE_FIELDS = ["password", "recovery_email_password", "backup_codes", "twofa", "recovery_email_twofa"] as const;

const DEFAULT_CATEGORIES = [
  { id: "facebook",  name: "Facebook",  color: "#1877F2", icon: "facebook" },
  { id: "github",    name: "GitHub",    color: "#24292e", icon: "github" },
  { id: "google",    name: "Google",    color: "#EA4335", icon: "google" },
  { id: "twitter",   name: "Twitter",   color: "#1DA1F2", icon: "twitter" },
  { id: "discord",   name: "Discord",   color: "#5865F2", icon: "discord" },
];

// Safely escape a string for SQL — only used for string values; integers are coerced with Number()
const safe = (v: unknown) => v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const safeNum = (v: unknown) => isNaN(Number(v)) ? 0 : Number(v);
const safeDate = (v: unknown) => v ? `'${String(v).replace(/'/g, "''")}'` : "NULL";
// Rank/badge score — clamped to the 0-10 scale the 5-tier badge system expects.
const safeScore = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 5;
};

// ─── GET /local-accounts — list user's accounts ───────────────────────────────
// Supports ?category=twitter&linked=false (unlinked only) or ?vaultEntryId=123
router.get("/local-accounts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const category = (req.query.category as string) || null;
  const linkedParam = req.query.linked as string | undefined;   // "false" = only unlinked
  const vaultEntryId = req.query.vaultEntryId ? parseInt(req.query.vaultEntryId as string) : null;
  try {
    let where = `user_id = ${userId}`;
    if (category) where += ` AND category = ${safe(category)}`;
    if (linkedParam === "false") where += ` AND vault_entry_id IS NULL`;
    if (vaultEntryId && !isNaN(vaultEntryId)) where += ` AND vault_entry_id = ${vaultEntryId}`;
    const result = await db.execute(sql.raw(`SELECT * FROM local_accounts WHERE ${where} ORDER BY created_at DESC`));
    res.json(decryptRows(result.rows as any[], LOCAL_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /local-accounts — create account ────────────────────────────────────
router.post("/local-accounts", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const {
    category = "Other", label = null, username = null,
    email = null, password = null,
    recoveryEmail = null, recoveryEmailPassword = null,
    backupCodes = null, twofa = null, recoveryEmailTwofa = null,
    followers = null, accountWorth = 0, buyPrice = 0,
    accountCreateDate = null, accountBuyDate = null, accountLastLoginDate = null,
    notes = null, score = 5,
  } = req.body;

  if (!category) { res.status(400).json({ error: "Category required" }); return; }

  try {
    const result = await db.execute(sql.raw(`
      INSERT INTO local_accounts
        (user_id, category, label, username, email, password, recovery_email, recovery_email_password,
         backup_codes, twofa, recovery_email_twofa, followers, account_worth, buy_price,
         account_create_date, account_buy_date, account_last_login_date, notes, score)
      VALUES
        (${userId}, ${safe(category)}, ${safe(label)}, ${safe(username)}, ${safe(email)}, ${safe(encryptField(password))},
         ${safe(recoveryEmail)}, ${safe(encryptField(recoveryEmailPassword))}, ${safe(encryptField(backupCodes))}, ${safe(encryptField(twofa))},
         ${safe(encryptField(recoveryEmailTwofa))}, ${safe(followers)}, ${safeNum(accountWorth)}, ${safeNum(buyPrice)},
         ${safeDate(accountCreateDate)}, ${safeDate(accountBuyDate)}, ${safeDate(accountLastLoginDate)},
         ${safe(notes)}, ${safeScore(score)})
      RETURNING *
    `));
    res.status(201).json(decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── Route Integration Roadmap — Season C, Phase C15 (mechanical sweep,
// batch 15: local-accounts.ts) ───────────────────────────────────────────
// This file was never part of the original 138-route audit's inventory —
// found during a fresh sweep for the same shape everywhere else in this
// series: a hand-rolled ownership check on a client-supplied `:id`. Here
// it's written as raw SQL (`WHERE id = ${id} AND user_id = ${userId}`)
// instead of Drizzle's `and(eq(...))`, but it's the exact same check —
// same "second, PDP-routed, audited decision on top of an unchanged
// existing query" treatment as everywhere else (Phase B1/C1-C14).
//
// The resource lookup below uses `sql` (parameterized tagged template),
// NOT `sql.raw` — this file already mixes both styles (see the
// `value_history` DELETE a few lines above this block for a prior
// example) and a NEW query this phase is introducing has no reason to
// use the string-interpolated form the rest of the file's *existing*
// queries were written with; changing those existing queries is a
// separate, larger hardening effort outside this phase's mechanical
// scope.
//
// Response bodies vary more here than in most files this series has
// touched, because they were never following one convention to begin
// with: "Not found or forbidden" (PUT, PATCH .../status), "Not found"
// (link-vault, unlink-vault), "Account not found" (GET /:id, receipt
// routes) — each `onDeny` below is parameterized to keep its own route's
// exact pre-existing body.
//
// Two routes don't error at all on a non-owned id — `DELETE /:id` just
// runs `DELETE ... WHERE id=x AND user_id=y` and unconditionally replies
// `{ success: true }` whether or not a row actually matched (same for
// `GET /:id/points`, which returns an empty list rather than a 404 for
// an account that isn't the caller's). Preserving behavior here means
// the deny path replies with that exact same "quiet no-op" body, NOT a
// 404 — a 404 would newly reveal "that id exists, just not yours",
// something the original code never told the caller.
const LOCAL_ACCOUNT_OWNER_SENTINEL_NONE = -1;

const localAccountResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "local_account", id: req.params.id, ownerId: LOCAL_ACCOUNT_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT user_id FROM local_accounts WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "local_account", id, ownerId: rows[0]?.user_id ?? LOCAL_ACCOUNT_OWNER_SENTINEL_NONE };
};

// Exported (C22) — value-history.ts's own two `/local-accounts/:id/...`
// routes need this exact table/owner shape for their own long-overdue
// ownership gate. Already parameterized by `onDeny` (unlike
// vault-entity-links.ts's fixed-body helper reused in C21), so
// value-history.ts imports this wrapper directly instead of writing a
// second thin copy of it.
export function requireLocalAccountOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, localAccountResource, { onDecision: pepDecisionObserver, onDeny });
}

const denyNotFoundOrForbidden = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found or forbidden" }); };
const denyNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Not found" }); };
const denyAccountNotFound = (_req: Request, res: Response) => { res.status(404).json({ error: "Account not found" }); };
const denySilentSuccess = (_req: Request, res: Response) => { res.json({ success: true }); };
const denyEmptyPoints = (_req: Request, res: Response) => { res.json({ entries: [], total: 0 }); };

// ─── Phase C16 addendum — the two resource types C15 explicitly deferred ──
// `local_account_category` and `local_account_point` each have their own
// id-space and their own `user_id` owner column, distinct from
// `local_accounts` itself — same silent-success shape as `DELETE /:id`
// (C15), so the same "quiet no-op" deny (not a newly-revealing 404).
const LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE = -1;
const localAccountCategoryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "local_account_category", id: req.params.id, ownerId: LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT user_id FROM local_account_categories WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "local_account_category", id, ownerId: rows[0]?.user_id ?? LOCAL_ACCOUNT_CATEGORY_OWNER_SENTINEL_NONE };
};
function requireLocalAccountCategoryOwnership(action: string) {
  return requireOwnership(action, localAccountCategoryResource, { onDecision: pepDecisionObserver, onDeny: denySilentSuccess });
}

const LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE = -1;
const localAccountPointResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.pointId as string, 10);
  if (!Number.isFinite(id)) return { type: "local_account_point", id: req.params.pointId, ownerId: LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT user_id FROM local_account_points WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "local_account_point", id, ownerId: rows[0]?.user_id ?? LOCAL_ACCOUNT_POINT_OWNER_SENTINEL_NONE };
};
function requireLocalAccountPointOwnership(action: string) {
  return requireOwnership(action, localAccountPointResource, { onDecision: pepDecisionObserver, onDeny: denySilentSuccess });
}

// ─── PUT /local-accounts/:id — update account ────────────────────────────────
router.put("/local-accounts/:id", requireAuth, requireLocalAccountOwnership("local_account.update", denyNotFoundOrForbidden), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const {
    category, label, username, email, password,
    recoveryEmail, recoveryEmailPassword,
    backupCodes, twofa, recoveryEmailTwofa,
    followers, accountWorth, buyPrice,
    accountCreateDate, accountBuyDate, accountLastLoginDate, notes, score,
  } = req.body;

  try {
    const result = await db.execute(sql.raw(`
      UPDATE local_accounts SET
        category = ${safe(category)}, label = ${safe(label)}, username = ${safe(username)},
        email = ${safe(email)}, password = ${safe(encryptField(password))},
        recovery_email = ${safe(recoveryEmail)}, recovery_email_password = ${safe(encryptField(recoveryEmailPassword))},
        backup_codes = ${safe(encryptField(backupCodes))}, twofa = ${safe(encryptField(twofa))},
        recovery_email_twofa = ${safe(encryptField(recoveryEmailTwofa))},
        followers = ${safe(followers)}, account_worth = ${safeNum(accountWorth)},
        buy_price = ${safeNum(buyPrice)},
        account_create_date = ${safeDate(accountCreateDate)},
        account_buy_date = ${safeDate(accountBuyDate)},
        account_last_login_date = ${safeDate(accountLastLoginDate)},
        notes = ${safe(notes)},
        score = ${score !== undefined ? safeScore(score) : "score"}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
    if (!result.rows.length) { res.status(404).json({ error: "Not found or forbidden" }); return; }
    syncOnLocalAccountUpdate(id).catch(() => {});
    res.json(decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PATCH /local-accounts/:id/status — ban / unban account ─────────────────
router.patch("/local-accounts/:id/status", requireAuth, requireLocalAccountOwnership("local_account.status.update", denyNotFoundOrForbidden), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }

  const allowed = ["active", "banned"];
  const status = req.body.status;
  if (!allowed.includes(status)) { res.status(400).json({ error: "status must be one of: active, banned" }); return; }

  try {
    const result = await db.execute(sql.raw(`
      UPDATE local_accounts SET status = ${safe(status)}, updated_at = NOW()
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING *
    `));
    if (!result.rows.length) { res.status(404).json({ error: "Not found or forbidden" }); return; }
    syncOnLocalAccountUpdate(id).catch(() => {});
    res.json(decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /local-accounts/:id — delete account ─────────────────────────────
router.delete("/local-accounts/:id", requireAuth, requireLocalAccountOwnership("local_account.delete", denySilentSuccess), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    await db.execute(sql.raw(`DELETE FROM local_accounts WHERE id = ${id} AND user_id = ${userId}`));
    // Purge all value history so P&L for this account disappears immediately
    await db.execute(sql`DELETE FROM value_history WHERE user_id = ${userId} AND source_type = 'local' AND source_id = ${id}`);
    syncOnLocalAccountDelete(id).catch(() => {});
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PATCH /local-accounts/:id/link-vault — link to a vault entry ────────────
router.patch("/local-accounts/:id/link-vault", requireAuth, requireLocalAccountOwnership("local_account.link_vault", denyNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const { vaultEntryId } = req.body as { vaultEntryId: number };
  if (!vaultEntryId || isNaN(Number(vaultEntryId))) { res.status(400).json({ error: "vaultEntryId required" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `UPDATE local_accounts SET vault_entry_id = ${Number(vaultEntryId)}, updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId} RETURNING *`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── PATCH /local-accounts/:id/unlink-vault — remove vault link ──────────────
router.patch("/local-accounts/:id/unlink-vault", requireAuth, requireLocalAccountOwnership("local_account.unlink_vault", denyNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `UPDATE local_accounts SET vault_entry_id = NULL, updated_at = NOW()
       WHERE id = ${id} AND user_id = ${userId} RETURNING *`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /local-accounts/categories — list categories ────────────────────────
router.get("/local-accounts/categories", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql.raw(
      `SELECT * FROM local_account_categories WHERE user_id = ${userId} ORDER BY created_at ASC`
    ));
    res.json({ defaults: DEFAULT_CATEGORIES, custom: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /local-accounts/categories — create category ───────────────────────
router.post("/local-accounts/categories", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const { name } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: "Category name required" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `INSERT INTO local_account_categories (user_id, name) VALUES (${userId}, ${safe(name.trim())}) RETURNING *`
    ));
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /local-accounts/categories/:id — delete category ─────────────────
router.delete("/local-accounts/categories/:id", requireAuth, requireLocalAccountCategoryOwnership("local_account_category.delete"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    await db.execute(sql.raw(`DELETE FROM local_account_categories WHERE id = ${id} AND user_id = ${userId}`));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /local-accounts/:id — fetch single account ──────────────────────────
// Must be registered AFTER all literal sub-paths (/categories, etc.) so Express
// doesn't swallow them as param values.
router.get("/local-accounts/:id", requireAuth, requireLocalAccountOwnership("local_account.read", denyAccountNotFound), requireCreditBalance("sylo.local_account_view"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `SELECT * FROM local_accounts WHERE id = ${id} AND user_id = ${userId} LIMIT 1`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "Account not found" }); return; }
    // Charge-on-success: only after the row was actually found — a 404 above
    // never touches the ledger. Mirrors vault.ts's GET /vault/:id pattern.
    const charge = await chargeCredits(userId, "sylo.local_account_view");
    res.json({ ...decryptRow(result.rows[0] as any, LOCAL_SENSITIVE_FIELDS), _credits: charge.ok ? { charged: charge.charged, newBalance: charge.newBalance } : null });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── GET /local-accounts/:id/points ──────────────────────────────────────────
router.get("/local-accounts/:id/points", requireAuth, requireLocalAccountOwnership("local_account.points.read", denyEmptyPoints), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const accountId = parseInt(req.params.id as string);
  if (isNaN(accountId)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `SELECT * FROM local_account_points WHERE account_id = ${accountId} AND user_id = ${userId} ORDER BY created_at DESC`
    ));
    const rows = result.rows as any[];
    const total = rows.reduce((s: number, r: any) => s + Number(r.amount ?? 0), 0);
    res.json({ entries: rows, total });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── POST /local-accounts/:id/points ─────────────────────────────────────────
// NOTE: unlike every other route in this batch, this one previously had
// NO ownership check at all before its INSERT — it wrote `(accountId,
// userId, amount, notes)` straight to `local_account_points` without
// ever verifying `accountId` actually belonged to `userId`. A caller
// could attach a "points" entry to *anyone's* local account id while
// tagging it with their own userId. This `requireLocalAccountOwnership`
// gate is a genuine behavior change — flagged deliberately, same as
// Phase C14's email-compose.ts fix — not a preserve-behavior refactor.
router.post("/local-accounts/:id/points", requireAuth, requireLocalAccountOwnership("local_account.points.create", denyAccountNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const accountId = parseInt(req.params.id as string);
  if (isNaN(accountId)) { res.status(400).json({ error: "Invalid ID" }); return; }
  const { amount, notes = null } = req.body;
  if (!amount || isNaN(Number(amount))) { res.status(400).json({ error: "amount required" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `INSERT INTO local_account_points (account_id, user_id, amount, notes) VALUES (${accountId}, ${userId}, ${Number(amount)}, ${safe(notes)}) RETURNING *`
    ));
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── DELETE /local-accounts/points/:pointId ──────────────────────────────────
router.delete("/local-accounts/points/:pointId", requireAuth, requireLocalAccountPointOwnership("local_account_point.delete"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const pointId = parseInt(req.params.pointId as string);
  if (isNaN(pointId)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    await db.execute(sql.raw(`DELETE FROM local_account_points WHERE id = ${pointId} AND user_id = ${userId}`));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── Public receipt link ──────────────────────────────────────────────────────
// One shareable, unauthenticated "PnL card" per Local Entity — username,
// follower count, age, price, and P&L, same idea as the Finance ledger
// receipt (routes/finance.ts) but for a Local Entity instead of a
// transaction. Deliberately excludes password/2FA/backup-code/email fields
// even though those are already encrypted at rest — a receipt link is meant
// to be handed to someone outside AYZEN, so it only ever carries the
// "worth showing off" fields.

function calcAgeLabel(dateVal: unknown): string | null {
  if (!dateVal) return null;
  const d = new Date(dateVal as string);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return "Today";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

function calcRoiPct(worth: number, buyPrice: number): number | null {
  if (!buyPrice || buyPrice <= 0) return null;
  return ((worth - buyPrice) / buyPrice) * 100;
}

function fmtPublicLocalReceipt(row: any, issuedBy: string | null) {
  const worth = Number(row.account_worth) || 0;
  const buyPrice = Number(row.buy_price) || 0;
  const roiPct = calcRoiPct(worth, buyPrice);
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    username: row.username,
    followers: row.followers,
    age: calcAgeLabel(row.account_create_date),
    accountWorth: worth,
    buyPrice,
    profit: buyPrice > 0 ? worth - buyPrice : null,
    roiPct,
    status: row.status,
    score: row.score,
    createdAt: row.account_create_date,
    issuedBy,
    generatedAt: new Date().toISOString(),
  };
}

// POST /local-accounts/:id/receipt — mint (or fetch the existing) public link
router.post("/local-accounts/:id/receipt", requireAuth, requireLocalAccountOwnership("local_account.receipt.create", denyAccountNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const [row] = (await db.execute(sql.raw(
      `SELECT id, receipt_token FROM local_accounts WHERE id = ${id} AND user_id = ${userId} LIMIT 1`
    ))).rows as any[];
    if (!row) { res.status(404).json({ error: "Account not found" }); return; }

    let token = row.receipt_token as string | null;
    if (!token) {
      for (let attempt = 0; attempt < 3 && !token; attempt++) {
        const candidate = generateReceiptToken();
        try {
          const result = await db.execute(sql.raw(
            `UPDATE local_accounts SET receipt_token = ${safe(candidate)}, updated_at = NOW() WHERE id = ${id} RETURNING receipt_token`
          ));
          token = (result.rows[0] as any)?.receipt_token ?? null;
        } catch { /* unique collision — loop and retry */ }
      }
      if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }
    }
    res.json({ token, url: receiptUrl(token) });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// DELETE /local-accounts/:id/receipt — revoke the public link
router.delete("/local-accounts/:id/receipt", requireAuth, requireLocalAccountOwnership("local_account.receipt.revoke", denyAccountNotFound), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid ID" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `UPDATE local_accounts SET receipt_token = NULL, updated_at = NOW() WHERE id = ${id} AND user_id = ${userId} RETURNING id`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "Account not found" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

async function findLocalAccountByReceiptToken(token: string) {
  const rows = (await db.execute(sql.raw(
    `SELECT la.*, u.username AS owner_username FROM local_accounts la
     LEFT JOIN users u ON u.id = la.user_id
     WHERE la.receipt_token = '${token.replace(/'/g, "''")}' LIMIT 1`
  ))).rows as any[];
  return rows[0] ?? null;
}

// GET /local-accounts/receipt/:token — public, no auth
router.get("/local-accounts/receipt/:token", requirePublicAudit("local_account_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = String(req.params.token || "");
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  try {
    const row = await findLocalAccountByReceiptToken(token);
    if (!row) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
    res.json(fmtPublicLocalReceipt(row, row.owner_username ?? null));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /local-accounts/receipt/:token/pdf — public, no auth
router.get("/local-accounts/receipt/:token/pdf", requirePublicAudit("local_account_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = String(req.params.token || "");
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  try {
    const row = await findLocalAccountByReceiptToken(token);
    if (!row) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
    const r = fmtPublicLocalReceipt(row, row.owner_username ?? null);
    const displayName = row.label || row.username || `Local Entity #${row.id}`;

    streamFantasticReceiptPdf(res, {
      kicker: "Local Entity Receipt",
      title: displayName,
      subtitle: row.category ? `${row.category}${r.username ? ` · @${r.username}` : ""}` : (r.username ? `@${r.username}` : undefined),
      avatarLetter: displayName,
      heroLabel: r.roiPct !== null ? "Profit & Loss" : "Account Worth",
      heroValue: r.roiPct !== null
        ? `${r.roiPct >= 0 ? "+" : ""}${r.roiPct.toFixed(1)}%`
        : `$${r.accountWorth.toFixed(2)}`,
      heroPositive: r.roiPct !== null ? r.roiPct >= 0 : undefined,
      stats: [
        { label: "Username", value: r.username || "—" },
        { label: "Followers", value: r.followers ? String(r.followers) : "—" },
        { label: "Account Age", value: r.age ?? "—" },
        { label: "Current Worth", value: `$${r.accountWorth.toFixed(2)}`, color: "#0f9d58" },
        { label: "Buy Price", value: `$${r.buyPrice.toFixed(2)}` },
        { label: "Net Profit", value: r.profit !== null ? `${r.profit >= 0 ? "+" : ""}$${r.profit.toFixed(2)}` : "—", color: r.profit !== null ? (r.profit >= 0 ? "#0f9d58" : "#e4453a") : undefined },
      ],
      receiptId: r.id,
      issuedBy: r.issuedBy,
      filenamePrefix: "local-entity",
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// ─── Category-wise vault receipt ────────────────────────────────────────────
// One shareable, unauthenticated aggregate receipt per category (e.g. all
// "twitter" local accounts) — account count, average age, average follower
// count, and total P&L across every account in that category. Same
// possession-is-auth model as the single-entity receipt above, but keyed on
// (user_id, category) instead of a single row, so it lives in its own table
// (vault_category_receipts) rather than a column on local_accounts.

function generateCategoryReceiptToken(): string {
  return crypto.randomBytes(20).toString("base64url");
}
function categoryReceiptUrl(receiptToken: string): string {
  return `${process.env.APP_URL ?? "https://ayzen.replit.app"}/receipt/vault-category/${receiptToken}`;
}

function ageInDays(dateVal: unknown): number | null {
  if (!dateVal) return null;
  const d = new Date(dateVal as string);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function fmtAvgAgeLabel(avgDays: number | null): string | null {
  if (avgDays === null) return null;
  if (avgDays < 1) return "Today";
  if (avgDays < 30) return `${avgDays.toFixed(0)}d`;
  if (avgDays < 365) return `${(avgDays / 30).toFixed(1)}mo`;
  return `${(avgDays / 365).toFixed(1)}y`;
}

async function computeCategoryAggregate(userId: number, category: string) {
  const rows = (await db.execute(sql.raw(
    `SELECT followers, account_worth, buy_price, account_create_date FROM local_accounts
     WHERE user_id = ${userId} AND category = ${safe(category)}`
  ))).rows as any[];

  const count = rows.length;
  let followerSum = 0, followerCount = 0;
  let ageSum = 0, ageCount = 0;
  let totalWorth = 0, totalBuyValue = 0, pnlCount = 0;

  for (const row of rows) {
    const followers = Number(row.followers);
    if (Number.isFinite(followers)) { followerSum += followers; followerCount++; }

    const days = ageInDays(row.account_create_date);
    if (days !== null) { ageSum += days; ageCount++; }

    const worth = Number(row.account_worth) || 0;
    const buyPrice = Number(row.buy_price) || 0;
    totalWorth += worth;
    if (buyPrice > 0) { totalBuyValue += buyPrice; pnlCount++; }
  }

  const avgFollowers = followerCount > 0 ? followerSum / followerCount : null;
  const avgAgeDays = ageCount > 0 ? ageSum / ageCount : null;
  const totalPnl = pnlCount > 0 ? totalWorth - totalBuyValue : null;
  const pnlPct = totalBuyValue > 0 ? (totalPnl! / totalBuyValue) * 100 : null;

  return {
    count, avgFollowers, avgAgeDays, avgAgeLabel: fmtAvgAgeLabel(avgAgeDays),
    totalWorth, totalBuyValue, totalPnl, pnlPct,
  };
}

// POST /local-accounts/category-receipt/:category — mint (or fetch the existing) public link
router.post("/local-accounts/category-receipt/:category", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const category = String(req.params.category || "").trim();
  if (!category) { res.status(400).json({ error: "Category required" }); return; }
  try {
    const [existing] = (await db.execute(sql.raw(
      `SELECT receipt_token FROM vault_category_receipts WHERE user_id = ${userId} AND category = ${safe(category)}`
    ))).rows as any[];

    let token: string | null = existing?.receipt_token ?? null;
    if (!token) {
      for (let attempt = 0; attempt < 3 && !token; attempt++) {
        const candidate = generateCategoryReceiptToken();
        try {
          const result = await db.execute(sql.raw(
            `INSERT INTO vault_category_receipts (user_id, category, receipt_token) VALUES (${userId}, ${safe(category)}, ${safe(candidate)}) RETURNING receipt_token`
          ));
          token = (result.rows[0] as any)?.receipt_token ?? null;
        } catch { /* unique collision — loop and retry */ }
      }
      if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }
    }
    res.json({ token, url: categoryReceiptUrl(token) });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// DELETE /local-accounts/category-receipt/:category — revoke the public link
router.delete("/local-accounts/category-receipt/:category", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const category = String(req.params.category || "").trim();
  if (!category) { res.status(400).json({ error: "Category required" }); return; }
  try {
    const result = await db.execute(sql.raw(
      `DELETE FROM vault_category_receipts WHERE user_id = ${userId} AND category = ${safe(category)} RETURNING id`
    ));
    if (!result.rows.length) { res.status(404).json({ error: "No active receipt link for this category" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

async function findCategoryReceiptByToken(token: string) {
  const rows = (await db.execute(sql.raw(
    `SELECT vcr.*, u.username AS owner_username FROM vault_category_receipts vcr
     LEFT JOIN users u ON u.id = vcr.user_id
     WHERE vcr.receipt_token = '${token.replace(/'/g, "''")}' LIMIT 1`
  ))).rows as any[];
  const receipt = rows[0] ?? null;
  if (!receipt) return null;
  const aggregate = await computeCategoryAggregate(receipt.user_id, receipt.category);
  return { receipt, issuedBy: receipt.owner_username ?? null, aggregate };
}

function fmtPublicCategoryReceipt(found: NonNullable<Awaited<ReturnType<typeof findCategoryReceiptByToken>>>) {
  const { receipt, issuedBy, aggregate } = found;
  return {
    id: receipt.id,
    category: receipt.category,
    accountCount: aggregate.count,
    avgFollowers: aggregate.avgFollowers,
    avgAge: aggregate.avgAgeLabel,
    totalWorth: aggregate.totalWorth,
    totalBuyValue: aggregate.totalBuyValue,
    totalPnl: aggregate.totalPnl,
    pnlPct: aggregate.pnlPct,
    issuedBy,
    generatedAt: new Date().toISOString(),
  };
}

// GET /local-accounts/category-receipt/:token — public, no auth
router.get("/local-accounts/category-receipt/:token", requirePublicAudit("local_account_category_receipt.view", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = String(req.params.token || "");
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  try {
    const found = await findCategoryReceiptByToken(token);
    if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
    res.json(fmtPublicCategoryReceipt(found));
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// GET /local-accounts/category-receipt/:token/pdf — public, no auth
router.get("/local-accounts/category-receipt/:token/pdf", requirePublicAudit("local_account_category_receipt.pdf", { onDecision: pepDecisionObserver }), async (req, res): Promise<void> => {
  const token = String(req.params.token || "");
  if (!token) { res.status(400).json({ error: "Missing token" }); return; }
  try {
    const found = await findCategoryReceiptByToken(token);
    if (!found) { res.status(404).json({ error: "This receipt link is invalid or has been revoked." }); return; }
    const r = fmtPublicCategoryReceipt(found);
    const displayName = r.category.charAt(0).toUpperCase() + r.category.slice(1);

    streamFantasticReceiptPdf(res, {
      kicker: "Vault Category Receipt",
      title: displayName,
      subtitle: `${r.accountCount} account${r.accountCount === 1 ? "" : "s"}`,
      avatarLetter: displayName,
      heroLabel: r.pnlPct !== null ? "Category P&L" : "Total Worth",
      heroValue: r.pnlPct !== null
        ? `${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(1)}%`
        : `$${r.totalWorth.toFixed(2)}`,
      heroPositive: r.pnlPct !== null ? r.pnlPct >= 0 : undefined,
      stats: [
        { label: "Accounts", value: String(r.accountCount) },
        { label: "Avg Age", value: r.avgAge ?? "—" },
        { label: "Avg Followers", value: r.avgFollowers !== null ? r.avgFollowers.toFixed(0) : "—" },
        { label: "Total Worth", value: `$${r.totalWorth.toFixed(2)}`, color: "#0f9d58" },
        { label: "Total Buy Value", value: `$${r.totalBuyValue.toFixed(2)}` },
        { label: "Total P&L", value: r.totalPnl !== null ? `${r.totalPnl >= 0 ? "+" : ""}$${r.totalPnl.toFixed(2)}` : "—", color: r.totalPnl !== null ? (r.totalPnl >= 0 ? "#0f9d58" : "#e4453a") : undefined },
      ],
      receiptId: r.id,
      issuedBy: r.issuedBy,
      filenamePrefix: "vault-category",
    });
  } catch (err: any) {
    res.status(500).json({ error: "DB error", detail: err?.message });
  }
});

// POST /local-accounts/category-receipt/:category/email — email the receipt link to the requester
router.post("/local-accounts/category-receipt/:category/email", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const category = String(req.params.category || "").trim();
  if (!category) { res.status(400).json({ error: "Category required" }); return; }
  try {
    let [existing] = (await db.execute(sql.raw(
      `SELECT receipt_token FROM vault_category_receipts WHERE user_id = ${userId} AND category = ${safe(category)}`
    ))).rows as any[];

    let token: string | null = existing?.receipt_token ?? null;
    if (!token) {
      for (let attempt = 0; attempt < 3 && !token; attempt++) {
        const candidate = generateCategoryReceiptToken();
        try {
          const result = await db.execute(sql.raw(
            `INSERT INTO vault_category_receipts (user_id, category, receipt_token) VALUES (${userId}, ${safe(category)}, ${safe(candidate)}) RETURNING receipt_token`
          ));
          token = (result.rows[0] as any)?.receipt_token ?? null;
        } catch { /* unique collision — loop and retry */ }
      }
      if (!token) { res.status(500).json({ error: "Could not generate a receipt link, please try again" }); return; }
    }

    const aggregate = await computeCategoryAggregate(userId, category);
    const [recipient] = (await db.execute(sql.raw(
      `SELECT email, username FROM users WHERE id = ${userId}`
    ))).rows as any[];
    if (!recipient?.email) { res.status(400).json({ error: "No email on file for this user" }); return; }

    const { sendReceiptEmail } = await import("../lib/email");
    const displayName = category.charAt(0).toUpperCase() + category.slice(1);
    const result = await sendReceiptEmail(recipient.email, recipient.username, {
      kicker: "Vault Category Receipt",
      title: displayName,
      summary: `${aggregate.count} accounts · Avg followers ${aggregate.avgFollowers !== null ? aggregate.avgFollowers.toFixed(0) : "—"} · Avg age ${aggregate.avgAgeLabel ?? "—"}`,
      url: categoryReceiptUrl(token),
    });
    if (!result.success) { res.status(502).json({ error: "Failed to send email", detail: result.error }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to email receipt", detail: err?.message });
  }
});

export default router;
