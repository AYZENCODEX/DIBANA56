import { Router, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// ─── Route Integration Roadmap — Season C, Phase C24 (ayzen_mail dual-owner) ─
// Every resource migrated in this series so far has been single-owner
// (`user_id = X`, checked via `resource.ownerId === subject.userId`,
// Phase 03's `createResourceOwnershipRule()` — see that file's own
// header). `ayzen_mail` is the first one in this sweep where a row can be
// "owned" by either of two different roles (`to_user_id` the receiver,
// `from_user_id` the sender) depending on the action — and `DELETE`
// itself takes a DIFFERENT action per role (soft-delete-by-receiver vs.
// soft-delete-by-sender), not just a yes/no gate. `ResourceRef.ownerId`
// (lib/policy/types.ts, Phase 01A) is a single scalar compared with
// `===` — there's no multi-owner primitive to reach for, and this phase
// deliberately does NOT touch that shared Phase 03 rule for one file's
// edge case (Rule 16 — don't implement future phases prematurely). Two
// resource shapes below, one per role-check:
//
//   - `PATCH /:id/read` is receiver-only (only the recipient marks a
//     mail read) — an ordinary single-owner check against `to_user_id`,
//     same shape as every other file in this series.
//   - `DELETE /:id` needs "is this subject EITHER party" as the gate,
//     but the handler downstream still needs to know WHICH party to
//     pick the right soft-delete column — so the builder folds the OR
//     into `ownerId` itself (`ownerId = subject.userId` when the
//     subject is either party, a sentinel otherwise — reusing
//     Phase 03's own `ownerId === subject.userId` comparison as an OR-
//     gate instead of writing a second PolicyRule for one file), and the
//     handler's own pre-existing to_user_id/from_user_id branch below
//     (unchanged) still decides which soft-delete happens.
//
// The pre-existing behavior also distinguishes a genuinely nonexistent
// id (`404 "Not found"`) from an existing-but-not-your-mail id
// (`403 "Forbidden"`) — two different sentinels let a single onDeny
// (reading `outcome.request.resource.ownerId` back) preserve that exact
// distinction instead of collapsing both into one response.

// ─── Receiver-only ownership (PATCH .../read) ──────────────────────────────
const AYZEN_MAIL_RECEIVER_SENTINEL_NONE = -1;
const ayzenMailReceiverResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mail_receiver", id: req.params.id, ownerId: AYZEN_MAIL_RECEIVER_SENTINEL_NONE };
  const rows = (await db.execute(sql`SELECT to_user_id FROM ayzen_mail WHERE id = ${id} LIMIT 1`)).rows as any[];
  return { type: "ayzen_mail_receiver", id, ownerId: rows[0]?.to_user_id ?? AYZEN_MAIL_RECEIVER_SENTINEL_NONE };
};
function requireAyzenMailReceiverOwnership(action: string, onDeny: (req: Request, res: Response) => void) {
  return requireOwnership(action, ayzenMailReceiverResource, { onDecision: pepDecisionObserver, onDeny });
}

// ─── Dual-role "either party" gate (DELETE) — see file header ─────────────
// Two distinct sentinels (not found vs. not-a-party) so the DELETE route's
// own onDeny below can still tell the two pre-existing deny bodies apart.
const AYZEN_MAIL_NOT_FOUND_SENTINEL = -1;
const AYZEN_MAIL_NOT_PARTY_SENTINEL = -2;
const ayzenMailPartyResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) return { type: "ayzen_mail", id: req.params.id, ownerId: AYZEN_MAIL_NOT_FOUND_SENTINEL };
  const rows = (await db.execute(sql`SELECT from_user_id, to_user_id FROM ayzen_mail WHERE id = ${id} LIMIT 1`)).rows as any[];
  const row = rows[0] as any;
  if (!row) return { type: "ayzen_mail", id, ownerId: AYZEN_MAIL_NOT_FOUND_SENTINEL };
  const userId = req.user!.userId;
  const isParty = row.to_user_id === userId || row.from_user_id === userId;
  return { type: "ayzen_mail", id, ownerId: isParty ? userId : AYZEN_MAIL_NOT_PARTY_SENTINEL };
};

