import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { Shield, Smartphone, ShieldCheck, Gamepad2, ChevronRight, Loader2, AtSign } from "lucide-react";
import {
  buildEntityMailItems, buildLocalMailItems, buildKycMailItems, buildGameMailItems,
  groupByEntity, type MailCategory,
} from "@/lib/vault-mail-items";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";

const CATEGORY_META: Record<MailCategory, { label: string; icon: React.ElementType; desc: string }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck, desc: "Emails from KYC entities" },
  local:  { label: "Local",  icon: Smartphone,  desc: "Emails from local accounts" },
  entity: { label: "Entity", icon: Shield,      desc: "Emails from vault entities" },
  game:   { label: "Game",   icon: Gamepad2,    desc: "Emails from game accounts" },
};

export default function VaultMailCategory() {
  const params = useParams<{ category: string }>();
  const [, navigate] = useLocation();
  // Guard against an unknown/stale category (e.g. a leftover "account" link)
  // silently falling through to the wrong endpoint/filter further down —
  // fall back to "entity" whenever the param isn't a real category.
  const rawCategory = params.category as MailCategory;
  const category: MailCategory = CATEGORY_META[rawCategory] ? rawCategory : "entity";
  const meta = CATEGORY_META[category];

  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [raw, setRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(category !== "entity");

  useEffect(() => {
    if (category === "entity") return;
    const endpoint = category === "kyc" ? "/kyc-entries" : category === "game" ? "/game-entries" : "/local-accounts";
    setLoading(true);
    customFetch<any>(endpoint).then(d => setRaw(Array.isArray(d) ? d : (d?.accounts ?? [])))
      .catch(() => setRaw([])).finally(() => setLoading(false));
  }, [category]);

  const summaries = useMemo(() => {
    const items = category === "entity" ? buildEntityMailItems((vaultData as any[]) ?? [])
      : category === "local" ? buildLocalMailItems(raw)
      : category === "kyc" ? buildKycMailItems(raw)
      : buildGameMailItems(raw);
    return groupByEntity(items);
  }, [category, vaultData, raw]);

  const isLoading = category === "entity" ? vaultLoading : loading;

  return (
    <VaultSectionPage title={`Mail Hub · ${meta.label}`} description={meta.desc} icon={meta.icon}>
      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : summaries.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <AtSign className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">No {meta.label} entities with an email yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {summaries.map(s => (
            <button
              key={`${s.category}-${s.entityId}`}
              onClick={() => navigate(`/vault/mail-hub/${category}/${s.entityId}`)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-xl hover:border-primary/30 transition-colors text-left"
            >
              <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                <meta.icon className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs font-bold truncate">{s.entityName}</p>
                <p className="font-mono text-[9px] text-muted-foreground/45 truncate">
                  {s.items.length} address{s.items.length !== 1 ? "es" : ""} · {s.items.map(i => i.email).join(", ")}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0" />
            </button>
          ))}
        </div>
      )}
    </VaultSectionPage>
  );
}
