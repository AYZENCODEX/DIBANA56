import { Router, type Request, type Response, type NextFunction } from "express";
import { db, devNavItemsTable, NAV_TYPES, type NavType } from "@workspace/db";
import { eq, asc, and } from "drizzle-orm";
import { requireDev } from "../middlewares/auth";
import { NAV_SEEDS, type SeedGroup, type SeedEntry } from "./nav-seeds.generated";

const router = Router();

// ── navType validation ─────────────────────────────────────────────────────
function isNavType(v: string): v is NavType {
  return (NAV_TYPES as readonly string[]).includes(v);
}

function requireValidNavType(req: Request, res: Response, next: NextFunction): void {
  const navType = Array.isArray(req.params.navType) ? req.params.navType[0] : req.params.navType;
  if (!isNavType(navType)) {
    res.status(400).json({ error: `Invalid navType. Must be one of: ${NAV_TYPES.join(", ")}` });
    return;
  }
  next();
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "") || "item";
}

// Legacy Dev sidebar used /dev/custom/:slug for auto-generated blank pages;
// other roles get an analogous namespace under their own route prefix.
function customHrefPrefix(navType: NavType): string {
  if (navType === "dev") return "/dev/custom";
  if (navType === "admin") return "/admin/custom";
  return `/${navType}/custom`;
}

// ── seeding ─────────────────────────────────────────────────────────────────
// Mirrors the previous hardcoded nav arrays so the first load per navType is
// non-destructive — every existing link keeps working, just now editable
// from the builder UI. Runs once per navType (no-op once any row exists).
// Inserts one SeedEntry (leaf or section) under parentId at the given level,
// recursing into `children` for as many levels as the seed data nests —
// needed by Protocols' Exchange group, which nests a platform section
// (Binance/Bitget/Kucoin/Bybit) inside the Exchange section (level 4 under
// level 3 under level 2 under the level-1 group). Caps at level 5 to match
// the /admin/nav write-path's own limit.
async function insertSeedEntry(
  navType: NavType, parentId: number, level: number, entry: SeedEntry, sortOrder: number,
): Promise<void> {
  if (level > 5) return;
  if ("children" in entry) {
    const [section] = await db.insert(devNavItemsTable).values({
      navType, parentId, level, label: entry.label, icon: entry.icon,
      href: null, sortOrder, isSeed: true,
    }).returning();
    for (let j = 0; j < entry.children.length; j++) {
      await insertSeedEntry(navType, section.id, level + 1, entry.children[j], j);
    }
  } else {
    await db.insert(devNavItemsTable).values({
      navType, parentId, level, label: entry.label, icon: entry.icon,
      href: entry.href, pluginSlug: entry.pluginSlug ?? null, sortOrder, isSeed: true,
    });
  }
}

async function ensureSeeded(navType: NavType): Promise<void> {
  const existing = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.navType, navType));
  if (existing.length > 0) return;

  const seedGroups: SeedGroup[] = NAV_SEEDS[navType] ?? [];
  if (seedGroups.length === 0) return;

  for (let g = 0; g < seedGroups.length; g++) {
    const group = seedGroups[g];
    const [parent] = await db.insert(devNavItemsTable).values({
      navType, level: 1, label: group.label, icon: group.icon, href: null,
      sortOrder: g, isSeed: true,
    }).returning();

    for (let i = 0; i < group.items.length; i++) {
      await insertSeedEntry(navType, parent.id, 2, group.items[i], i);
    }
  }
}

