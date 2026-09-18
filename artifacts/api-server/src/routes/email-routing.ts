import { Router } from "express";
import { db, usersTable, pluginsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getUserIdAsync } from "../lib/auth-utils";
import { logger } from "../lib/logger";

const router = Router();

const CF_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_DOMAIN = "ayzen.tech";

interface CfConfig {
  apiKey: string;
  zoneId: string | null; // optional override from admin config, skips the zone lookup call
  domain: string;
}

/**
 * Reads Cloudflare credentials from the admin "Cloudflare Email" plugin
 * (Admin → Plugins → Cloudflare Email, saved via PATCH /admin/plugins/cloudflare-email
 * as JSON in plugins.config — see routes/plugins.ts), falling back to the
 * CLOUDFLARE_API_KEY env var for older deployments that only set that.
 *
 * BUG FIX: previously this route only ever read process.env.CLOUDFLARE_API_KEY
 * and a hardcoded "ayzen.tech" domain, completely ignoring whatever the admin
 * configured on the Plugins page — so filling in the Cloudflare Email plugin
 * form did nothing and the feature looked "broken" even when Cloudflare was
 * genuinely set up.
 */
async function getCfConfig(): Promise<CfConfig | null> {
  let apiKey: string | null = null;
  let zoneId: string | null = null;
  let domain = DEFAULT_DOMAIN;

  try {
    const [row] = await db.select().from(pluginsTable).where(eq(pluginsTable.slug, "cloudflare-email"));
    if (row?.config) {
      const cfg = JSON.parse(row.config) as Record<string, string>;
      if (cfg.apiKey?.trim()) apiKey = cfg.apiKey.trim();
      if (cfg.zoneId?.trim()) zoneId = cfg.zoneId.trim();
      if (cfg.domain?.trim()) domain = cfg.domain.trim().toLowerCase();
    }
  } catch (err) {
    logger.warn({ err }, "Failed to parse cloudflare-email plugin config, falling back to env");
  }

  if (!apiKey) apiKey = process.env.CLOUDFLARE_API_KEY || process.env.cloudflare_api_key || null;
  if (!apiKey) return null;

  return { apiKey, zoneId, domain };
}

