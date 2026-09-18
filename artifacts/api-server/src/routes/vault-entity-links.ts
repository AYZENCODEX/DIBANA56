import { Router, type Request, type Response } from "express";
import { db, vaultEntriesTable, vaultEntityLinksTable } from "@workspace/db";
import { eq, and, or, inArray, sql } from "drizzle-orm";
import { requireAuth, pepDecisionObserver } from "../middlewares/auth";
import { requireOwnership } from "../lib/policy/pep/middleware";
import type { ResourceRefBuilder } from "../lib/policy/pep/types";

const router = Router();

// ─── Route Integration Roadmap — Season C, Phase C8 (mechanical sweep, batch 8) ─
// One of the files Phase C7 flagged as a remaining candidate from its own
// "combined-where" audit. Two different resource shapes live in this file:
//   - `GET /vault/:id/links` scopes by a *vault entry* id (`ownsEntity()`,
//     already `and(eq(vaultEntriesTable.id, id), eq(vaultEntriesTable.userId, userId))`)
//   - `PATCH`/`DELETE /vault-entity-links/:id` scope by the *link* row's own
//     id (`and(eq(vaultEntityLinksTable.id, id), eq(vaultEntityLinksTable.userId, userId))`)
// Both get their own ResourceRefBuilder below, same as every other file in
// this series — existing scoping/response bodies are unchanged (Rule:
// don't remove a working system), this only adds the same second,
// PDP-routed ownership check Phase B1/C1-C7 already add elsewhere.
//
// NOT touched: `POST /vault-entity-links` (checks ownership of TWO
// entities — `entityId` and `linkedEntityId` — from the request body, not
// a route `:id` param; the same shape Phase C7 excluded for
// `email-accounts.ts`'s `POST /email-accounts/test-config`, for the same
// reason: this phase's `ResourceRefBuilder` is `req.params.id`-shaped and
// doesn't fit a body-based dual-ownership check without separate wiring).
// `GET /vault/links/all` is a list route (no `:id`), excluded like every
// other list/create shape in this series.
const VAULT_ENTRY_OWNER_SENTINEL_NONE = -1;
const VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE = -1;

// Exported (C21) — same table/owner shape (`vault_entries.user_id`) that
// entities.ts and value-history.ts's vault routes need for their own
// long-overdue ownership gate; reused as-is here instead of a second copy
// (kyc.ts/exchange-api.ts, C19B, established the same "export over
// duplicate builder" precedent). Only the ref-builder is exported — the
// `requireVaultEntryOwnership()` wrapper below stays local to this file
// because its `onDeny` is hardcoded to this file's own 404 body; the two
// importing files each define their own thin wrapper so every route keeps
// its own pre-existing deny body (see C21's own CHANGES doc).
export const vaultEntryResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (!Number.isFinite(id)) return { type: "vault_entry", id: req.params.id, ownerId: VAULT_ENTRY_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: vaultEntriesTable.userId }).from(vaultEntriesTable)
    .where(eq(vaultEntriesTable.id, id)).limit(1);
  return { type: "vault_entry", id, ownerId: row?.userId ?? VAULT_ENTRY_OWNER_SENTINEL_NONE };
};

const vaultEntityLinkResource: ResourceRefBuilder = async (req: Request) => {
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) return { type: "vault_entity_link", id: req.params.id, ownerId: VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE };
  const [row] = await db.select({ userId: vaultEntityLinksTable.userId }).from(vaultEntityLinksTable)
    .where(eq(vaultEntityLinksTable.id, id)).limit(1);
  return { type: "vault_entity_link", id, ownerId: row?.userId ?? VAULT_ENTITY_LINK_OWNER_SENTINEL_NONE };
};

function requireVaultEntryOwnership(action: string) {
  return requireOwnership(action, vaultEntryResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Vault entry not found" });
    },
  });
}

function requireVaultEntityLinkOwnership(action: string) {
  return requireOwnership(action, vaultEntityLinkResource, {
    onDecision: pepDecisionObserver,
    onDeny: (_req: Request, res: Response) => {
      res.status(404).json({ error: "Link not found" });
    },
  });
}

/**
 * Vault Entity Relationship Linking.
 *
 * Airdrop farming setups have one main account plus multiple alt accounts —
 * each stored as its own independent vault_entries row, with no structural
 * connection between them. This lets a user explicitly mark that relationship
 * ("this is an alt of X", "shares wallet with Y") without merging or nesting
 * the underlying entities. Powers the "Linked Entities" section + graph view
 * on vault-entity-detail.tsx. See lib/db/src/schema/vault.ts for the table.
 */

