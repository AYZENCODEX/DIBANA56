import { Router } from "express";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

function formatSettings(s: typeof settingsTable.$inferSelect) {
  return {
    ...s,
    smtpPassword: s.smtpPassword ? "••••••••" : null, // never expose password
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function getOrCreate() {
  const rows = await db.select().from(settingsTable).limit(1);
  if (rows.length === 0) {
    const [s] = await db.insert(settingsTable).values({}).returning();
    return s;
  }
  return rows[0]!;
}

router.get("/settings", async (_req, res): Promise<void> => {
  const s = await getOrCreate();
  res.json(formatSettings(s));
});

router.patch("/settings", requireAdmin, async (req, res): Promise<void> => {
  const existing = await getOrCreate();
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  const textFields = [
    "platformName", "logoUrl", "primaryColor", "smtpHost", "smtpUser", "smtpPassword", "smtpFrom",
    "telegramBotUsername", "telegramWebhookUrl", "customDomain", "twoFaIssuerName",
    "bkashNumber", "nagadNumber", "usdtAddress", "usdtNetwork",
  ];
  for (const f of textFields) if (req.body[f] !== undefined) updates[f] = String(req.body[f]).trim();
  if (req.body.smtpPort !== undefined) updates.smtpPort = req.body.smtpPort;
  const [s] = await db.update(settingsTable).set(updates).where(eq(settingsTable.id, existing.id)).returning();
  res.json(formatSettings(s!));
});

// NOTE (Phase 10): the old /settings/mail-config* routes that used to live
// here wrote to a separate `user_mail_config` table, keyed one-per-user —
// completely disconnected from the `email_accounts` table the Mail Hub
// Overview and every Vault Email Settings action read from. No frontend page
// called them anymore, but their existence is what made "configure mail in
// Settings" and "see it in Overview" two different, un-synced systems. Mail
// account configuration now goes exclusively through /api/email-accounts
// (see routes/email-accounts.ts) — the single source of truth used by
// Settings, the Mail Hub Overview, and the Vault entity/local/KYC screens.

router.post("/settings/email/test", async (req, res): Promise<void> => {
  const { to } = req.body;
  if (!to) { res.status(400).json({ error: "to is required" }); return; }
  const s = await getOrCreate();
  if (!s.smtpHost || !s.smtpUser || !s.smtpPassword) {
    res.status(400).json({ error: "SMTP not configured. Set host, user, and password first." });
    return;
  }
  try {
    // Dynamic import so nodemailer isn't required at startup
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.default.createTransport({
      host: s.smtpHost,
      port: s.smtpPort ?? 587,
      secure: (s.smtpPort ?? 587) === 465,
      auth: { user: s.smtpUser, pass: s.smtpPassword },
    });
    await transport.sendMail({
      from: s.smtpFrom ?? s.smtpUser,
      to,
      subject: "AYZEN — Email Config Test",
      html: `<div style="font-family:monospace;background:#0a0a0a;color:#06b6d4;padding:24px;border:1px solid #1a1a2e">
        <h2>AYZEN Email Test</h2>
        <p style="color:#ccc">If you received this, your SMTP configuration is working correctly.</p>
        <p style="color:#555;font-size:12px">Sent at ${new Date().toISOString()}</p>
      </div>`,
    });
    res.json({ message: "Test email sent successfully", to });
  } catch (err: any) {
    res.status(500).json({ error: `SMTP error: ${err?.message ?? "Unknown error"}` });
  }
});

export default router;
