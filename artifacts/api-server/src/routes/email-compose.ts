import { Router, type Request, type Response } from "express";
import { db, emailAccountsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import nodemailer from "nodemailer";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";
import { requireCreditBalance, chargeCredits } from "../services/credit-meter";

const router = Router();

async function getAccount(userId: number, id: number) {
  const [row] = await db.select().from(emailAccountsTable)
    .where(and(eq(emailAccountsTable.id, id), eq(emailAccountsTable.userId, userId)));
  return row ?? null;
}

// ─── Route Integration Roadmap — Season C, Phase C14 (mechanical sweep,
// batch 14: email-compose.ts) ────────────────────────────────────────────
// This file was flagged as an exclusion in every phase since C9/C10
// ("no requireAuth wiring of its own") — turns out that's understating
// the problem. All three routes below authenticated via a direct
// `await getUserIdAsync(req)` call instead of the `requireAuth`
// middleware every other route in the app uses. `getUserIdAsync()`
// *throws* `AuthError` on a missing/invalid token (see lib/auth-utils.ts)
// hit an unhandled rejection inside an async Express handler with no
// error middleware to catch it — for the person calling the API, that's
// an indefinitely hanging request (or a raw stack trace, depending on
// the Express/Node version's default unhandled-rejection behavior), not
// an auth failure they could act on.
// Switching to `requireAuth` isn't just style-for-consistency here — it's
// the fix: `requireAuth` (Phase A1/A2) turns exactly this case into the
// same clean `401 { error: "Unauthorized", code: "NO_TOKEN" | "INVALID_TOKEN" }`
// every other route already gives, and — as a direct consequence — also
// finally makes `req.user` available so these routes can carry the same
// `requireOwnership()` gate `email-accounts.ts` already runs for this
// exact table. `getAccount()`'s own ownership-scoped query stays exactly
// as it was — same "PEP additive, handler's own logic untouched"
// posture as everywhere else in this series.
//
// Deliberately a LOCAL resource builder rather than importing
// `email-accounts.ts`'s private `emailAccountResource` — every other
// phase in this series keeps its `ResourceRefBuilder` self-contained
// inside the file it protects rather than reaching into a sibling route
// file's module-private helpers; the `type: "email_account"` string is
// kept identical to `email-accounts.ts` so both files' decisions land in
// the same audit bucket for this resource.
const EMAIL_ACCOUNT_OWNER_SENTINEL_NONE = -1;

const emailAccountResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "email_account", id: req.params.id, ownerId: EMAIL_ACCOUNT_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: emailAccountsTable.userId }).from(emailAccountsTable)
    .where(eq(emailAccountsTable.id, id)).limit(1);
  return { type: "email_account", id, ownerId: row?.userId ?? EMAIL_ACCOUNT_OWNER_SENTINEL_NONE };
};

function requireEmailAccountOwnership(action: string) {
  return requireOwnership(action, emailAccountResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Account not found" });
    },
  });
}

// Send email via SMTP
// PHASE 5: metered action wisp.custom_send. Personal AYZEN mail (POST
// /ayzen-mail in routes/ayzen-mail.ts) stays free per §5 — this route is
// the "custom routing" case, relaying through the user's own external SMTP
// account rather than AYZEN's own mail infra, so it's the one that's
// metered.
router.post("/email-accounts/:id/send", requireAuth, requireEmailAccountOwnership("email_account.send"), requireCreditBalance("wisp.custom_send"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  const acc = await getAccount(userId, id);
  if (!acc) { res.status(404).json({ error: "Account not found" }); return; }
  if (!acc.smtpHost || !acc.password) {
    res.status(400).json({ error: "SMTP host and password are required to send email" }); return;
  }

  const { to, subject, body, html } = req.body;
  if (!to || !subject || (!body && !html)) {
    res.status(400).json({ error: "to, subject, and body are required" }); return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: acc.smtpHost,
      port: acc.smtpPort ?? 587,
      secure: (acc.smtpPort ?? 587) === 465,
      auth: { user: acc.username ?? acc.emailAddress, pass: acc.password },
      tls: { rejectUnauthorized: false },
    });

    const info = await transporter.sendMail({
      from: `${acc.label} <${acc.emailAddress}>`,
      to,
      subject,
      text: body,
      html: html ?? body,
    });

    // Charge-on-success: only once nodemailer confirms the SMTP server
    // accepted the message do we deduct — a bad SMTP password never costs
    // the user credits, it just 500s as before.
    await chargeCredits(userId, "wisp.custom_send");
    res.json({ success: true, messageId: info.messageId, accepted: info.accepted });
  } catch (err: any) {
    res.status(500).json({ error: `SMTP error: ${err?.message ?? "Send failed"}` });
  }
});