export const RELATION_TYPES = [
  "alt_of",        // entityId is an alt account of linkedEntityId (the main)
  "main_of",        // entityId is the main account, linkedEntityId is its alt
  "shares_wallet",   // symmetric — same wallet used across both entities
  "shares_email",    // symmetric — same recovery/linked email
  "shares_ip",       // symmetric — same IP/proxy
  "shares_device",   // symmetric — same device/browser profile
  "same_owner",      // symmetric — different farming identity, same real owner
  "other",
] as const;
type RelationType = (typeof RELATION_TYPES)[number];

function isRelationType(t: unknown): t is RelationType {
  return typeof t === "string" && (RELATION_TYPES as readonly string[]).includes(t);
}

// A relation reads directionally from entityId's point of view. When shown
// from the *other* entity's page, it needs the inverse label.
const INVERSE_RELATION: Record<RelationType, RelationType> = {
  alt_of: "main_of",
  main_of: "alt_of",
  shares_wallet: "shares_wallet",
  shares_email: "shares_email",
  shares_ip: "shares_ip",
  shares_device: "shares_device",
  same_owner: "same_owner",
  other: "other",
};

async function ownsEntity(id: number, userId: number): Promise<Record<string, unknown> | null> {
  const rows = await db.select({
    id: vaultEntriesTable.id,
    projectName: vaultEntriesTable.projectName,
    username: vaultEntriesTable.username,
    category: vaultEntriesTable.category,
    entitySerial: vaultEntriesTable.entitySerial,
    status: vaultEntriesTable.status,
  }).from(vaultEntriesTable).where(and(
    eq(vaultEntriesTable.id, id),
    eq(vaultEntriesTable.userId, userId),
    sql`${vaultEntriesTable.deletedAt} IS NULL`,
  ));
  return (rows[0] as unknown as Record<string, unknown>) ?? null;
}

function labelFor(e: Record<string, unknown> | undefined | null): string {
  if (!e) return "Unknown entity";
  return (e.projectName as string) || (e.username as string) || `Entity #${e.id}`;
}

// ─── GET /vault/:id/links — all links involving this entity, either direction
router.get("/vault/:id/links", requireAuth, requireVaultEntryOwnership("vault_entry.links.read"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid entity id" }); return; }

  const entity = await ownsEntity(id, userId);
  if (!entity) { res.status(404).json({ error: "Vault entry not found" }); return; }

  try {
    const links = await db.select().from(vaultEntityLinksTable).where(
      and(
        eq(vaultEntityLinksTable.userId, userId),
        or(eq(vaultEntityLinksTable.entityId, id), eq(vaultEntityLinksTable.linkedEntityId, id))
      )
    );

    const counterpartIds = Array.from(new Set(
      links.map(l => (l.entityId === id ? l.linkedEntityId : l.entityId))
    ));
    const counterparts = counterpartIds.length
      ? await db.select({
          id: vaultEntriesTable.id,
          projectName: vaultEntriesTable.projectName,
          username: vaultEntriesTable.username,
          category: vaultEntriesTable.category,
          status: vaultEntriesTable.status,
        }).from(vaultEntriesTable).where(and(eq(vaultEntriesTable.userId, userId), inArray(vaultEntriesTable.id, counterpartIds)))
      : [];
    const byId = new Map(counterparts.map(c => [c.id, c]));

    res.json(links.map(l => {
      const isForward = l.entityId === id;
      const counterpartId = isForward ? l.linkedEntityId : l.entityId;
      const counterpart = byId.get(counterpartId);
      return {
        id: l.id,
        relationType: isForward ? l.relationType : INVERSE_RELATION[l.relationType as RelationType] ?? l.relationType,
        note: l.note,
        createdAt: l.createdAt,
        entity: { id, ...entity },
        linkedEntity: counterpart
          ? { id: counterpart.id, projectName: counterpart.projectName, username: counterpart.username, category: counterpart.category, status: counterpart.status, label: labelFor(counterpart) }
          : { id: counterpartId, label: "Deleted entity" },
      };
    }));
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch linked entities", detail: err?.message });
  }
});