async function cfFetch(apiKey: string, path: string, opts: RequestInit = {}): Promise<{ ok: boolean; json: any }> {
  const res = await fetch(`${CF_API}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, json };
}

function cfErrorMessage(json: any, fallback: string): string {
  if (Array.isArray(json?.errors) && json.errors.length) {
    return json.errors.map((e: any) => e.message ?? JSON.stringify(e)).join("; ");
  }
  return fallback;
}

/** Resolves the Cloudflare zone id for cfg.domain, using the admin-configured override if present. */
async function resolveZoneId(cfg: CfConfig): Promise<string | null> {
  if (cfg.zoneId) return cfg.zoneId;
  try {
    const { json } = await cfFetch(cfg.apiKey, `/zones?name=${encodeURIComponent(cfg.domain)}&status=active`);
    return json?.result?.[0]?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "Cloudflare zone lookup failed");
    return null;
  }
}

/** Zones belong to an account; destination addresses (verification) are an account-level resource. */
async function resolveAccountId(cfg: CfConfig, zoneId: string): Promise<string | null> {
  try {
    const { ok, json } = await cfFetch(cfg.apiKey, `/zones/${zoneId}`);
    if (!ok) return null;
    return json?.result?.account?.id ?? null;
  } catch (err) {
    logger.warn({ err }, "Cloudflare zone→account lookup failed");
    return null;
  }
}

/** Makes sure Email Routing is actually turned on for the zone (sets up MX/SPF records). Best-effort. */
async function ensureRoutingEnabled(cfg: CfConfig, zoneId: string): Promise<void> {
  try {
    const { json } = await cfFetch(cfg.apiKey, `/zones/${zoneId}/email/routing`);
    if (json?.result?.enabled) return;
    await cfFetch(cfg.apiKey, `/zones/${zoneId}/email/routing/enable`, { method: "POST" });
  } catch (err) {
    logger.warn({ err }, "Could not confirm/enable Cloudflare Email Routing for zone");
  }
}

/**
 * Ensures `email` exists as a Cloudflare destination address and reports whether
 * it's already verified. Destination addresses are account-scoped (shared across
 * every domain on the account) and, per Cloudflare, "until a destination address
 * is verified, any routing rule that points to it stays disabled" — so a routing
 * rule can be created successfully and still deliver nothing until this is done.
 */
async function ensureDestinationAddress(
  cfg: CfConfig,
  accountId: string,
  email: string,
): Promise<{ verified: boolean; addressId: string | null; warning?: string }> {
  try {
    const { json: listJson } = await cfFetch(cfg.apiKey, `/accounts/${accountId}/email/routing/addresses`);
    const existing = (listJson?.result ?? []).find(
      (a: any) => typeof a.email === "string" && a.email.toLowerCase() === email.toLowerCase(),
    );
    if (existing) {
      return { verified: !!existing.verified, addressId: existing.id ?? null };
    }

    const { ok, json: createJson } = await cfFetch(cfg.apiKey, `/accounts/${accountId}/email/routing/addresses`, {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    if (!ok || createJson?.success === false) {
      return { verified: false, addressId: null, warning: cfErrorMessage(createJson, "Could not register destination address with Cloudflare") };
    }
    return { verified: !!createJson?.result?.verified, addressId: createJson?.result?.id ?? null };
  } catch (err: any) {
    return { verified: false, addressId: null, warning: err?.message ?? "Cloudflare destination address check failed" };
  }
}

// Check if Cloudflare email routing is enabled/reachable, and live-refresh this
// user's verification state if they already have a pending address.
router.get("/ayzen-email/status", async (req, res): Promise<void> => {
  const userId = await getUserIdAsync(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  const cfg = await getCfConfig();
  const zoneId = cfg ? await resolveZoneId(cfg) : null;

  let verified = user.ayzenEmailVerified ?? false;
  if (user.ayzenEmail && !verified && cfg && zoneId && user.ayzenEmailCfAddressId) {
    // Address was pending verification — check Cloudflare in real time in case
    // the user has since clicked the verification link in their inbox.
    const accountId = await resolveAccountId(cfg, zoneId);
    if (accountId) {
      try {
        const { ok, json } = await cfFetch(cfg.apiKey, `/accounts/${accountId}/email/routing/addresses/${user.ayzenEmailCfAddressId}`);
        if (ok && json?.result?.verified) {
          verified = true;
          await db.update(usersTable).set({ ayzenEmailVerified: true }).where(eq(usersTable.id, userId));
        }
      } catch (err) {
        logger.warn({ err }, "Cloudflare destination address recheck failed");
      }
    }
  }

  res.json({
    ayzenEmail: user.ayzenEmail ?? null,
    ayzenEmailVerified: verified,
    forwardTo: user.ayzenEmailForwardTo ?? null,
    domain: cfg?.domain ?? DEFAULT_DOMAIN,
    cfConfigured: !!cfg,
    zoneFound: !!zoneId,
    mode: user.ayzenEmailMode ?? "forward",
    // Native mailbox compose signature — see
    // routes/ayzen-mailbox.ts GET/PATCH /ayzen-email/mailbox/signature for
    // the dedicated endpoints; included here too so the mailbox page's
    // existing status fetch can pick it up without a second round-trip.
    mailboxSignature: user.ayzenMailboxSignature ?? "",
    mailboxSignatureEnabled: user.ayzenMailboxSignatureEnabled,
  });
});

// Check if a username is available
router.get("/ayzen-email/check/:username", async (req, res): Promise<void> => {
  const cfg = await getCfConfig();
  const domain = cfg?.domain ?? DEFAULT_DOMAIN;
  const { username } = req.params;
  const clean = (Array.isArray(username) ? username[0] : username).toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!clean || clean.length < 3 || clean.length > 30) {
    res.json({ available: false, reason: "Username must be 3-30 chars, letters/numbers/dots/dashes only" });
    return;
  }
  const existing = await db.select().from(usersTable).where(eq(usersTable.ayzenEmail, `${clean}@${domain}`));
  res.json({ available: existing.length === 0, username: clean, email: `${clean}@${domain}` });
});

// Claim a username@<domain> address — real-time Cloudflare call, hard failure
// (nothing saved) if Cloudflare can't actually create/route it.
router.post("/ayzen-email/claim", async (req, res): Promise<void> => {
  const userId = await getUserIdAsync(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.ayzenEmail) { res.status(409).json({ error: "You already have an AYZEN email address", ayzenEmail: user.ayzenEmail }); return; }

  const { username, forwardTo } = req.body;
  if (!username || !forwardTo) { res.status(400).json({ error: "username and forwardTo are required" }); return; }

  const clean = String(username).toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!clean || clean.length < 3 || clean.length > 30) {
    res.status(400).json({ error: "Invalid username format" }); return;
  }
  const forwardEmail = String(forwardTo).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(forwardEmail)) {
    res.status(400).json({ error: "forwardTo must be a valid email address" }); return;
  }

  // Cloudflare must be reachable and actually confirm the address — no more
  // "save it anyway and hope it works" soft-failure path.
  const cfg = await getCfConfig();
  if (!cfg) {
    res.status(503).json({ error: "Cloudflare Email isn't configured yet. Ask an admin to set the API key in Admin → Plugins → Cloudflare Email." });
    return;
  }

  const zoneId = await resolveZoneId(cfg);
  if (!zoneId) {
    res.status(503).json({ error: `Cloudflare zone for ${cfg.domain} wasn't found or isn't active. Check the domain is added to this Cloudflare account and try again.` });
    return;
  }

  const ayzenEmail = `${clean}@${cfg.domain}`;
  const existing = await db.select().from(usersTable).where(eq(usersTable.ayzenEmail, ayzenEmail));
  if (existing.length > 0) { res.status(409).json({ error: "Username already taken" }); return; }

  await ensureRoutingEnabled(cfg, zoneId);

  // Destination address must exist & (eventually) be verified, or Cloudflare
  // will silently keep the rule disabled and no mail will ever be delivered.
  const accountId = await resolveAccountId(cfg, zoneId);
  let addressVerified = false;
  let addressId: string | null = null;
  let addressWarning: string | undefined;
  if (accountId) {
    const addr = await ensureDestinationAddress(cfg, accountId, forwardEmail);
    addressVerified = addr.verified;
    addressId = addr.addressId;
    addressWarning = addr.warning;
  } else {
    addressWarning = "Couldn't confirm the Cloudflare account for this zone — verify the API token has Account-level Email Routing Addresses permission.";
  }

  const { ok, json: cfRes } = await cfFetch(cfg.apiKey, `/zones/${zoneId}/email/routing/rules`, {
    method: "POST",
    body: JSON.stringify({
      name: `AYZEN: ${ayzenEmail}`,
      enabled: true,
      matchers: [{ type: "literal", field: "to", value: ayzenEmail }],
      actions: [{ type: "forward", value: [forwardEmail] }],
    }),
  });

  if (!ok || cfRes?.success === false) {
    res.status(502).json({
      error: `Cloudflare rejected the routing rule: ${cfErrorMessage(cfRes, "unknown error")}. Nothing was claimed — fix the issue and try again.`,
    });
    return;
  }

  // Only now — confirmed by a real Cloudflare response — do we persist the claim.
  await db.update(usersTable).set({
    ayzenEmail,
    ayzenEmailMode: "forward", // this route is forward-only — see routes/ayzen-mailbox.ts's claim-native for the stored-inbox alternative
    ayzenEmailForwardTo: forwardEmail,
    ayzenEmailVerified: addressVerified,
    ayzenEmailCfRuleId: cfRes.result?.id ?? null,
    ayzenEmailCfAddressId: addressId,
  }).where(eq(usersTable.id, userId));

  res.status(201).json({
    ayzenEmail,
    forwardTo: forwardEmail,
    verified: addressVerified,
    message: addressVerified
      ? `${ayzenEmail} has been claimed and verified on Cloudflare — mail will forward now.`
      : `${ayzenEmail} has been claimed. Cloudflare sent a verification email to ${forwardEmail} — mail won't forward until that link is clicked.`,
    ...(addressWarning ? { warning: addressWarning } : {}),
  });
});

