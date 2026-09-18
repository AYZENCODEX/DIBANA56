/**
 * vault-backup-entity.tsx
 * ─────────────────────────────────────────────
 * Per-account backup code detail — /vault/backup/:category/:id.
 * Mirrors vault-2fa-entity.tsx's category-dispatch shape, but for backup
 * codes: Entity reads the vault entry's backupCodes array; Local splits its
 * single free-text backup_codes column into individual codes; KYC surfaces
 * its three distinct backup fields (Account / Email / Recovery); Game
 * surfaces its one email_backup_code.
 */
import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { ArrowLeft, Shield, Smartphone, ShieldCheck, Gamepad2, Loader2, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { splitCodes } from "@/pages/user/vault-backup";

type Category = "kyc" | "local" | "entity" | "game";

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck },
  local:  { label: "Local",  icon: Smartphone },
  entity: { label: "Entity", icon: Shield },
  game:   { label: "Game",   icon: Gamepad2 },
};

interface CodeGroup { id: string; label: string; codes: string[]; }

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(value); } catch { /* clipboard unavailable */ }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground/60 hover:text-primary transition-colors flex-shrink-0"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {label && <span className={copied ? "text-emerald-400" : ""}>{copied ? "Copied" : label}</span>}
    </button>
  );
}

function CodeGroupCard({ group }: { group: CodeGroup }) {
  return (
    <div className="border border-border/30 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/20">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">{group.label}</p>
        {group.codes.length > 1 && <CopyButton value={group.codes.join("\n")} label="Copy all" />}
      </div>
      <div className="divide-y divide-border/20">
        {group.codes.map((code, i) => (
          <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 bg-card">
            <span className="font-mono text-xs text-foreground/80 truncate">{code}</span>
            <CopyButton value={code} label="Copy" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function VaultBackupEntity() {
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

  const { name, groups }: { name: string; groups: CodeGroup[] } = useMemo(() => {
    if (category === "entity") {
      const e = ((vaultData as any[]) ?? []).find(x => x.id === id);
      if (!e) return { name: "", groups: [] };
      const codes: string[] = Array.isArray(e.backupCodes) ? e.backupCodes : [];
      return { name: e.projectName || `Entity #${e.id}`, groups: codes.length ? [{ id: "backup", label: "Backup Codes", codes }] : [] };
    }
    if (category === "local") {
      const a = raw.find(x => x.id === id);
      if (!a) return { name: "", groups: [] };
      const codes = splitCodes(a.backup_codes);
      return { name: a.label ?? a.username ?? a.email ?? `Account #${a.id}`, groups: codes.length ? [{ id: "backup", label: "Backup Codes", codes }] : [] };
    }
    if (category === "kyc") {
      const e = raw.find(x => x.id === id);
      if (!e) return { name: "", groups: [] };
      const groups: CodeGroup[] = [];
      if (e.account_backup_code)  groups.push({ id: "account",  label: "Account Backup",  codes: [e.account_backup_code] });
      if (e.email_backup_code)    groups.push({ id: "email",    label: "Email Backup",    codes: [e.email_backup_code] });
      if (e.recovery_backup_code) groups.push({ id: "recovery", label: "Recovery Backup", codes: [e.recovery_backup_code] });
      return { name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, groups };
    }
    // game — single email_backup_code field
    const e = raw.find(x => x.id === id);
    if (!e) return { name: "", groups: [] };
    const groups: CodeGroup[] = e.email_backup_code ? [{ id: "email", label: "Email Backup", codes: [e.email_backup_code] }] : [];
    return { name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, groups };
  }, [category, id, vaultData, raw]);

  const isLoading = category === "entity" ? vaultLoading : loading;

  return (
    <div className="space-y-5 page-enter">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="h-8 w-8 flex-shrink-0" onClick={() => navigate(`/vault/backup/${category}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-lg font-bold font-mono tracking-tighter truncate flex items-center gap-2">
            <meta.icon className="w-4 h-4 text-primary flex-shrink-0" />
            {name || "…"}
          </h1>
          <p className="text-muted-foreground font-mono text-[10px] mt-0.5">Backup · {meta.label}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : groups.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <meta.icon className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">No backup codes found for this account</p>
        </div>
      ) : (
        <div className="space-y-3">
          {groups.map(group => <CodeGroupCard key={group.id} group={group} />)}
        </div>
      )}
    </div>
  );
}