// ─── POST /vault-entity-links — create a link between two owned entities ───
// body: { entityId, linkedEntityId, relationType, note? }
router.post("/vault-entity-links", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const entityId = parseInt(req.body.entityId, 10);
  const linkedEntityId = parseInt(req.body.linkedEntityId, 10);
  const { relationType, note } = req.body;

  if (isNaN(entityId) || isNaN(linkedEntityId)) { res.status(400).json({ error: "entityId and linkedEntityId are required" }); return; }
  if (entityId === linkedEntityId) { res.status(400).json({ error: "An entity can't be linked to itself" }); return; }
  if (!isRelationType(relationType)) { res.status(400).json({ error: `relationType must be one of: ${RELATION_TYPES.join(", ")}` }); return; }

  const [entity, linkedEntity] = await Promise.all([ownsEntity(entityId, userId), ownsEntity(linkedEntityId, userId)]);
  if (!entity) { res.status(404).json({ error: "entityId not found or not owned by you" }); return; }
  if (!linkedEntity) { res.status(404).json({ error: "linkedEntityId not found or not owned by you" }); return; }

  try {
    // Duplicate check across both directions, so "A alt_of B" and re-adding
    // "B main_of A" (its inverse) don't create two rows for the same fact.
    const existing = await db.select().from(vaultEntityLinksTable).where(
      and(
        eq(vaultEntityLinksTable.userId, userId),
        or(
          and(eq(vaultEntityLinksTable.entityId, entityId), eq(vaultEntityLinksTable.linkedEntityId, linkedEntityId)),
          and(eq(vaultEntityLinksTable.entityId, linkedEntityId), eq(vaultEntityLinksTable.linkedEntityId, entityId))
        )
      )
    );
    if (existing.some(l => l.relationType === relationType || l.relationType === INVERSE_RELATION[relationType])) {
      res.status(409).json({ error: "This relationship is already linked" });
      return;
    }

    const [row] = await db.insert(vaultEntityLinksTable).values({
      userId, entityId, linkedEntityId, relationType, note: note ? String(note).trim() || null : null,
    }).returning();

    res.status(201).json({
      id: row.id,
      relationType: row.relationType,
      note: row.note,
      createdAt: row.createdAt,
      entity: { id: entityId, ...entity },
      linkedEntity: { id: linkedEntityId, ...linkedEntity, label: labelFor(linkedEntity) },
    });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to create link", detail: err?.message });
  }
});

// ─── PATCH /vault-entity-links/:id — edit relationType/note ────────────────
router.patch("/vault-entity-links/:id", requireAuth, requireVaultEntityLinkOwnership("vault_entity_link.update"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid link id" }); return; }
  const { relationType, note } = req.body;
  if (relationType !== undefined && !isRelationType(relationType)) { res.status(400).json({ error: `relationType must be one of: ${RELATION_TYPES.join(", ")}` }); return; }

  const updates: Partial<typeof vaultEntityLinksTable.$inferInsert> = {};
  if (relationType !== undefined) updates.relationType = relationType;
  if (note !== undefined) updates.note = note ? String(note).trim() || null : null;

  try {
    const [row] = await db.update(vaultEntityLinksTable).set(updates)
      .where(and(eq(vaultEntityLinksTable.id, id), eq(vaultEntityLinksTable.userId, userId)))
      .returning();
    if (!row) { res.status(404).json({ error: "Link not found" }); return; }
    res.json({ id: row.id, relationType: row.relationType, note: row.note, createdAt: row.createdAt });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to update link", detail: err?.message });
  }
});

// ─── DELETE /vault-entity-links/:id — remove a link ────────────────────────
router.delete("/vault-entity-links/:id", requireAuth, requireVaultEntityLinkOwnership("vault_entity_link.delete"), async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid link id" }); return; }
  try {
    const result = await db.delete(vaultEntityLinksTable)
      .where(and(eq(vaultEntityLinksTable.id, id), eq(vaultEntityLinksTable.userId, userId)))
      .returning({ id: vaultEntityLinksTable.id });
    if (!result.length) { res.status(404).json({ error: "Link not found" }); return; }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to delete link", detail: err?.message });
  }
});

// ─── GET /vault/links/all — every link across all of the user's entities ──────
// Returns enriched rows (entity names + categories on both sides) so the
// Enrollment → Linked page can render the full relationship map without N+1.
router.get("/vault/links/all", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.userId;
  try {
    const result = await db.execute(
      // Raw SQL — the Drizzle ORM join API requires declared FKs which this
      // table intentionally omits (see schema comment). Aliases disambiguate
      // the two vault_entries joins.
      sql.raw(`
        SELECT vel.id, vel.entity_id, vel.linked_entity_id, vel.relation_type, vel.note, vel.created_at,
               e1.project_name   AS entity_name,       e1.category AS entity_category,       e1.entity_serial,
               e2.project_name   AS linked_entity_name, e2.category AS linked_entity_category, e2.entity_serial AS linked_entity_serial
        FROM vault_entity_links vel
        JOIN vault_entries e1 ON e1.id = vel.entity_id
        JOIN vault_entries e2 ON e2.id = vel.linked_entity_id
        WHERE vel.user_id = ${userId}
        ORDER BY vel.created_at DESC
      `)
    );
    res.json(result.rows);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to fetch links", detail: err?.message });
  }
});

export default router;
