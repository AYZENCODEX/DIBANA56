import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * schema/temporary-access-grants.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 11 (Temporary / Expiring
 * Access). Data model backing `lib/policy/temporary-access/temporary-access-
 * rule.ts`. This file is schema ONLY (Drizzle table def + insert-schema
 * validation) — the actual matching/expiry logic lives in
 * `artifacts/api-server/src/lib/policy/temporary-access/*`, not here. Same
 * `lib/db`-must-not-depend-on-`lib/policy` boundary `resource-grants.ts` /
 * `rbac.ts` document.
 *
 * ── Why this is a NEW table, not `expiresAt`/`startsAt` bolted onto
 *    `resource_grants` ──────────────────────────────────────────────────────
 * `resource-grants.ts`'s own header already flagged this exact question
 * ("Why there is no `expiresAt` column yet") and left it for "a future
 * sharing/admin-console phase that actually needs expiring shares". Two
 * things changed by the time Phase 11 actually needs it:
 *
 *   1. `resource_grants` is EXACT-MATCH-ONLY by design (one row per
 *      (subject, resourceType, resourceId, action), enforced by a unique
 *      index — see that file's header) — reasonable for a PERMANENT grant,
 *      where each explicit statement is meant to be a single, durable
 *      source of truth. A short-lived grant is very often broader than one
 *      resource instance ("give this contractor 48h read access to every
 *      vault item in org 7", not one specific item) — cramming that into
 *      `resource_grants`' one-row-per-exact-tuple shape would mean writing
 *      (and later expiring) one row per resource, which does not fit a
 *      table designed around a permanent 1:1 mapping.
 *   2. `resource_grants` has no `effect: "allow" | "deny"` distinction this
 *      table needs to preserve — a *temporary* grant is inherently about
 *      GRANTING (the roadmap's own Phase 11 section says "Support grants
 *      with: ..." — it never asks for a time-boxed deny). Keeping this
 *      table allow-only (no `effect` column at all) means
 *      `temporary-access-rule.ts` can never produce an unexpected DENY from
 *      a row whose only job was to add a time-limited access path — see
 *      that file's own header for the full reasoning.
 *
 * ── The `scope` column — what makes this broader than `resource_grants` ────
 * The roadmap's Phase 11 field list names `scope` as its own field,
 * separate from `resource`/`action`. This table gives it a concrete,
 * two-value meaning:
 *   - `"resource"`  — same exact-match granularity as `resource_grants`:
 *     this grant covers only `resourceType` + this exact `resourceId` +
 *     `action`.
 *   - `"resource_type"` — covers EVERY resource of `resourceType` (for this
 *     `action`), optionally narrowed further to one `organizationId`.
 *     `resourceId` is NULL for these rows — see the CHECK constraint in the
 *     matching migration, which the insert schema below mirrors at the
 *     application layer.
 *
 * ── Why `startsAt`/`expiresAt` are both required, not just `expiresAt` ─────
 * The roadmap's own field list names both `startsAt` and `expiresAt`
 * explicitly ("Support grants with: ... startsAt, expiresAt, ..."). A grant
 * that is not yet active (now < startsAt) must not authorize any more than
 * an already-expired one — "temporary access" means a bounded WINDOW, not
 * merely a deadline. `temporary-access-rule.ts` checks both bounds against
 * `request.context.timestamp` (never a fresh `new Date()` read inside the
 * rule — see that file's header for why: Rule 12, deterministic
 * evaluation).
 *
 * ── No DB-level FOREIGN KEY constraints ────────────────────────────────────
 * Same posture as `resource_grants.ts`/`rbac.ts` — `subjectUserId`/
 * `grantedBy` are plain indexed integers, not `.references()`.
 *
 * ── No `revokedAt` / early-termination column yet ──────────────────────────
 * The roadmap's Phase 11 section does not ask for early revocation (that is
 * closer to Phase 23's admin console / a PAP write-path concern) — adding an
 * unused nullable column now, with no writer to ever populate it, would be
 * speculative schema per Rule 16 ("do not implement future phases
 * prematurely"). A grant that should stop early today can simply have its
 * `expiresAt` updated by whatever future admin surface manages these rows;
 * nothing about this schema forecloses adding a dedicated `revokedAt` column
 * (and a "revoked beats expiresAt" check in the rule) later.
 */

export const temporaryAccessGrantsTable = pgTable(
  "temporary_access_grants",
  {
    id: serial("id").primaryKey(),
    /** WHO receives temporary access. */
    subjectUserId: integer("subject_user_id").notNull(),
    /** e.g. "sylo.vault_item" — same family as `ResourceRef.type`. */
    resourceType: text("resource_type").notNull(),
    /** Always stored as TEXT (see resource-grants.ts's header for why —
     *  same reasoning applies here). NULL when `scope = "resource_type"`
     *  (see file header). */
    resourceId: text("resource_id"),
    /** e.g. "sylo.vault.read" — same family as `AuthorizationRequest.action`.
     *  Exact string match only, same as resource_grants (no wildcards). */
    action: text("action").notNull(),
    /** "resource" | "resource_type" — see file header. Validated at the
     *  data-entry boundary below; the rule (temporary-access-rule.ts)
     *  treats any other value as a malformed row and skips it (fails
     *  closed) rather than trusting it, same posture
     *  drizzle-resource-grant-provider.ts takes for `effect`. */
    scope: text("scope").notNull(),
    /** Only meaningful (and only ever consulted) when `scope =
     *  "resource_type"` — narrows an otherwise resource-type-wide grant to
     *  one organization. NULL means "every organization" for that
     *  resource type. Ignored entirely when `scope = "resource"` (an
     *  exact-resource grant does not need an org filter — the resource id
     *  already fully identifies the target). */
    organizationId: integer("organization_id"),
    /** Grant is not yet active before this instant. Compared against
     *  `request.context.timestamp`, never a fresh clock read — see file
     *  header. */
    startsAt: timestamp("starts_at").notNull(),
    /** Grant stops authorizing at (inclusive of) this instant — i.e. the
     *  active window is the HALF-OPEN interval [startsAt, expiresAt). See
     *  temporary-access-rule.ts's header for the exact boundary semantics
     *  and why expiresAt itself already counts as expired. */
    expiresAt: timestamp("expires_at").notNull(),
    /** Who granted this — required (unlike resource_grants.grantedBy,
     *  which is nullable because no writer exists for that table yet). A
     *  time-boxed access grant is inherently an accountable, one-off
     *  administrative act — the roadmap's own Phase 11 field list names
     *  `grantedBy` as a required part of the grant's shape, not an
     *  afterthought audit column. */
    grantedBy: integer("granted_by").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("temporary_access_grants_subject_idx").on(table.subjectUserId, table.resourceType, table.action),
    index("temporary_access_grants_expires_idx").on(table.expiresAt),
  ],
);

export const insertTemporaryAccessGrantSchema = createInsertSchema(temporaryAccessGrantsTable, {
  scope: (schema) => schema.refine((v) => v === "resource" || v === "resource_type", 'scope must be "resource" or "resource_type"'),
})
  .omit({ id: true, createdAt: true })
  .refine((v) => v.expiresAt > v.startsAt, { message: "expiresAt must be after startsAt", path: ["expiresAt"] })
  .refine((v) => v.scope !== "resource" || (v.resourceId !== null && v.resourceId !== undefined && v.resourceId.length > 0), {
    message: 'resourceId is required when scope is "resource"',
    path: ["resourceId"],
  });
export type InsertTemporaryAccessGrant = z.infer<typeof insertTemporaryAccessGrantSchema>;
export type TemporaryAccessGrantRow = typeof temporaryAccessGrantsTable.$inferSelect;
