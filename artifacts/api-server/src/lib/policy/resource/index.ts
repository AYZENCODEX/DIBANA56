/**
 * lib/policy/resource/index.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 03 (Resource / Ownership
 * Authorization). Covers sub-phases 3A (ownership + locked-resource), 3B
 * (explicit resource grants + resource-level deny), and 3C (organization
 * access) — the full five-rule list the roadmap's Phase 03 section names:
 * ownership, explicit grants, organization access, resource-level deny,
 * locked-resource restrictions.
 *
 * Barrel for everything under `lib/policy/resource/*` EXCEPT
 * `drizzle-resource-grant-provider.ts`. That file alone imports
 * `@workspace/db` (a real DB dependency); every other file here is DB-free
 * and side-effect-free by design (see ownership-rule.ts / locked-resource-
 * rule.ts / explicit-grant-rule.ts / organization-access-rule.ts headers),
 * which is what lets every `scripts/src/test-policy-resource*.ts` file run
 * with nothing but in-memory fakes. Re-exporting the Drizzle provider from
 * this same barrel would drag `@workspace/db` into that DB-free guarantee
 * for every consumer of `./resource` (and, transitively, of `lib/policy`'s
 * own top-level barrel — see ../index.ts) — same reasoning as
 * `../rbac/index.ts`'s own header for `drizzle-rbac-provider.ts`. Import
 * `./resource/drizzle-resource-grant-provider` directly at the one real
 * call site that actually constructs it.
 *
 * Cross-tenant / organization access has no analogous "Drizzle provider" to
 * exclude — see organization-access-rule.ts's header for why 3C needed no
 * new DB-backed lookup at all.
 *
 * `group-membership-rule.ts` (Route Integration Roadmap, Season D, Phase
 * D6) is a later addition, not part of Phase 03's original five-rule list
 * — same DB-free, caller-supplied-fact posture as ownership-rule.ts /
 * organization-access-rule.ts, so it belongs in this same barrel. See that
 * file's own header for why it needed no new DB-backed provider either.
 */

export * from "./ownership-rule";
export * from "./locked-resource-rule";
export * from "./types";
export * from "./explicit-grant-rule";
export * from "./organization-access-rule";
export * from "./role-override-rule";
export * from "./group-membership-rule";