// Fetch inbox via IMAP
router.get("/email-accounts/:id/inbox", requireAuth, requireEmailAccountOwnership("email_account.inbox.read"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  const acc = await getAccount(userId, id);
  if (!acc) { res.status(404).json({ error: "Account not found" }); return; }
  if (!acc.imapHost || !acc.password) {
    res.status(400).json({ error: "IMAP host and password are required" }); return;
  }

  try {
    // Dynamic import to avoid startup errors
    const imapSimple = await import("imap-simple");
    const limit = Math.min(parseInt((req.query.limit as string) ?? "20", 10), 50);
    const folder = (req.query.folder as string) ?? "INBOX";

    const config = {
      imap: {
        user: acc.username ?? acc.emailAddress,
        password: acc.password,
        host: acc.imapHost,
        port: acc.imapPort ?? 993,
        tls: acc.useSSL !== false,
        tlsOptions: { rejectUnauthorized: false },
        authTimeout: 10000,
        connTimeout: 15000,
      },
    };

    const connection = await imapSimple.connect(config);
    await connection.openBox(folder);

    // Get latest N messages
    const searchCriteria = ["ALL"];
    const fetchOptions = {
      bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
      markSeen: false,
      struct: false,
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    connection.end();

    // Parse and return latest N
    const parsed = messages
      .slice(-limit)
      .reverse()
      .map((msg: any) => {
        const headerPart = msg.parts.find((p: any) => p.which === "HEADER.FIELDS (FROM TO SUBJECT DATE)");
        const textPart = msg.parts.find((p: any) => p.which === "TEXT");
        const header = headerPart?.body ?? {};
        return {
          uid: msg.attributes.uid,
          seqno: msg.seqno,
          flags: msg.attributes.flags ?? [],
          date: (header.date?.[0] ?? "").trim(),
          from: (header.from?.[0] ?? "").trim(),
          to: (header.to?.[0] ?? "").trim(),
          subject: (header.subject?.[0] ?? "(no subject)").trim(),
          preview: (textPart?.body ?? "").substring(0, 200).replace(/\s+/g, " ").trim(),
        };
      });

    res.json({ folder, count: parsed.length, messages: parsed });
  } catch (err: any) {
    const msg = err?.message ?? "IMAP connection failed";
    const hint = msg.includes("Invalid credentials") ? " — Check username/password (Gmail needs App Password)" : "";
    res.status(500).json({ error: `IMAP error: ${msg}${hint}` });
  }
});

// Test SMTP connection
router.post("/email-accounts/:id/test", requireAuth, requireEmailAccountOwnership("email_account.test_connection"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  const acc = await getAccount(userId, id);
  if (!acc) { res.status(404).json({ error: "Account not found" }); return; }
  if (!acc.smtpHost || !acc.password) {
    res.status(400).json({ error: "SMTP host and password required" }); return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: acc.smtpHost,
      port: acc.smtpPort ?? 587,
      secure: (acc.smtpPort ?? 587) === 465,
      auth: { user: acc.username ?? acc.emailAddress, pass: acc.password },
      tls: { rejectUnauthorized: false },
    });
    await transporter.verify();
    res.json({ success: true, message: "SMTP connection verified" });
  } catch (err: any) {
    res.status(500).json({ error: `SMTP verify failed: ${err?.message}` });
  }
});

export default router;