// Dev-only backfills that shipped after Dev_nav's initial seed was already
// rolled out to existing installs (can't live in NAV_SEEDS.dev — ensureSeeded
// only runs on a completely empty navType). No-op once already present.
async function ensureDevBackfills(): Promise<void> {
  // Layout Builder / Theme Studio / Sidebar Builder now live in the pinned
  // "Appearance" group rendered client-side in app-sidebar.tsx (always
  // visible, so a dev can never lock themselves out of these tools by
  // disabling/deleting a DB nav row). Any leftover DB rows for these three
  // — from the old "Appearance" backfill or the old "Config" seed — would
  // just show up as duplicates, so this removes them once; a no-op forever
  // after on a clean install.
  const pinnedHrefs = ["/admin/theme-studio", "/admin/layout-builder", "/admin/dev-nav-builder"];
  const devRows = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.navType, "dev"));
  for (const row of devRows) {
    if (row.href && pinnedHrefs.includes(row.href)) {
      await db.delete(devNavItemsTable).where(eq(devNavItemsTable.id, row.id));
    }
  }

  const mcpAlready = await db.select().from(devNavItemsTable)
    .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.label, "MCP Agents")));
  if (mcpAlready.length === 0) {
    const topLevel = await db.select().from(devNavItemsTable)
      .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.level, 1)));
    const [group] = await db.insert(devNavItemsTable).values({
      navType: "dev", level: 1, label: "MCP Agents", icon: "Bot", href: null,
      sortOrder: topLevel.length, isSeed: true,
    }).returning();
    const items = [
      { href: "/admin/mcp-agents?tab=agents", label: "Agent Types", icon: "Bot" },
      { href: "/admin/mcp-agents?tab=skills", label: "Skills", icon: "Puzzle" },
      { href: "/admin/mcp-agents?tab=providers", label: "Providers / Router", icon: "Router" },
      { href: "/admin/mcp-agents?tab=console", label: "Console", icon: "Terminal" },
    ];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await db.insert(devNavItemsTable).values({
        navType: "dev", parentId: group.id, level: 2, label: item.label, icon: item.icon,
        href: item.href, sortOrder: i, isSeed: true,
      });
    }
  }

  // ── Marketplace admin group (Market Categories UI) ─────────────────────
  const marketAlready = await db.select().from(devNavItemsTable)
    .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.href, "/admin/marketplace-categories")));
  if (marketAlready.length === 0) {
    let [group] = await db.select().from(devNavItemsTable)
      .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.label, "Marketplace")));
    if (!group) {
      const topLevel = await db.select().from(devNavItemsTable)
        .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.level, 1)));
      [group] = await db.insert(devNavItemsTable).values({
        navType: "dev", level: 1, label: "Marketplace", icon: "Store", href: null,
        sortOrder: topLevel.length, isSeed: true,
      }).returning();
    }
    const siblings = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.parentId, group.id));
    await db.insert(devNavItemsTable).values({
      navType: "dev", parentId: group.id, level: 2, label: "Market Categories", icon: "Boxes",
      href: "/admin/marketplace-categories", sortOrder: siblings.length, isSeed: true,
    });
  }

  // ── Marketplace admin group (Market Settings — Vault/Game fee % + open switch) ──
  const marketConfigAlready = await db.select().from(devNavItemsTable)
    .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.href, "/admin/marketplace-market-config")));
  if (marketConfigAlready.length === 0) {
    let [group] = await db.select().from(devNavItemsTable)
      .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.label, "Marketplace")));
    if (!group) {
      const topLevel = await db.select().from(devNavItemsTable)
        .where(and(eq(devNavItemsTable.navType, "dev"), eq(devNavItemsTable.level, 1)));
      [group] = await db.insert(devNavItemsTable).values({
        navType: "dev", level: 1, label: "Marketplace", icon: "Store", href: null,
        sortOrder: topLevel.length, isSeed: true,
      }).returning();
    }
    const siblings = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.parentId, group.id));
    await db.insert(devNavItemsTable).values({
      navType: "dev", parentId: group.id, level: 2, label: "Market Settings", icon: "Settings2",
      href: "/admin/marketplace-market-config", sortOrder: siblings.length, isSeed: true,
    });
  }
}

