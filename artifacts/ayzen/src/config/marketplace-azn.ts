import type { ElementType } from "react";
import { Building2, Banknote, CreditCard } from "lucide-react";

// Config for pages/user/marketplace-azn.tsx. See UI_CONFIG_PLAN.md Phase C
// — "Buy/sell order create (AZN)" (extends config/marketplace.ts).
//
// Adding a payment method for AZN buy/sell listings = one entry here.

export interface AznPaymentMethod {
  id: string;
  label: string;
  icon: ElementType;
  color: string;
  border: string;
  bg: string;
  /** Optional processing fee percentage — used by the NFT marketplace's
   *  payment pill (config/marketplace-nft.ts), unused on this page. */
  fee?: number;
}

export const AZN_PAYMENT_METHODS: AznPaymentMethod[] = [
  { id: "binance", label: "Binance", icon: Building2, color: "text-amber-400", border: "border-amber-400/30", bg: "bg-amber-400/10", fee: 2 },
  { id: "bkash",   label: "bKash",   icon: Banknote,   color: "text-pink-400",  border: "border-pink-400/30",  bg: "bg-pink-400/10", fee: 2 },
  { id: "nagad",   label: "Nagad",   icon: CreditCard, color: "text-orange-400", border: "border-orange-400/30", bg: "bg-orange-400/10", fee: 2 },
];

export function getAznPaymentMethod(id: string) {
  return AZN_PAYMENT_METHODS.find(p => p.id === id);
}

// Per-method placeholder/label for the "payment details" field (Binance
// UID vs bKash/Nagad account number) — kept alongside the methods list
// since it's a lookup keyed by the same `id`, not a generic FieldDef (the
// field's label/placeholder change with the selected method, same reason
// "category" stayed page-local in fields/entity-create.ts).
export const AZN_PAYMENT_DETAILS_META: Record<string, { label: string; placeholder: string }> = {
  binance: { label: "Binance UID / Pay ID", placeholder: "e.g. 123456789" },
  bkash:   { label: "bKash Account Number", placeholder: "e.g. 01XXXXXXXXX" },
  nagad:   { label: "Nagad Account Number", placeholder: "e.g. 01XXXXXXXXX" },
};

export function getAznPaymentDetailsMeta(method: string) {
  return AZN_PAYMENT_DETAILS_META[method] ?? { label: "Payment Details", placeholder: "Account number / ID" };
}
