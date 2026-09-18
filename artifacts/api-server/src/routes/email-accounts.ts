import { Router, type Request, type Response } from "express";
import { db, emailAccountsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import * as imaps from "imap-simple";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import nodemailer from "nodemailer";
import { encryptField, decryptField } from "../lib/vault-crypto";
import { syncInbox } from "../lib/mail-sync";
import { fetchMessageByUid } from "../lib/imap-fetch";
import { logger } from "../lib/logger";

const router = Router();

function getUserId(req: any): number { return req.user!.userId; }

// ─── Route Integration Roadmap — Season C, Phase C7 (mechanical sweep, batch 7) ─
// Same combined-where ownership shape flagged by Phase C5 for a future
// manual audit. Every route below already does its own
// `SELECT/UPDATE/DELETE ... WHERE id=$1 AND userId=$2` for this exact
// `:id` — that scoping is unchanged (Rule: don't remove a working system).
// This adds the same SECOND, PDP-routed ownership check Phase B1/C1-C6
// already add elsewhere, wired through the shared `pepDecisionObserver`
// (Phase A3) so the decision lands in the same audit/telemetry path.
//
// Two different 404 bodies exist across these routes ("Not found" for
// GET/PUT/:id, "Account not found" for the IMAP-calling routes) — `onDeny`
// is parameterized per call site so each keeps its own exact pre-existing
// body (Phase B1's "onDeny for byte-for-byte response parity" pattern).
const EMAIL_ACCOUNT_OWNER_SENTINEL_NONE = -1;

const emailAccountResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "email_account", id: req.params.id, ownerId: EMAIL_ACCOUNT_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: emailAccountsTable.userId }).from(emailAccountsTable)
    .where(eq(emailAccountsTable.id, id)).limit(1);
  return { type: "email_account", id, ownerId: row?.userId ?? EMAIL_ACCOUNT_OWNER_SENTINEL_NONE };
};

function requireEmailAccountOwnership(action: string, notFoundBody: { error: string }) {
  return requireOwnership(action, emailAccountResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json(notFoundBody);
    },
  });
}

export type MailConfig = {
  emailAddress: string; imapHost?: string; imapPort?: number;
  smtpHost?: string; smtpPort?: number; username?: string;
  password?: string; authKey?: string; useSSL?: boolean;
};

export async function testMailConfig(config: MailConfig) {
  const secret = config.authKey || config.password;
  if (!config.emailAddress || !config.imapHost || !config.smtpHost || !secret) {
    throw new Error("Email, IMAP host, SMTP host, and password/auth key are required");
  }
  const imapConnection = await (imaps as any).connect({
    imap: {
      user: config.username || config.emailAddress, password: secret,
      host: config.imapHost, port: Number(config.imapPort || 993),
      tls: config.useSSL !== false, tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000, connTimeout: 15000,
    },
  });
  try { await imapConnection.openBox("INBOX"); } finally { try { imapConnection.end(); } catch {} }
  const transporter = nodemailer.createTransport({
    host: config.smtpHost, port: Number(config.smtpPort || 587),
    secure: Number(config.smtpPort || 587) === 465,
    auth: { user: config.username || config.emailAddress, pass: secret },
    tls: { rejectUnauthorized: false },
  });
  await transporter.verify();
}

function fmt(e: typeof emailAccountsTable.$inferSelect) {
  return {
    ...e,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    password: e.password ? "••••••••" : null,
    authKey: e.authKey ? "••••••••" : null,
  };
}

router.post("/email-accounts/test-config", requireAuth, async (req, res): Promise<void> => {
  try {
    const body = req.body as MailConfig & { accountId?: number };
    let config = body;
    if (body.accountId) {
      const [existing] = await db.select().from(emailAccountsTable).where(and(
        eq(emailAccountsTable.id, Number(body.accountId)),
        eq(emailAccountsTable.userId, req.user!.userId),
      ));
      if (!existing) { res.status(404).json({ error: "Account not found" }); return; }
      config = {
        ...existing,
        ...body,
        emailAddress: body.emailAddress || existing.emailAddress,
        password: body.password || decryptField(existing.password) || undefined,
        authKey: body.authKey || decryptField(existing.authKey) || undefined,
      } as MailConfig & { accountId?: number };
    }
    await testMailConfig(config);
    res.json({ success: true, message: "IMAP and SMTP connections verified" });
  } catch (err: any) {
    res.status(422).json({ success: false, error: "Connection failed", detail: err?.message ?? "Unable to connect" });
  }
});

