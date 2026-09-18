import { Router } from "express";
import { db, pluginsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "../middlewares/auth";

const router = Router();

const DEFAULT_PLUGINS = [
  { slug: "projects",      name: "Projects",          enabled: true },
  { slug: "tasks",         name: "Tasks",             enabled: true },
  { slug: "vault",         name: "Vault",             enabled: true },
  { slug: "wallets",       name: "Wallets",           enabled: true },
  { slug: "email-manager", name: "Email Manager",     enabled: true },
  { slug: "ayzen-email",   name: "AYZEN Email",       enabled: true },
  { slug: "resend-email",  name: "Resend Email",      enabled: true },
  { slug: "authenticator", name: "2FA Authenticator", enabled: true },
  { slug: "leaderboard",   name: "Leaderboard",       enabled: true },
  { slug: "referrals",     name: "Referrals",         enabled: true },
  { slug: "support",       name: "Support",           enabled: true },
  { slug: "broadcast",     name: "Broadcast",         enabled: true },
  { slug: "telegram",      name: "Telegram Bot",      enabled: false },
  { slug: "firebase",      name: "Firebase Auth",     enabled: false },
  { slug: "smtp",          name: "SMTP Email",        enabled: false },
];

async function ensureDefaults() {
  const existing = await db.select().from(pluginsTable);
  const existingSlugs = new Set(existing.map(p => p.slug));
  const toInsert = DEFAULT_PLUGINS.filter(p => !existingSlugs.has(p.slug));
  if (toInsert.length > 0) {
    await db.insert(pluginsTable).values(toInsert);
  }
  return [...existing, ...toInsert.map((p, i) => ({ ...p, id: -i, config: null, updatedAt: new Date() }))];
}

// D4 (Season D): both routes below had no auth at all — any unauthenticated
// caller could list the plugin catalog (GET) and, worse, flip any plugin's
// enabled/config state platform-wide (PATCH), including disabling
// "authenticator" (2FA) or "smtp"/email plugins. Neither route has an
// `:id`-shaped param routed through the ownership lint (GET has no param at
// all; PATCH's `:slug` isn't a per-user resource), so C33's script never
// flagged them — found via D4's file-by-file long-tail triage instead, same
// class of gap as C34's body-id bug. `requireAdmin` added to both, matching
// every other `/admin/...` route in this codebase (see ad-tasks.ts,
// reward-links.ts, etc.) — this is platform-wide config, not a per-user
// resource, so role-gating (not `requireOwnership()`) is the correct fix.
router.get("/admin/plugins", requireAdmin, async (_req, res): Promise<void> => {
  const all = await ensureDefaults();
  const fresh = await db.select().from(pluginsTable);
  res.json(fresh);
});

router.patch("/admin/plugins/:slug", requireAdmin, async (req, res): Promise<void> => {
  const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
  const { enabled, config } = req.body;
  await ensureDefaults();

  const existing = await db.select().from(pluginsTable).where(eq(pluginsTable.slug, slug));
  if (existing.length === 0) {
    res.status(404).json({ error: "Plugin not found" });
    return;
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (enabled !== undefined) updates.enabled = Boolean(enabled);
  if (config !== undefined) updates.config = typeof config === "string" ? config : JSON.stringify(config);

  const [updated] = await db.update(pluginsTable).set(updates).where(eq(pluginsTable.slug, slug)).returning();
  res.json(updated);
});

export default router;
