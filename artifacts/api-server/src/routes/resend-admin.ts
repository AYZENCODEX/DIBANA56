/**
 * routes/resend-admin.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time (and re-runnable) admin setup for the native ayzen.tech mailbox:
 *   1. POST /admin/resend-email/setup-domain
 *        - creates (or finds) the ayzen.tech domain on Resend
 *        - if the "Cloudflare Email" plugin is already configured, pushes
 *          every DNS record Resend asked for straight onto the Cloudflare
 *          zone (MX for receiving, TXT for SPF/DKIM/DMARC)
 *        - attempts verification and returns current status either way
 *   2. GET  /admin/resend-email/status — re-check without re-pushing records
 *
 * Requires RESEND_API_KEY (or the "Resend Email" plugin's apiKey) and, for
 * the auto-push step, the existing "Cloudflare Email" plugin already holding
 * a Cloudflare API token with Zone DNS edit + Zone Email Routing permissions
 * for ayzen.tech.
 */
import { Router } from "express";
import { requireAdmin } from "../middlewares/auth";
import { getResendConfig, ensureResendDomain, getResendDomain, verifyResendDomain, pushResendRecordsToCloudflare, saveResendConfig } from "../lib/resend-mail";

const router = Router();

router.post("/admin/resend-email/setup-domain", requireAdmin, async (req, res): Promise<void> => {
  const cfg = await getResendConfig();
  if (!cfg) {
    res.status(503).json({ error: "Set a Resend API key first — Admin → Plugins → Resend Email, or RESEND_API_KEY env var." });
    return;
  }
  const domain = (req.body?.domain as string)?.trim().toLowerCase() || cfg.domain;

  try {
    let resendDomain = await ensureResendDomain({ ...cfg, domain });
    const push = await pushResendRecordsToCloudflare(resendDomain.records);

    // Give Cloudflare a moment to propagate before asking Resend to check —
    // this is best-effort; if it's still pending, the person can just call
    // GET /admin/resend-email/status again in a minute.
    if (push.pushed > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      resendDomain = await verifyResendDomain(cfg, resendDomain.id);
    }

    if (resendDomain.status === "verified") {
      await saveResendConfig({ domain, domainId: resendDomain.id });
    }

    res.json({
      domain: resendDomain.name,
      status: resendDomain.status,
      records: resendDomain.records,
      cloudflare: push.cloudflareConnected
        ? { autoConfigured: true, recordsPushed: push.pushed, failed: push.failed }
        : { autoConfigured: false, message: "Cloudflare Email plugin isn't configured — add these DNS records to ayzen.tech manually, then call this endpoint again to re-verify." },
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Resend domain setup failed" });
  }
});

router.get("/admin/resend-email/status", requireAdmin, async (_req, res): Promise<void> => {
  const cfg = await getResendConfig();
  if (!cfg) { res.status(503).json({ error: "Resend Email isn't configured" }); return; }
  if (!cfg.domainId) { res.json({ configured: true, domainSetupDone: false }); return; }

  try {
    const domain = await getResendDomain(cfg, cfg.domainId);
    res.json({ configured: true, domainSetupDone: true, domain: domain.name, status: domain.status, records: domain.records });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Could not fetch Resend domain status" });
  }
});

export default router;