// Release/unclaim AYZEN email — also tears down the Cloudflare routing rule.
router.delete("/ayzen-email", async (req, res): Promise<void> => {
  const userId = await getUserIdAsync(req);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || !user.ayzenEmail) { res.status(404).json({ error: "No AYZEN email to release" }); return; }

  const cfg = await getCfConfig();
  if (cfg && user.ayzenEmailCfRuleId) {
    try {
      const zoneId = await resolveZoneId(cfg);
      if (zoneId) await cfFetch(cfg.apiKey, `/zones/${zoneId}/email/routing/rules/${user.ayzenEmailCfRuleId}`, { method: "DELETE" });
    } catch (err) {
      // Best-effort — the address should always be releasable in AYZEN even if
      // Cloudflare is unreachable; a stray disabled rule on Cloudflare's side
      // is harmless since the username row is freed up immediately below.
      logger.warn({ err }, "Failed to delete Cloudflare routing rule on release");
    }
  }

  await db.update(usersTable).set({
    ayzenEmail: null,
    ayzenEmailMode: "forward",
    ayzenEmailVerified: false,
    ayzenEmailForwardTo: null,
    ayzenEmailCfRuleId: null,
    ayzenEmailCfAddressId: null,
  }).where(eq(usersTable.id, userId));
  res.json({ message: "AYZEN email released" });
});

export default router;
