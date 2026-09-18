import { logger } from "./logger";

const FROM_DEFAULT = "AYZEN <noreply@ayzen.tech>";

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Optional file attachments — e.g. a scheduled report PDF (see
  // finance-report-schedule-cron.ts). Kept optional/last so every existing
  // call site (none of which attach anything) is untouched.
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export interface SendResult {
  success: boolean;
  id?: string;
  error?: string;
}

async function getSmtpConfig(): Promise<{ host: string; port: number; user: string; pass: string; from: string } | null> {
  try {
    const { pool } = await import("@workspace/db");
    const r = await pool.query("SELECT smtp_host, smtp_port, smtp_user, smtp_password, smtp_from FROM settings LIMIT 1");
    const row = r.rows[0];
    if (!row?.smtp_host || !row?.smtp_user || !row?.smtp_password) return null;
    return { host: row.smtp_host, port: row.smtp_port ?? 587, user: row.smtp_user, pass: row.smtp_password, from: row.smtp_from ?? row.smtp_user };
  } catch { return null; }
}

async function sendViaSmtp(cfg: NonNullable<Awaited<ReturnType<typeof getSmtpConfig>>>, opts: EmailOptions): Promise<SendResult> {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.default.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });
  await transport.sendMail({
    from: cfg.from || FROM_DEFAULT, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text,
    attachments: opts.attachments?.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  });
  logger.info({ to: opts.to }, "Email sent via SMTP");
  return { success: true };
}

async function sendViaResend(opts: EmailOptions): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { success: false, error: "No email transport configured (no SMTP settings, no RESEND_API_KEY)" };
  const { Resend } = await import("resend");
  const resend = new Resend(key);
  const { data, error } = await resend.emails.send({
    from: FROM_DEFAULT, to: opts.to, subject: opts.subject, html: opts.html, text: opts.text,
    attachments: opts.attachments?.map(a => ({ filename: a.filename, content: a.content })),
  });
  if (error) { logger.warn({ error }, "Resend error"); return { success: false, error: error.message }; }
  logger.info({ id: data?.id, to: opts.to }, "Email sent via Resend");
  return { success: true, id: data?.id };
}

export async function sendEmail(opts: EmailOptions): Promise<SendResult> {
  try {
    const smtpCfg = await getSmtpConfig();
    if (smtpCfg) return await sendViaSmtp(smtpCfg, opts);
    return await sendViaResend(opts);
  } catch (err: any) {
    logger.error({ err: err?.message }, "sendEmail failed");
    return { success: false, error: err?.message ?? "Unknown error" };
  }
}

