import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { ArrowLeft, Shield, Smartphone, ShieldCheck, Gamepad2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TOTPCard } from "@/components/vault/totp-card";

type Category = "kyc" | "local" | "entity" | "game";

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck },
  local:  { label: "Local",  icon: Smartphone },
  entity: { label: "Entity", icon: Shield },
  game:   { label: "Game",   icon: Gamepad2 },
};

interface TotpItem { id: string; label: string; issuer: string; secret: string; }

export default function VaultTwoFaEntity() {
  const params = useParams<{ category: string; id: string }>();
  const [, navigate] = useLocation();
  const category = (params.category as Category) ?? "entity";
  const id = Number(params.id);
  const meta = CATEGORY_META[category] ?? CATEGORY_META.entity;

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

  const { name, items }: { name: string; items: TotpItem[] } = useMemo(() => {
    if (category === "entity") {
      const e = ((vaultData as any[]) ?? []).find(x => x.id === id);
      if (!e) return { name: "", items: [] };
      const items: TotpItem[] = [];
      if (e.twitter2fa) items.push({ id: "tw", label: "Twitter", issuer: e.projectName, secret: e.twitter2fa });
      if (e.discord2fa) items.push({ id: "dc", label: "Discord", issuer: e.projectName, secret: e.discord2fa });
      if (e.telegram2fa) items.push({ id: "tg", label: "Telegram", issuer: e.projectName, secret: e.telegram2fa });
      return { name: e.projectName, items };
    }
    if (category === "local") {
      const a = raw.find(x => x.id === id);
      if (!a) return { name: "", items: [] };
      const items: TotpItem[] = [];
      if (a.twofa) items.push({ id: "main", label: "Main", issuer: a.email ?? "", secret: a.twofa });
      if (a.recovery_email_twofa) items.push({ id: "rec", label: "Recovery", issuer: a.recovery_email ?? "", secret: a.recovery_email_twofa });
      return { name: a.label ?? a.username ?? a.email ?? `Account #${a.id}`, items };
    }
    // kyc / game
    const e = raw.find(x => x.id === id);
    if (!e) return { name: "", items: [] };
    const items: TotpItem[] = e.email_2fa ? [{ id: "main", label: "Email", issuer: e.email ?? "", secret: e.email_2fa }] : [];
    return { name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, items };
  }, [category, id, vaultData, raw]);

  const isLoading = category === "entity" ? vaultLoading : loading;

  return (
    <div className="space-y-5 page-enter">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="h-8 w-8 flex-shrink-0" onClick={() => navigate(`/vault/2fa/${category}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-lg font-bold font-mono tracking-tighter truncate flex items-center gap-2">
            <meta.icon className="w-4 h-4 text-primary flex-shrink-0" />
            {name || "…"}
          </h1>
          <p className="text-muted-foreground font-mono text-[10px] mt-0.5">2FA · {meta.label}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : items.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <meta.icon className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">No 2FA codes found for this entity</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {items.map(item => (
            <TOTPCard key={item.id} label={item.label} issuer={item.issuer} secret={item.secret} />
          ))}
        </div>
      )}
    </div>
  );
}
