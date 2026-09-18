import { useMemo } from "react";
import { useConfigDomain } from "./use-config-domain";
import { resolveConfigIcon } from "@/lib/dev-nav-icons";
import { AZN_PAYMENT_METHODS, AZN_PAYMENT_DETAILS_META, type AznPaymentMethod } from "@/config/marketplace-azn";

const DOMAIN = "marketplace-azn-payment-methods";

/**
 * Live version of config/marketplace-azn.ts's AZN_PAYMENT_METHODS +
 * AZN_PAYMENT_DETAILS_META, editable from Config Manager
 * (/admin/config-manager) instead of requiring a code change + redeploy.
 * Falls back to the static file while the DB entries are loading or if
 * the domain is empty, so the page never renders with zero payment
 * methods.
 */
export function useAznPaymentMethods() {
  const { entries, isLoading } = useConfigDomain(DOMAIN);

  const methods = useMemo<AznPaymentMethod[]>(() => {
    const enabled = entries.filter(e => e.enabled);
    if (enabled.length === 0) return AZN_PAYMENT_METHODS;
    return enabled.map(e => ({
      id: String(e.data.id ?? e.id),
      label: String(e.data.label ?? e.data.id ?? "Payment"),
      icon: resolveConfigIcon(typeof e.data.icon === "string" ? e.data.icon : undefined),
      color: String(e.data.color ?? "text-muted-foreground"),
      border: String(e.data.border ?? "border-border/40"),
      bg: String(e.data.bg ?? "bg-muted/10"),
      fee: typeof e.data.fee === "number" ? e.data.fee : undefined,
    }));
  }, [entries]);

  const detailsMeta = useMemo<Record<string, { label: string; placeholder: string }>>(() => {
    const enabled = entries.filter(e => e.enabled);
    if (enabled.length === 0) return AZN_PAYMENT_DETAILS_META;
    const out: Record<string, { label: string; placeholder: string }> = {};
    for (const e of enabled) {
      const id = String(e.data.id ?? e.id);
      out[id] = {
        label: String(e.data.detailsLabel ?? "Payment Details"),
        placeholder: String(e.data.detailsPlaceholder ?? "Account number / ID"),
      };
    }
    return out;
  }, [entries]);

  const getDetailsMeta = (method: string) => detailsMeta[method] ?? { label: "Payment Details", placeholder: "Account number / ID" };

  return { methods, detailsMeta, getDetailsMeta, isLoading };
}
