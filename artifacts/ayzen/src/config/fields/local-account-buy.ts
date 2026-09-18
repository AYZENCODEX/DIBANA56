import type { FieldDef } from "@/config/types";

// Per-category buy-order fields for pages/user/marketplace-vault.tsx's
// "create buy order" flow. See UI_CONFIG_PLAN.md Phase C — "Marketplace
// vault" (a category's local-account-domain form, distinct from the entity
// flow which works off actual platforms via ENTITY_PLATFORM_META in
// config/marketplace.ts instead of a fixed field set).
//
// The page's own field renderer handles `type: "toggle"` as a Yes/No pill
// pair (not the generic SchemaField toggle control) — kept as page code
// since it's a one-off two-button layout, not reused elsewhere.
//
// Adding a filter field for a category = one entry in that category's array.

export const LOCAL_ACCOUNT_BUY_FIELDS: Record<string, FieldDef[]> = {
  gmail: [
    { key: "account_create_date", label: "Account Created (date)", type: "text", placeholder: "e.g. 2020-01-15" },
    { key: "points", label: "Points", type: "number", placeholder: "e.g. 1000" },
    { key: "has_2fa", label: "2FA Access Included", type: "toggle" },
  ],
  facebook: [
    { key: "account_create_date", label: "Account Created (date)", type: "text", placeholder: "e.g. 2019-06-01" },
    { key: "followers", label: "Min Followers", type: "number", placeholder: "e.g. 500" },
    { key: "has_2fa", label: "2FA Access Included", type: "toggle" },
  ],
  github: [
    { key: "account_age_years", label: "Min Account Age (years)", type: "number", placeholder: "e.g. 3" },
    { key: "account_create_date", label: "Account Created (date)", type: "text", placeholder: "e.g. 2021-03-10" },
    { key: "repo_count", label: "Min Repositories", type: "number", placeholder: "e.g. 10" },
  ],
  linkedin: [
    { key: "account_create_date", label: "Account Created (date)", type: "text", placeholder: "e.g. 2018-09-20" },
    { key: "account_age_years", label: "Min Account Age (years)", type: "number", placeholder: "e.g. 2" },
    { key: "connections", label: "Min Connections", type: "number", placeholder: "e.g. 100" },
  ],
  reddit: [
    { key: "account_create_date", label: "Account Created (date)", type: "text", placeholder: "e.g. 2020-11-01" },
    { key: "account_age_years", label: "Min Account Age (years)", type: "number", placeholder: "e.g. 1" },
    { key: "followers", label: "Min Followers", type: "number", placeholder: "e.g. 50" },
  ],
};
