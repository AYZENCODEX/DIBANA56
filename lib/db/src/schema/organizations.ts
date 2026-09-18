import { pgTable, serial, integer, text, boolean, timestamp, unique } from "drizzle-orm/pg-core";

// Phase 8 — Organization Accounts. See migrations/109_ayzen_organizations.sql
// for the reasoning (distinct from `teams`/`team_members` — see that file's
// header for why the two aren't merged).

export const organizationsTable = pgTable("organizations", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  ownerId: integer("owner_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type Organization = typeof organizationsTable.$inferSelect;

export const organizationMembersTable = pgTable("organization_members", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  userId: integer("user_id").notNull(),
  role: text("role").notNull().default("member"), // 'owner' | 'admin' | 'member'
  status: text("status").notNull().default("pending"), // 'pending' | 'active'
  invitedBy: integer("invited_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  orgUserUnique: unique().on(t.organizationId, t.userId),
}));
export type OrganizationMember = typeof organizationMembersTable.$inferSelect;

export const organizationVaultSharesTable = pgTable("organization_vault_shares", {
  id: serial("id").primaryKey(),
  organizationId: integer("organization_id").notNull(),
  entityType: text("entity_type").notNull(), // 'local' | 'entity' | 'kyc' | 'game'
  entityId: integer("entity_id").notNull(),
  sharedBy: integer("shared_by").notNull(),
  fieldPermissions: text("field_permissions"), // JSON { field: 'view'|'edit' } | null
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (t) => ({
  orgEntityUnique: unique().on(t.organizationId, t.entityType, t.entityId),
}));
export type OrganizationVaultShare = typeof organizationVaultSharesTable.$inferSelect;

export const organizationExtensionPoliciesTable = pgTable("organization_extension_policies", {
  organizationId: integer("organization_id").primaryKey(),
  disableSeedReveal: boolean("disable_seed_reveal").notNull().default(false),
  requireDomainAllowlist: boolean("require_domain_allowlist").notNull().default(false),
  allowedDomains: text("allowed_domains").notNull().default("[]"), // JSON string[]
  updatedBy: integer("updated_by"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
export type OrganizationExtensionPolicy = typeof organizationExtensionPoliciesTable.$inferSelect;