router.get("/email-accounts", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const rows = await db.select().from(emailAccountsTable).where(eq(emailAccountsTable.userId, userId));
  res.json(rows.map(fmt));
});

router.get("/email-accounts/:id", requireAuth, requireEmailAccountOwnership("email_account.read", { error: "Not found" }), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [row] = await db.select().from(emailAccountsTable)
    .where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId)));
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ ...fmt(row), password: decryptField(row.password) });
});

router.post("/email-accounts", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const { label, emailAddress, protocol, provider, imapHost, imapPort, smtpHost, smtpPort, username, password, authKey, sessionPooler, useSSL, isDefault, notes, tags } = req.body;
  if (!label || !emailAddress) { res.status(400).json({ error: "label and emailAddress required" }); return; }

  if (isDefault) {
    await db.update(emailAccountsTable).set({ isDefault: false }).where(eq(emailAccountsTable.userId, userId));
  }

  const [row] = await db.insert(emailAccountsTable).values({
    userId, label, emailAddress, protocol: protocol ?? "IMAP", provider: provider ?? "custom",
    imapHost, imapPort: imapPort ? parseInt(imapPort, 10) : 993,
    smtpHost, smtpPort: smtpPort ? parseInt(smtpPort, 10) : 587,
    username, password: encryptField(password), authKey: encryptField(authKey), sessionPooler, useSSL: useSSL !== false, isDefault: !!isDefault,
    notes, tags,
  }).returning();
  res.status(201).json(fmt(row));
});

router.put("/email-accounts/:id", requireAuth, requireEmailAccountOwnership("email_account.update", { error: "Not found" }), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { label, emailAddress, protocol, provider, imapHost, imapPort, smtpHost, smtpPort, username, password, authKey, sessionPooler, useSSL, isDefault, notes, tags } = req.body;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (label !== undefined) updates.label = label;
  if (emailAddress !== undefined) updates.emailAddress = emailAddress;
  if (protocol !== undefined) updates.protocol = protocol;
  if (provider !== undefined) updates.provider = provider;
  if (imapHost !== undefined) updates.imapHost = imapHost;
  if (imapPort !== undefined) updates.imapPort = parseInt(imapPort, 10);
  if (smtpHost !== undefined) updates.smtpHost = smtpHost;
  if (smtpPort !== undefined) updates.smtpPort = parseInt(smtpPort, 10);
  if (username !== undefined) updates.username = username;
  if (password !== undefined && password !== "••••••••") updates.password = encryptField(password);
  if (authKey !== undefined && authKey !== "••••••••") updates.authKey = encryptField(authKey);
  if (sessionPooler !== undefined) updates.sessionPooler = sessionPooler;
  if (useSSL !== undefined) updates.useSSL = useSSL;
  if (isDefault !== undefined) updates.isDefault = isDefault;
  if (notes !== undefined) updates.notes = notes;
  if (tags !== undefined) updates.tags = tags;

  if (isDefault) {
    await db.update(emailAccountsTable).set({ isDefault: false }).where(eq(emailAccountsTable.userId, userId));
  }

  const [row] = await db.update(emailAccountsTable).set(updates)
    .where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId))).returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(fmt(row));
});

// This route never 404'd — a nonexistent/not-yours id silently no-ops (the
// DELETE's own `WHERE id=$1 AND userId=$2` just matches zero rows) and
// still returns `{ ok: true }`. `onDeny` reproduces that exact response
// rather than introducing a new 404 status this route never had.
router.delete(
  "/email-accounts/:id",
  requireAuth,
  requireOwnership("email_account.delete", emailAccountResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => { res.json({ ok: true }); },
  }),
  async (req, res): Promise<void> => {
    const userId = getUserId(req);
    const id = parseInt(req.params.id as string, 10);
    await db.delete(emailAccountsTable).where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId)));
    res.json({ ok: true });
  },
);