// One-time migration for installs that already seeded the "user" navType
// before the Protocols restructure (ensureSeeded is a no-op once any row
// exists, so those installs would otherwise keep the old broken hierarchy
// forever). Detects the old shape — a level-2 "Protocol" (singular) leaf, or
// any of the old flat exchange-type hrefs like binance-new/binance-old —
// deletes just that Protocols subtree, and reinserts the current
// NAV_SEEDS.user Protocols group in its place. Any items an admin
// hand-added under the old Protocols group (isSeed: false) are preserved by
// re-parenting them onto the new Protocols group's id. No-op once the
// install is already on the new shape.
async function ensureUserProtocolsRestructure(): Promise<void> {
  const rows = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.navType, "user"));
  const oldProtocols = rows.find(r =>
    r.level === 1 && r.label === "Protocols" &&
    rows.some(c => c.parentId === r.id && (
      c.label === "Protocol" ||
      (c.href ?? "").includes("type=binance-new") ||
      (c.href ?? "").includes("type=binance-booster")
    )),
  );
  if (!oldProtocols) return;

  const newSeed = (NAV_SEEDS["user"] ?? []).find(g => g.label === "Protocols");
  if (!newSeed) return;

  // Re-parent any admin-added (non-seed) rows under the old group onto the
  // group itself instead of deleting them.
  const directChildren = rows.filter(r => r.parentId === oldProtocols.id);
  for (const child of directChildren) {
    if (!child.isSeed) {
      await db.update(devNavItemsTable).set({ parentId: null }).where(eq(devNavItemsTable.id, child.id));
    }
  }
  await deleteDescendants("user", oldProtocols.id);
  await db.delete(devNavItemsTable).where(eq(devNavItemsTable.id, oldProtocols.id));

  const [freshGroup] = await db.insert(devNavItemsTable).values({
    navType: "user", level: 1, label: newSeed.label, icon: newSeed.icon, href: null,
    sortOrder: oldProtocols.sortOrder, isSeed: true,
  }).returning();
  for (let i = 0; i < newSeed.items.length; i++) {
    await insertSeedEntry("user", freshGroup.id, 2, newSeed.items[i], i);
  }
}

// One-time migration, mirroring ensureUserProtocolsRestructure below, for
// installs that seeded "user"/"moderator"/"team_leader" before the Vault
// sidebar restructure (Phase 4) shipped. Back then the seed either had no
// standalone "Vault" group at all, or had one whose children were still the
// old flat per-tab links (/vault?tab=entity, ?tab=2fa, ...) instead of a
// single "/vault" leaf — so there was nothing in the sidebar a user could
// click that actually opened the current Vault page (with its own
// hierarchy sidebar). ensureSeeded() only runs once per navType, so those
// installs would otherwise be stuck on the broken shape forever. Detects a
// level-1 "Vault" group missing a direct "/vault" child, deletes just that
// subtree (re-parenting any admin-added, non-seed children instead of
// dropping them), and reinserts the current NAV_SEEDS[navType] Vault group
// in its place. No-op once the install already has a working "/vault" link.
async function ensureVaultGroupRestructure(navType: NavType): Promise<void> {
  const newSeed = (NAV_SEEDS[navType] ?? []).find(g => g.label === "Vault");
  if (!newSeed) return;

  const rows = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.navType, navType));
  const vaultGroup = rows.find(r => r.level === 1 && r.label === "Vault");

  // Group already has a working "/vault" link — nothing to do.
  if (vaultGroup && rows.some(c => c.parentId === vaultGroup.id && c.href === "/vault")) return;

  if (vaultGroup) {
    const directChildren = rows.filter(r => r.parentId === vaultGroup.id);
    for (const child of directChildren) {
      if (!child.isSeed) {
        await db.update(devNavItemsTable).set({ parentId: null }).where(eq(devNavItemsTable.id, child.id));
      }
    }
    await deleteDescendants(navType, vaultGroup.id);
    await db.delete(devNavItemsTable).where(eq(devNavItemsTable.id, vaultGroup.id));
  }

  const topLevel = await db.select().from(devNavItemsTable)
    .where(and(eq(devNavItemsTable.navType, navType), eq(devNavItemsTable.level, 1)));
  const [freshGroup] = await db.insert(devNavItemsTable).values({
    navType, level: 1, label: newSeed.label, icon: newSeed.icon, href: null,
    sortOrder: vaultGroup?.sortOrder ?? topLevel.length, isSeed: true,
  }).returning();
  for (let i = 0; i < newSeed.items.length; i++) {
    await insertSeedEntry(navType, freshGroup.id, 2, newSeed.items[i], i);
  }
}

