import type { FieldDef } from "@/config/types";

// Field config for pages/user/marketplace-azn.tsx's Create Order form. See
// UI_CONFIG_PLAN.md Phase C — "Buy/sell order create (AZN)".
//
// Covers "AZN Amount" and "Price / AZN" only. Payment method stays a
// page-local pill selector wired to config/marketplace-azn.ts's
// AZN_PAYMENT_METHODS (icons + selected-state styling don't fit the plain
// FieldDef "select" shape), and "Payment Details" stays page-local too —
// its label and placeholder change per selected payment method via
// AZN_PAYMENT_DETAILS_META, which is dynamic-per-value content rather than
// a fixed field def (same reasoning as "category" in fields/entity-create.ts).

export const AZN_ORDER_FIELDS: FieldDef[] = [
  {
    key: "amount", label: "AZN Amount *", type: "number", required: true,
    pairKey: "order-1", placeholder: "e.g. 500",
  },
  {
    key: "price_per_unit", label: "Price / AZN (AZN) *", type: "number", required: true,
    pairKey: "order-1", placeholder: "e.g. 0.01",
  },
];