// ─── POST /email-accounts/:id/fetch-inbox — fetch emails via IMAP ─────────────
router.post("/email-accounts/:id/fetch-inbox", requireAuth, requireEmailAccountOwnership("email_account.fetch_inbox", { error: "Account not found" }), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const limit = Math.min(parseInt(req.body?.limit ?? "50", 10), 100);
  const mailbox = (req.body?.mailbox as string) || "INBOX";

  const [account] = await db.select().from(emailAccountsTable)
    .where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId)));
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }
  if (!account.imapHost || !(account.password || account.authKey)) {
    res.status(400).json({ error: "IMAP not fully configured — host and password/auth key required" }); return;
  }

  try {
    const { messages, total } = await syncInbox(account, {
      limit, mailbox,
      sourceCategory: (req.body?.sourceCategory as string) || "other",
      sourceId: req.body?.sourceId ?? null,
    });
    res.json({ messages, total });
  } catch (err: any) {
    const msg = err?.message ?? "Unknown error";
    res.status(500).json({ error: "IMAP connection failed", detail: msg });
  }
});

// ─── POST /email-accounts/:id/fetch-body — fetch full body of a single email ──
router.post("/email-accounts/:id/fetch-body", requireAuth, requireEmailAccountOwnership("email_account.fetch_body", { error: "Account not found or not configured" }), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const { seqno, mailbox = "INBOX" } = req.body;
  if (!seqno) { res.status(400).json({ error: "seqno required" }); return; }

  const [account] = await db.select().from(emailAccountsTable)
    .where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId)));
  if (!account || !account.imapHost || !(account.password || account.authKey)) {
    res.status(404).json({ error: "Account not found or not configured" }); return;
  }

  const imapConfig = {
    imap: {
      user: account.username ?? account.emailAddress,
      password: decryptField(account.authKey) || decryptField(account.password),
      host: account.imapHost,
      port: account.imapPort ?? 993,
      tls: account.useSSL !== false,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 15000,
      connTimeout: 15000,
    },
  };

  let connection: any = null;
  try {
    // seqno shifts whenever mail is deleted/moved on the server; uid is
    // stable. We already have uid cached from the last sync, so look it up
    // instead of trying to fetch by seqno directly (which also isn't
    // supported by imap-simple's public API — see lib/imap-fetch.ts).
    const cached = await db.execute(sql`
      SELECT uid FROM mail_messages WHERE email_account_id = ${id} AND seqno = ${seqno} LIMIT 1
    `);
    const cachedUid = (cached.rows[0] as any)?.uid;
    if (cachedUid == null) {
      res.status(404).json({ error: "Message not found in synced cache — try syncing the inbox again" });
      return;
    }

    try {
      connection = await (imaps as any).connect(imapConfig);
    } catch (connErr: any) {
      logger.error(
        { accountId: id, host: account.imapHost, port: imapConfig.imap.port, err: connErr?.message ?? connErr },
        "[fetch-body] IMAP connect/auth failed",
      );
      throw connErr;
    }
    try {
      await connection.openBox(mailbox);
    } catch (boxErr: any) {
      logger.error({ accountId: id, mailbox, err: boxErr?.message ?? boxErr }, "[fetch-body] IMAP openBox failed");
      throw boxErr;
    }

    const msg = await fetchMessageByUid(connection, cachedUid, {
      bodies: ["TEXT", "HEADER"],
      markSeen: false,
      struct: false,
    });

    const textPart = msg?.parts?.find((p: any) => p.which === "TEXT");
    const headerPart = msg?.parts?.find((p: any) => p.which === "HEADER");
    const hdr = headerPart?.body ?? {};

    // Strip HTML tags for plain text display
    let body = (textPart?.body as string) ?? "";
    // Remove base64 encoded sections (usually attachments) and trim
    body = body.replace(/Content-Transfer-Encoding: base64[\s\S]*?(?=--|\z)/gm, "[attachment]");
    body = body.substring(0, 8000);

    connection.end();

    const uid = msg?.attributes?.uid ?? cachedUid ?? null;
    if (uid != null) {
      try {
        await db.execute(sql`
          UPDATE mail_messages SET body_text = ${encryptField(body)}, fetched_at = NOW()
          WHERE email_account_id = ${id} AND uid = ${uid}
        `);
      } catch (cacheErr) {
        console.error("[mail_messages] body cache write failed:", cacheErr);
      }
    }

    res.json({
      seqno,
      subject: (Array.isArray(hdr.subject) ? hdr.subject[0] : hdr.subject) || "(no subject)",
      from: (Array.isArray(hdr.from) ? hdr.from[0] : hdr.from) || "",
      date: (Array.isArray(hdr.date) ? hdr.date[0] : hdr.date) || "",
      body,
    });
  } catch (err: any) {
    try { connection?.end(); } catch {}
    logger.error({ accountId: id, seqno, err: err?.message ?? err }, "[fetch-body] failed");
    res.status(500).json({ error: "Failed to fetch email body", detail: err?.message });
  }
});