// Companion migration for the "Vault Market" entry that used to live nested
// under the "Market" group with the same stale /vault?tab=X children —
// collapses it down to the current flat "/marketplace/vault" leaf. No-op
// once already flat.
async function ensureVaultMarketRestructure(navType: NavType): Promise<void> {
  const rows = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.navType, navType));
  const marketGroup = rows.find(r => r.level === 1 && r.label === "Market");
  if (!marketGroup) return;
  const vaultMarket = rows.find(r => r.parentId === marketGroup.id && r.label === "Vault Market");
  if (!vaultMarket) return;
  const hasChildren = rows.some(r => r.parentId === vaultMarket.id);
  if (!hasChildren) return; // already the flat shape

  const grandchildren = rows.filter(r => r.parentId === vaultMarket.id);
  for (const gc of grandchildren) {
    if (!gc.isSeed) {
      await db.update(devNavItemsTable).set({ parentId: null }).where(eq(devNavItemsTable.id, gc.id));
    }
  }
  await deleteDescendants(navType, vaultMarket.id);
  await db.update(devNavItemsTable)
    .set({ href: "/marketplace/vault", pluginSlug: "vault" })
    .where(eq(devNavItemsTable.id, vaultMarket.id));
}

async function uniqueHref(navType: NavType, label: string): Promise<string> {
  const base = `${customHrefPrefix(navType)}/${slugify(label)}`;
  const all = await db.select().from(devNavItemsTable).where(eq(devNavItemsTable.navType, navType));
  const taken = new Set(all.map(r => r.href));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ── GET /admin/nav/:navType — flat list (client assembles the tree) ────────
router.get("/admin/nav/:navType", requireDev, requireValidNavType, async (req, res): Promise<void> => {
  const navType = req.params.navType as NavType;
  await ensureSeeded(navType);
  if (navType === "dev") await ensureDevBackfills();
  if (navType === "user") await ensureUserProtocolsRestructure();
  if (navType === "user" || navType === "moderator" || navType === "team_leader") {
    await ensureVaultGroupRestructure(navType);
    await ensureVaultMarketRestructure(navType);
  }
  const rows = await db.select().from(devNavItemsTable)
    .where(eq(devNavItemsTable.navType, navType))
    .orderBy(asc(devNavItemsTable.level), asc(devNavItemsTable.sortOrder));
  res.json(rows);
});

// ── GET /admin/nav/:navType/by-href — resolve a page's nav item ────────────
router.get("/admin/nav/:navType/by-href", requireDev, requireValidNavType, async (req, res): Promise<void> => {
  const navType = req.params.navType as NavType;
  const href = String(req.query.href || "");
  if (!href) { res.status(400).json({ error: "href is required" }); return; }
  const rows = await db.select().from(devNavItemsTable)
    .where(and(eq(devNavItemsTable.navType, navType), eq(devNavItemsTable.href, href)));
  if (!rows.length) { res.status(404).json({ error: "Not found" }); return; }
  res.json(rows[0]);
});

// ── POST /admin/nav/:navType — add a category / section / sub-item ─────────
router.post("/admin/nav/:navType", requireDev, requireValidNavType, async (req, res): Promise<void> => {
  const navType = req.params.navType as NavType;
  const { parentId, label, icon, href, level } = req.body as {
    parentId?: number; label?: string; icon?: string; href?: string; level?: number;
  };
  if (!label || !String(label).trim()) { res.status(400).json({ error: "label is required" }); return; }

  let resolvedLevel = level;
  if (!resolvedLevel) resolvedLevel = parentId ? 2 : 1;
  if (resolvedLevel > 5) { res.status(400).json({ error: "Sidebar supports up to 5 levels" }); return; }

  if (parentId) {
    const [parent] = await db.select().from(devNavItemsTable)
      .where(and(eq(devNavItemsTable.id, Number(parentId)), eq(devNavItemsTable.navType, navType)));
    if (!parent) { res.status(404).json({ error: "Parent not found" }); return; }
    if (parent.level >= 5) { res.status(400).json({ error: "Sidebar supports up to 5 levels" }); return; }
    resolvedLevel = parent.level + 1;
  }

  // Blank page: any item created without an explicit href gets one auto-assigned,
  // so it "just works" the moment it's added — like a prebuilt plugin route.
  const finalHref = href && href.trim() ? href.trim() : await uniqueHref(navType, label);

  const siblings = await db.select().from(devNavItemsTable)
    .where(and(
      eq(devNavItemsTable.navType, navType),
      parentId ? eq(devNavItemsTable.parentId, Number(parentId)) : eq(devNavItemsTable.level, 1),
    ));
  const nextOrder = siblings.length;

  const [created] = await db.insert(devNavItemsTable).values({
    navType,
    parentId: parentId ? Number(parentId) : null,
    level: resolvedLevel,
    label: label.trim(),
    icon: icon && icon.trim() ? icon.trim() : "Circle",
    href: finalHref,
    sortOrder: nextOrder,
    isSeed: false,
  }).returning();

  res.status(201).json(created);
});

// ── PATCH /admin/nav/:navType/:id — edit / enable-disable / reorder ────────
router.patch("/admin/nav/:navType/:id", requireDev, requireValidNavType, async (req, res): Promise<void> => {
  const navType = req.params.navType as NavType;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  const { label, icon, href, enabled, sortOrder, content } = req.body as {
    label?: string; icon?: string; href?: string; enabled?: boolean; sortOrder?: number; content?: string;
  };

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (label !== undefined && label.trim()) updates.label = label.trim();
  if (icon !== undefined && icon.trim()) updates.icon = icon.trim();
  if (href !== undefined) updates.href = href.trim() ? href.trim() : null;
  if (enabled !== undefined) updates.enabled = Boolean(enabled);
  if (sortOrder !== undefined) updates.sortOrder = Number(sortOrder);
  // Page body for the WordPress-style builder (custom-page.tsx). Empty
  // string clears back to the "not wired up yet" placeholder.
  if (content !== undefined) updates.content = content.trim() ? content : null;

  const [updated] = await db.update(devNavItemsTable).set(updates)
    .where(and(eq(devNavItemsTable.id, id), eq(devNavItemsTable.navType, navType)))
    .returning();
  if (!updated) { res.status(404).json({ error: "Not found" }); return; }
  res.json(updated);
});

// ── DELETE /admin/nav/:navType/:id — remove item + all descendants at any depth ─
async function deleteDescendants(navType: NavType, parentId: number): Promise<void> {
  const children = await db.select().from(devNavItemsTable)
    .where(and(eq(devNavItemsTable.parentId, parentId), eq(devNavItemsTable.navType, navType)));
  for (const child of children) {
    await deleteDescendants(navType, child.id); // depth-first — clears levels below before removing this one
    await db.delete(devNavItemsTable)
      .where(and(eq(devNavItemsTable.id, child.id), eq(devNavItemsTable.navType, navType)));
  }
}

router.delete("/admin/nav/:navType/:id", requireDev, requireValidNavType, async (req, res): Promise<void> => {
  const navType = req.params.navType as NavType;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);

  await deleteDescendants(navType, id);
  await db.delete(devNavItemsTable).where(and(eq(devNavItemsTable.id, id), eq(devNavItemsTable.navType, navType)));

  res.json({ ok: true });
});

export default router;