// GET /ayzen-mail — inbox for current user
router.get("/ayzen-mail", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql`
      SELECT m.*, u.username as from_username, u.email as from_email
      FROM ayzen_mail m
      LEFT JOIN users u ON u.id = m.from_user_id
      WHERE m.to_user_id = ${userId} AND m.deleted_by_receiver = false
      ORDER BY m.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch { res.json([]); }
});

// GET /ayzen-mail/sent — sent items for current user
router.get("/ayzen-mail/sent", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql`
      SELECT m.*, u.username as to_username, u.email as to_email
      FROM ayzen_mail m
      LEFT JOIN users u ON u.id = m.to_user_id
      WHERE m.from_user_id = ${userId} AND m.deleted_by_sender = false
      ORDER BY m.created_at DESC
      LIMIT 100
    `);
    res.json(result.rows);
  } catch { res.json([]); }
});

// GET /ayzen-mail/unread-count
router.get("/ayzen-mail/unread-count", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(sql`SELECT COUNT(*) as count FROM ayzen_mail WHERE to_user_id = ${userId} AND is_read = false AND deleted_by_receiver = false`);
    res.json({ count: parseInt(String((result.rows[0] as any)?.count ?? 0), 10) });
  } catch { res.json({ count: 0 }); }
});

// POST /ayzen-mail — compose and send
router.post("/ayzen-mail", requireAuth, async (req, res): Promise<void> => {
  const fromUserId = req.user!.userId;
  const { to, subject, body } = req.body;
  if (!to || !body) { res.status(400).json({ error: "to and body are required" }); return; }
  const target = await db.execute(sql`SELECT id, username, email FROM users WHERE username = ${to} OR email = ${to} LIMIT 1`);
  if (target.rows.length === 0) { res.status(404).json({ error: "Recipient not found" }); return; }
  const toUser = target.rows[0] as any;
  const result = await db.execute(sql`
    INSERT INTO ayzen_mail (from_user_id, to_user_id, subject, body)
    VALUES (${fromUserId}, ${toUser.id}, ${subject || "(no subject)"}, ${body})
    RETURNING *
  `);
  res.status(201).json(result.rows[0]);
});

// PATCH /ayzen-mail/:id/read — mark as read
router.patch("/ayzen-mail/:id/read", requireAuth, requireAyzenMailReceiverOwnership("ayzen_mail.read.mark", (_req, res) => { res.json({ success: true }); }), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  await db.execute(sql`UPDATE ayzen_mail SET is_read = true WHERE id = ${id} AND to_user_id = ${userId}`);
  res.json({ success: true });
});

// DELETE /ayzen-mail/:id — soft delete
router.delete(
  "/ayzen-mail/:id",
  requireAuth,
  requireOwnership("ayzen_mail.delete", ayzenMailPartyResource, {
    onDecision: pepDecisionObserver,
    // Two sentinels (see ayzenMailPartyResource above) so this one onDeny
    // still reproduces the two pre-existing deny bodies exactly: a
    // genuinely nonexistent id stays 404 "Not found", an existing mail
    // this subject isn't a party to stays 403 "Forbidden" — collapsing
    // both into one body would be a real behavior change, not preserved.
    onDeny: (_req: Request, res: Response, _next: NextFunction, outcome) => {
      const deniedOwnerId = outcome?.request?.resource?.ownerId;
      if (deniedOwnerId === AYZEN_MAIL_NOT_FOUND_SENTINEL) {
        res.status(404).json({ error: "Not found" });
      } else {
        res.status(403).json({ error: "Forbidden" });
      }
    },
  }),
  async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const mail = await db.execute(sql`SELECT from_user_id, to_user_id FROM ayzen_mail WHERE id = ${id}`);
  if (mail.rows.length === 0) { res.status(404).json({ error: "Not found" }); return; }
  const m = mail.rows[0] as any;
  if (m.to_user_id === userId) {
    await db.execute(sql`UPDATE ayzen_mail SET deleted_by_receiver = true WHERE id = ${id}`);
  } else if (m.from_user_id === userId) {
    await db.execute(sql`UPDATE ayzen_mail SET deleted_by_sender = true WHERE id = ${id}`);
  } else {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  res.json({ success: true });
});

export default router;