// ─── GET /email-accounts/:id/stored-messages — read cached inbox from DB ──────
// Powers the Mail Hub's Email tab / Overview list without a live IMAP call.
router.get("/email-accounts/:id/stored-messages", requireAuth, requireEmailAccountOwnership("email_account.stored_messages.read", { error: "Account not found" }), async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const id = parseInt(req.params.id as string, 10);
  const [account] = await db.select().from(emailAccountsTable)
    .where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId)));
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 200);
  const result = await db.execute(sql`
    SELECT id, uid, seqno, from_addr AS "from", to_addr AS "to", subject, message_date AS date,
           (body_text IS NOT NULL) AS "hasBody"
    FROM mail_messages
    WHERE email_account_id = ${id}
    ORDER BY message_date DESC NULLS LAST, id DESC
    LIMIT ${limit}
  `);
  res.json({ messages: result.rows, total: result.rows.length });
});

// ─── GET /mail-messages/search — full-text search across synced mail ──────────
// Registered BEFORE /mail-messages/:msgId so "search" isn't swallowed as a
// :msgId param. Searches subject + sender only (body stays encrypted, out of
// the index — see the search_vector migration note in index.ts). Optionally
// scoped to one Vault category/entity.
router.get("/mail-messages/search", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const q = ((req.query.q as string) ?? "").trim();
  if (!q) { res.json({ messages: [] }); return; }
  const category = (req.query.category as string) || null;
  const sourceId = req.query.sourceId != null ? String(req.query.sourceId) : null;

  const categoryClause = category ? sql`AND source_category = ${category}` : sql``;
  const sourceClause = sourceId ? sql`AND source_id = ${sourceId}` : sql``;

  const result = await db.execute(sql`
    SELECT mm.id, mm.email_account_id AS "emailAccountId", ea.email_address AS "accountEmail",
           mm.uid, mm.seqno, mm.from_addr AS "from", mm.to_addr AS "to", mm.subject,
           mm.message_date AS date, mm.source_category AS "sourceCategory", mm.source_id AS "sourceId",
           ts_rank(mm.search_vector, plainto_tsquery('english', ${q})) AS rank
    FROM mail_messages mm
    LEFT JOIN email_accounts ea ON ea.id = mm.email_account_id
    WHERE mm.user_id = ${userId}
      AND mm.search_vector @@ plainto_tsquery('english', ${q})
      ${categoryClause} ${sourceClause}
    ORDER BY rank DESC, mm.message_date DESC NULLS LAST
    LIMIT 50
  `);
  res.json({ messages: result.rows });
});

// ─── GET /mail-messages/:msgId — single cached message (with body) ────────────
router.get("/mail-messages/:msgId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const msgId = parseInt(req.params.msgId as string, 10);
  const result = await db.execute(sql`
    SELECT id, email_account_id AS "emailAccountId", uid, seqno, from_addr AS "from", to_addr AS "to",
           subject, body_text AS body, message_date AS date, source_category AS "sourceCategory", source_id AS "sourceId"
    FROM mail_messages
    WHERE id = ${msgId} AND user_id = ${userId}
    LIMIT 1
  `);
  if (result.rows.length === 0) { res.status(404).json({ error: "Message not found" }); return; }
  const row: any = result.rows[0];
  res.json({ ...row, body: decryptField(row.body) });
});

export default router;
