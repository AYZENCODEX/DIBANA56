/**
 * lib/policy/pip/resource-attribute-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The roadmap's Phase 18 section names a `ResourceProvider` alongside
 * `SubjectProvider`/`SessionProvider`/etc. This file gives that vocabulary a
 * concrete shape. It deliberately ships NO real implementation this phase —
 * read on for why, and see `organization-provider.ts`'s own header for the
 * same reasoning applied to `OrganizationProvider`.
 *
 * ── Why no `DrizzleResourceAttributeProvider` ships this phase ────────────
 * Every other *Provider in this engine (RbacProvider, ResourceGrantProvider,
 * RelationshipProvider, VerificationLevelProvider, ...) reads ONE specific,
 * already-known table. A generic "fetch a resource's attributes by
 * (type, id)" provider has no such single table to read — AYZEN's
 * resources live across independently-schemaed tables per product
 * (`vault_items`, `finance_invoices`/`invoices`, `projects`, `oidc_clients`,
 * ...), with no unifying `resources` table. Phase 03's resource rules
 * (../resource/*) already solved this the other way: each ROUTE builds its
 * own `ResourceRef` from whichever table it already queries for its normal
 * business logic (see ../types.ts's `ResourceRef` doc comment: "Phase 03...
 * is what actually requires and validates these") — that division of
 * responsibility is what "PDP requests context through providers instead of
 * arbitrary DB queries" (this phase's own framing) already means for
 * SUBJECT/SESSION/DEVICE/RISK attributes (all keyed on one thing, `userId`,
 * against one or two real tables), but does not translate cleanly to
 * resources without either:
 *   (a) a real `resources` registry table this codebase does not have, or
 *   (b) a per-product adapter registry (one `VaultResourceProvider`, one
 *       `FinanceResourceProvider`, ...) — a real design, but a materially
 *       bigger, multi-file undertaking than this phase's own scope, and one
 *       that would duplicate work each route ALREADY does correctly today.
 *
 * Shipping a fake/generic implementation now — one that always returns
 * `null` for every real resource type, or one that invents schema access
 * this codebase doesn't have — is exactly the "convert mock functionality
 * into production functionality without real backend support" Rule 18
 * forbids. This interface exists so a future per-product adapter (Rule 16:
 * not implemented prematurely here) has an authoritative shape to
 * implement against, narrowing "arbitrary DB queries scattered through
 * routes" down to one adapter per product when that work is actually taken
 * on — not zero, and not a fabricated one today.
 *
 * Nothing in this codebase constructs, implements, or calls this interface.
 */

import type { ResourceRef } from "../types";

/**
 * Everything a per-product resource adapter would need to implement.
 * Returns a partial `ResourceRef` — a real implementation only fills in
 * whatever attributes ITS table actually has (e.g. a Vault adapter has no
 * opinion on `classification` if vault items don't model one), the same
 * "only fill in what you actually know" posture every other *Provider in
 * this engine's return shape already follows.
 *
 * Contract a future implementation must honor:
 *   - Never throw for "not found" — no matching row means `null`.
 *   - Read-only. No method here mutates state.
 *   - Exact match only — `resourceId` compared as given, no wildcard/prefix
 *     matching (same posture `ResourceGrantProvider`/`RelationshipProvider`
 *     already establish for their own lookups).
 */
export interface ResourceAttributeProvider {
  getResourceAttributes(resourceType: string, resourceId: string | number): Promise<Partial<ResourceRef> | null>;
}