function baseTemplate(content: string): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#0a0d12;font-family:'Courier New',monospace;color:#e0f7f7;}
  .wrap{max-width:560px;margin:40px auto;background:#0d1117;border:1px solid #1a3a3a;border-radius:8px;overflow:hidden;}
  .header{padding:28px 32px;border-bottom:1px solid #1a3a3a;background:#070a0f;}
  .logo{font-size:22px;font-weight:bold;letter-spacing:4px;color:#00d4cc;}
  .sub{font-size:10px;letter-spacing:3px;color:#4a8080;margin-top:4px;text-transform:uppercase;}
  .body{padding:32px;}
  h2{color:#00d4cc;font-size:16px;letter-spacing:2px;text-transform:uppercase;margin:0 0 16px;}
  p{color:#a0c8c8;font-size:13px;line-height:1.7;margin:0 0 12px;}
  .btn{display:inline-block;background:#00d4cc;color:#070a0f;padding:12px 28px;border-radius:4px;text-decoration:none;font-weight:bold;font-size:13px;letter-spacing:2px;text-transform:uppercase;margin:16px 0;}
  .footer{padding:20px 32px;border-top:1px solid #1a3a3a;font-size:10px;color:#2a5050;letter-spacing:1px;}
  .divider{height:1px;background:linear-gradient(to right,transparent,#00d4cc40,transparent);margin:24px 0;}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="logo">&gt;_ AYZEN</div>
    <div class="sub">Airdrop Command Center</div>
  </div>
  <div class="body">${content}</div>
  <div class="footer">
    &copy; 2026 AYZEN &mdash; Encrypted. Autonomous. Profitable.<br/>
    If you didn't request this, ignore this message.
  </div>
</div>
</body>
</html>`;
}

// Phase 7 — Notification Bus generic channel. Every other sendXEmail() in
// this file is a bespoke template for one specific flow (welcome, receipt,
// digest...); the bus needs one template that works for *any* app/category
// so notification-bus.ts doesn't have to grow a new email template every
// time a new producer (Ryft, Skarn, Verve, Warde...) starts emitting a new
// event type. Kept generic on purpose — a bespoke template is still the
// better choice for any flow that deserves one (finance receipts, invites),
// this is only the fallback the bus reaches for.
export async function sendNotificationEmail(
  to: string,
  username: string,
  opts: { category: string; title: string; message: string },
): Promise<SendResult> {
  const html = baseTemplate(`
    <div class="sub" style="margin-bottom:8px;">${opts.category.toUpperCase()}</div>
    <h2>${opts.title}</h2>
    <p>Hi <strong>${username}</strong>,</p>
    <p>${opts.message}</p>
    <div class="divider"></div>
    <p style="font-size:11px;color:#4a8080;">Manage which channels you get these on in Workspace &rarr; Settings &rarr; Notifications.</p>
  `);
  return sendEmail({ to, subject: `AYZEN — ${opts.title}`, html });
}

export async function sendWelcomeEmail(to: string, username: string): Promise<void> {
  const html = baseTemplate(`
    <h2>Access Granted, ${username}</h2>
    <p>Welcome to <strong>AYZEN</strong> — your encrypted airdrop command center.</p>
    <p>You now have access to real-time airdrop tracking, task automation, ROI tracking, and the Telegram bot integration.</p>
    <div class="divider"></div>
    <p style="font-size:11px;color:#4a8080;">Connect Telegram for live task notifications: go to Settings → Telegram Bot → /connect</p>
  `);
  await sendEmail({ to, subject: "Access Granted — Welcome to AYZEN", html });
}

export async function sendPasswordChangedEmail(to: string, username: string): Promise<void> {
  const html = baseTemplate(`
    <h2>Password Changed</h2>
    <p>Hi <strong>${username}</strong>, your AYZEN passphrase was successfully updated.</p>
    <p>If you did not make this change, contact support immediately at <a href="mailto:support@ayzen.tech" style="color:#00d4cc;">support@ayzen.tech</a>.</p>
    <div class="divider"></div>
    <p style="font-size:11px;color:#4a8080;">Security event logged at ${new Date().toUTCString()}</p>
  `);
  await sendEmail({ to, subject: "AYZEN — Passphrase Updated", html });
}

export async function sendTaskApprovedEmail(to: string, username: string, taskName: string, reward?: number | null): Promise<void> {
  const rewardStr = reward ? `<br/>💰 Reward: <strong style="color:#00d4cc;">$${reward}</strong>` : "";
  const html = baseTemplate(`
    <h2>Task Approved ✓</h2>
    <p>Hi <strong>${username}</strong>, your task submission has been verified!</p>
    <p>📋 Task: <strong>${taskName}</strong>${rewardStr}</p>
    <p>Your account has been credited. Keep executing tasks to climb the leaderboard.</p>
  `);
  await sendEmail({ to, subject: `AYZEN — Task Approved: ${taskName}`, html });
}

export async function sendSubscriptionApprovedEmail(to: string, username: string, planName: string): Promise<void> {
  const html = baseTemplate(`
    <h2>Subscription Activated ✓</h2>
    <p>Hi <strong>${username}</strong>, your subscription has been approved by our team!</p>
    <p>🚀 Plan: <strong style="color:#00d4cc;">${planName}</strong> — now active on your account.</p>
    <p>All premium features are unlocked. Start maximizing your airdrop campaigns.</p>
    <div class="divider"></div>
    <a href="https://ayzen.replit.app/subscription" class="btn">View My Plan</a>
  `);
  await sendEmail({ to, subject: `AYZEN — ${planName} Plan Activated ✓`, html });
}

export async function sendSubscriptionRejectedEmail(to: string, username: string, planName: string, reason?: string): Promise<void> {
  const reasonStr = reason ? `<p>📋 Reason: <em>${reason}</em></p>` : "";
  const html = baseTemplate(`
    <h2>Payment Not Verified</h2>
    <p>Hi <strong>${username}</strong>, we could not verify your payment for the <strong>${planName}</strong> plan.</p>
    ${reasonStr}
    <p>Please double-check your transaction ID and contact support if you believe this is an error.</p>
    <div class="divider"></div>
    <a href="https://ayzen.replit.app/subscription" class="btn">Try Again</a>
  `);
  await sendEmail({ to, subject: `AYZEN — Payment Verification Failed`, html });
}

export async function sendTaskSubmittedEmail(to: string, username: string, taskName: string): Promise<void> {
  const html = baseTemplate(`
    <h2>Task Submitted ✓</h2>
    <p>Hi <strong>${username}</strong>, your submission is under review.</p>
    <p>📋 Task: <strong>${taskName}</strong></p>
    <p>Our team will verify your submission shortly. You'll receive another notification when it's approved.</p>
  `);
  await sendEmail({ to, subject: `AYZEN — Task Submitted: ${taskName}`, html });
}

export async function sendTaskRejectedEmail(to: string, username: string, taskName: string, reason?: string): Promise<void> {
  const reasonStr = reason ? `<p>📋 Reason: <em>${reason}</em></p>` : "";
  const html = baseTemplate(`
    <h2>Task Submission Rejected</h2>
    <p>Hi <strong>${username}</strong>, your submission for <strong>${taskName}</strong> was not approved.</p>
    ${reasonStr}
    <p>Please review the task requirements and resubmit with proper proof.</p>
  `);
  await sendEmail({ to, subject: `AYZEN — Task Rejected: ${taskName}`, html });
}

export async function sendVaultHealthDigestEmail(
  to: string,
  username: string,
  lines: string[],
  entryCount: number
): Promise<SendResult> {
  const rows = lines.map((l) => `<p style="margin:0 0 8px;">${l}</p>`).join("");
  const html = baseTemplate(`
    <h2>Vault Risk Digest</h2>
    <p>Hi <strong>${username}</strong>, the daily health scan found ${entryCount} entit${entryCount === 1 ? "y" : "ies"} needing attention. You don't need to be logged in to get this — check it whenever you're ready.</p>
    <div class="divider"></div>
    ${rows}
    <div class="divider"></div>
    <a href="https://ayzen.replit.app/vault" class="btn">Review Vault</a>
  `);
  return sendEmail({ to, subject: `AYZEN — Vault Risk Digest (${entryCount} flagged)`, html });
}

// ─── Generic receipt email ──────────────────────────────────────────────────
// Shared by every "public receipt link" surface (task submission receipt,
// vault category receipt, local/vault entity receipt, project P&L receipt) —
// one template, just a different kicker/title/url/summary line per caller.
// See lib/receipt-theme.ts for the matching PDF template these links open.
export async function sendReceiptEmail(
  to: string,
  username: string,
  opts: { kicker: string; title: string; summary?: string | null; url: string },
): Promise<SendResult> {
  const summaryLine = opts.summary ? `<p>${opts.summary}</p>` : "";
  const html = baseTemplate(`
    <h2>${opts.kicker} Ready</h2>
    <p>Hi <strong>${username}</strong>, here's your receipt for <strong>${opts.title}</strong>.</p>
    ${summaryLine}
    <div class="divider"></div>
    <a href="${opts.url}" class="btn">View Receipt</a>
    <p style="font-size:11px;color:#4a8080;">This link can be shared — anyone holding it can view this receipt, nothing else in your account.</p>
  `);
  return sendEmail({ to, subject: `AYZEN — ${opts.kicker}: ${opts.title}`, html });
}

/** Sent to the payer when a creditor rejects/disputes their passkey-confirmed payment claim. */
export async function sendPaymentDisputedEmail(
  to: string,
  opts: { debtorName: string; creditorName: string; title: string; amount: string; reason: string; url: string },
): Promise<SendResult> {
  const html = baseTemplate(`
    <h2>Payment Disputed</h2>
    <p>Hi <strong>${opts.debtorName}</strong>, <strong>${opts.creditorName}</strong> disputed your payment claim of <strong>${opts.amount}</strong> for <strong>${opts.title}</strong>.</p>
    <p style="font-size:13px;color:#c9564d;">Reason: ${opts.reason}</p>
    <div class="divider"></div>
    <a href="${opts.url}" class="btn">View Invoice</a>
    <p style="font-size:11px;color:#4a8080;">Reach out to ${opts.creditorName} directly to resolve this, or submit a new payment claim with corrected details.</p>
  `);
  return sendEmail({ to, subject: `AYZEN — ${opts.creditorName} disputed your payment`, html });
}

export async function sendTestEmail(to: string): Promise<SendResult> {
  const html = baseTemplate(`
    <h2>Test Transmission</h2>
    <p>This is a test email from your AYZEN platform.</p>
    <p>If you can read this, email delivery is working correctly.</p>
    <div class="divider"></div>
    <p style="font-size:11px;color:#4a8080;">Sent at ${new Date().toUTCString()}</p>
  `);
  return sendEmail({ to, subject: "AYZEN — Test Email ✓", html });
}

// ─── Finance daily digest ────────────────────────────────────────────────────
// One rollup email per user per day — due/overdue items, entries recorded in
// the last 24h, and a net worth snapshot. See lib/finance-notify.ts.
export async function sendFinanceDigestEmail(
  to: string,
  username: string,
  lines: string[],
  summaryLine: string,
): Promise<SendResult> {
  const rows = lines.map((l) => `<p style="margin:0 0 8px;">${l}</p>`).join("");
  const html = baseTemplate(`
    <h2>Finance Daily Digest</h2>
    <p>Hi <strong>${username}</strong>, here's your Finance summary for today.</p>
    <p style="color:#00d4cc;font-weight:bold;">${summaryLine}</p>
    <div class="divider"></div>
    ${rows || "<p>No pending items — you're all caught up.</p>"}
    <div class="divider"></div>
    <a href="https://ayzen.replit.app/finance/dashboard" class="btn">Open Finance</a>
  `);
  return sendEmail({ to, subject: `AYZEN — Finance Daily Digest`, html });
}

// ─── Invoices + Payment Agreements ───────────────────────────────────────────
// See lib/finance-invoice.ts for the token/URL logic these link to.

/** Sent to a debtor when a creditor issues an invoice — the template with the "Repay" button. */
export async function sendInvoiceEmail(
  to: string,
  opts: { debtorName: string; creditorName: string; title: string; amount: string; dueDate?: string | null; notes?: string | null; url: string },
): Promise<SendResult> {
  const dueLine = opts.dueDate ? `<p style="font-size:11px;color:#4a8080;">Due ${opts.dueDate}</p>` : "";
  const notesLine = opts.notes ? `<p>${opts.notes}</p>` : "";
  const html = baseTemplate(`
    <h2>You Have an Invoice</h2>
    <p>Hi <strong>${opts.debtorName}</strong>, <strong>${opts.creditorName}</strong> sent you an invoice on AYZEN for <strong>${opts.title}</strong>.</p>
    <p style="font-size:22px;color:#00d4cc;font-weight:bold;">${opts.amount}</p>
    ${dueLine}
    ${notesLine}
    <div class="divider"></div>
    <a href="${opts.url}" class="btn">Repay Now</a>
    <p style="font-size:11px;color:#4a8080;">Opens a page with ${opts.creditorName}'s payment details (bKash/Nagad/Rocket/bank/USDT). After sending, submit your reference there and confirm with your AYZEN passkey — that confirmation is kept as evidence of payment.</p>
  `);
  return sendEmail({ to, subject: `AYZEN — Invoice from ${opts.creditorName}: ${opts.title}`, html });
}

/** Sent by the overdue-invoice reminder cron (lib/finance-invoice-reminder-cron.ts) — a nudge, not the original invoice. */
export async function sendInvoiceOverdueReminderEmail(
  to: string,
  opts: { debtorName: string; creditorName: string; title: string; amount: string; remainingAmount: string; daysOverdue: number; url: string },
): Promise<SendResult> {
  const html = baseTemplate(`
    <h2>Payment Overdue</h2>
    <p>Hi <strong>${opts.debtorName}</strong>, the invoice from <strong>${opts.creditorName}</strong> for <strong>${opts.title}</strong> was due ${opts.daysOverdue} day(s) ago.</p>
    <p style="font-size:22px;color:#00d4cc;font-weight:bold;">${opts.remainingAmount} remaining</p>
    <div class="divider"></div>
    <a href="${opts.url}" class="btn">Repay Now</a>
  `);
  return sendEmail({ to, subject: `AYZEN — Overdue: ${opts.title} (${opts.amount})`, html });
}

/** Sent to the debtor right after they submit a payment claim — the template with the "Confirm Payment" button that leads to the Payment Agreement page. */
export async function sendPaymentAgreementEmail(
  to: string,
  opts: { debtorName: string; creditorName: string; title: string; amount: string; methodLabel: string; url: string },
): Promise<SendResult> {
  const html = baseTemplate(`
    <h2>Confirm Your Payment</h2>
    <p>Hi <strong>${opts.debtorName}</strong>, you told us you paid <strong>${opts.creditorName}</strong> <strong>${opts.amount}</strong> via ${opts.methodLabel} for <strong>${opts.title}</strong>.</p>
    <p>One step left — sign the Payment Agreement with your AYZEN passkey to confirm it. This creates a timestamped, device-verified record you can keep as evidence that you sent the money.</p>
    <div class="divider"></div>
    <a href="${opts.url}" class="btn">Confirm Payment</a>
  `);
  return sendEmail({ to, subject: `AYZEN — Confirm your payment to ${opts.creditorName}`, html });
}

/** Sent to the creditor when a debtor's payment agreement is passkey-confirmed, ready to verify. */
export async function sendPaymentAgreementReadyEmail(
  to: string,
  opts: { creditorName: string; debtorName: string; title: string; amount: string; url: string },
): Promise<SendResult> {
  const html = baseTemplate(`
    <h2>Payment Confirmed by ${opts.debtorName}</h2>
    <p>Hi <strong>${opts.creditorName}</strong>, <strong>${opts.debtorName}</strong> confirmed a payment of <strong>${opts.amount}</strong> for <strong>${opts.title}</strong>, signed with their AYZEN passkey.</p>
    <div class="divider"></div>
    <a href="${opts.url}" class="btn">Review &amp; Verify</a>
    <p style="font-size:11px;color:#4a8080;">Verifying posts a real repayment against this entry in your books.</p>
  `);
  return sendEmail({ to, subject: `AYZEN — ${opts.debtorName} confirmed a payment`, html });
}
