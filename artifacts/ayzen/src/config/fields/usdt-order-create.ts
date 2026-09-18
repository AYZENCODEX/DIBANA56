import type { FieldDef } from "@/config/types";

// Field config for the "USDT Trade" section of pages/user/marketplace-azn.tsx's
// Create Order form — mirrors fields/order-create.ts's AZN_ORDER_FIELDS but
// labeled for USDT amount / BDT price, since settlement here is always BDT.

export const USDT_ORDER_FIELDS: FieldDef[] = [
  {
    key: "amount", label: "USDT Amount *", type: "number", required: true,
    pairKey: "order-1", placeholder: "e.g. 100",
  },
  {
    key: "price_per_unit", label: "Price / USDT (BDT) *", type: "number", required: true,
    pairKey: "order-1", placeholder: "e.g. 118",
  },
];
