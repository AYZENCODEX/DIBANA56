import type { ElementType } from "react";
import { Banknote, CreditCard, Landmark } from "lucide-react";

// Config for the "USDT Trade" section of pages/user/marketplace-azn.tsx.
// Unlike AZN_PAYMENT_METHODS (config/marketplace-azn.ts), settlement here is
// always BDT — so Binance isn't offered as a method, only BDT-native rails.

export interface UsdtPaymentMethod {
  id: string;
  label: string;
  icon: ElementType;
  color: string;
  border: string;
  bg: string;
}

export const USDT_PAYMENT_METHODS: UsdtPaymentMethod[] = [
  { id: "bkash", label: "bKash", icon: Banknote,   color: "text-pink-400",   border: "border-pink-400/30",   bg: "bg-pink-400/10" },
  { id: "nagad", label: "Nagad", icon: CreditCard, color: "text-orange-400", border: "border-orange-400/30", bg: "bg-orange-400/10" },
  { id: "bank",  label: "Bank Transfer", icon: Landmark, color: "text-sky-400", border: "border-sky-400/30", bg: "bg-sky-400/10" },
];

export function getUsdtPaymentMethod(id: string) {
  return USDT_PAYMENT_METHODS.find(p => p.id === id);
}

export const USDT_PAYMENT_DETAILS_META: Record<string, { label: string; placeholder: string }> = {
  bkash: { label: "bKash Account Number", placeholder: "e.g. 01XXXXXXXXX" },
  nagad: { label: "Nagad Account Number", placeholder: "e.g. 01XXXXXXXXX" },
  bank:  { label: "Bank Account Number",  placeholder: "e.g. 1234567890" },
};

export function getUsdtPaymentDetailsMeta(method: string) {
  return USDT_PAYMENT_DETAILS_META[method] ?? { label: "Payment Details", placeholder: "Account number / ID" };
}
