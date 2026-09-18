/**
 * vault-backup.tsx
 * ─────────────────────────────────────────────
 * Phase 6 — Backup Codes.
 * Season 2 — Backup Code sidebar restructure: mirrors the 2FA section's
 * (Overview / Entity / Local / KYC / Game) sub-sidebar. Overview rolls up
 * backup-code counts across all four account categories; each category tab
 * scopes down to just that category's stored codes. Per-account code detail
 * lives in vault-backup-entity.tsx (see /vault/backup/:category/:id).
 */
import { useState, useEffect, useMemo } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import {
  HardDrive, Shield, Smartphone, ShieldCheck, Gamepad2,
  LayoutDashboard, ChevronRight, ArrowLeft, Copy, Check,
} from "lucide-react";
import { VaultSectionPage, VaultSectionEmptyState, CategoryTabBar } from "@/components/layout/vault-sidebar";
import { VaultLoadingIntro } from "@/components/vault/vault-loading-intro";

// ─── Copy button + entity-scoped backup detail — kept exported for
// vault-entity-access.tsx's "Backup" tab, which reuses this exact view
// filtered to a single entity (see that file's header comment). ───────────────
function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
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

export function EntityBackupDetail({ entity, onBack }: { entity: any; onBack?: () => void }) {
  const codes: string[] = Array.isArray(entity.backupCodes) ? entity.backupCodes : [];

  return (
    <div className="space-y-4">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </button>
      )}

      <div className="flex items-center gap-2.5">
        <Shield className="w-4 h-4 text-primary/70 flex-shrink-0" />
        <div className="min-w-0">
          <p className="font-mono text-sm font-bold truncate">{entity.projectName || `Entity #${entity.id}`}</p>
          <p className="font-mono text-[9px] text-muted-foreground/50">
            {entity.entitySerial}
          </p>
        </div>
      </div>

      {codes.length === 0 ? (
        <VaultSectionEmptyState
          icon={HardDrive}
          title="No backup codes stored for this entity"
          note="Add backup codes from the entity's Wallet · Manual tab in the Vault Entity list."
        />
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
              {codes.length} backup code{codes.length !== 1 ? "s" : ""}
            </p>
            <CopyButton value={codes.join("\n")} label="Copy all" />
          </div>
          <div className="border border-border/30 rounded-lg divide-y divide-border/20 overflow-hidden">
            {codes.map((code, i) => (
              <div key={i} className="flex items-center justify-between gap-3 px-3 py-2 bg-card">
                <span className="font-mono text-xs text-foreground/80 truncate">{code}</span>
                <CopyButton value={code} label="Copy" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

type Category = "overview" | "kyc" | "local" | "entity" | "game";

const CATEGORY_META: Record<Category, { label: string; icon: React.ElementType; desc: string }> = {
  overview: { label: "Overview", icon: LayoutDashboard, desc: "All backup codes across Entity, Local, KYC & Game" },
  kyc:      { label: "KYC",      icon: ShieldCheck,      desc: "Backup codes from KYC entities" },
  local:    { label: "Local",    icon: Smartphone,       desc: "Backup codes from local accounts" },
  entity:   { label: "Entity",   icon: Shield,           desc: "Backup codes from vault entities" },
  game:     { label: "Game",     icon: Gamepad2,         desc: "Backup codes from game accounts" },
};

interface Row { id: number | string; name: string; count: number; }
interface OverviewRow extends Row { category: Exclude<Category, "overview">; }

// Splits a free-text "one code per line" field (local accounts store all
// their backup codes in a single text column) into a clean, non-empty list.
export function splitCodes(raw: string | null | undefined): string[] {
  return (raw ?? "").split("\n").map(s => s.trim()).filter(Boolean);
}

// Shared row-computation so both the single-category view and the Overview
// roll-up derive rows the same way from the same raw sources.
function computeRows(category: Exclude<Category, "overview">, vaultData: any[], raw: any[]): Row[] {
  if (category === "entity") {
    return vaultData
      .filter(e => Array.isArray(e.backupCodes) && e.backupCodes.length > 0)
      .map(e => ({ id: e.id, name: e.projectName || `Entity #${e.id}`, count: e.backupCodes.length }));
  }
  if (category === "local") {
    return raw
      .map(a => ({ id: a.id, name: a.label ?? a.username ?? a.email ?? `Account #${a.id}`, count: splitCodes(a.backup_codes).length }))
      .filter(r => r.count > 0);
  }
  if (category === "kyc") {
    return raw
      .map(e => ({
        id: e.id,
        name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`,
        count: [e.account_backup_code, e.email_backup_code, e.recovery_backup_code].filter(Boolean).length,
      }))
      .filter(r => r.count > 0);
  }
  // game — single email_backup_code field
  return raw
    .map(e => ({ id: e.id, name: e.name ?? e.username ?? e.platform ?? e.category ?? `#${e.id}`, count: e.email_backup_code ? 1 : 0 }))
    .filter(r => r.count > 0);
}

// ─── Category → account list (kyc / local / entity / game) ────────────────────
function EntityBackupList({ category }: { category: Exclude<Category, "overview"> }) {
  const [, navigate] = useLocation();
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

  const rows: Row[] = useMemo(
    () => computeRows(category, (vaultData as any[]) ?? [], raw),
    [category, vaultData, raw]
  );

  const isLoading = category === "entity" ? vaultLoading : loading;
  const Icon = CATEGORY_META[category].icon;

  if (isLoading) return <VaultLoadingIntro title="Loading backup codes" done={!isLoading} className="py-8" />;

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 space-y-2">
        <Icon className="w-8 h-8 text-muted-foreground/30 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No {CATEGORY_META[category].label} accounts with backup codes yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map(row => (
        <button
          key={row.id}
          onClick={() => navigate(`/vault/backup/${category}/${row.id}`)}
          className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-xl hover:border-primary/30 transition-colors text-left"
        >
          <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs font-bold truncate">{row.name}</p>
            <p className="font-mono text-[9px] text-muted-foreground/45">{row.count} backup code{row.count !== 1 ? "s" : ""}</p>
          </div>
          <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0" />
        </button>
      ))}
    </div>
  );
}

// ─── Overview (roll-up of entity / local / kyc / game) ────────────────────────
function OverviewBackupList() {
  const [, navigate] = useLocation();
  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [localRaw, setLocalRaw] = useState<any[]>([]);
  const [kycRaw, setKycRaw] = useState<any[]>([]);
  const [gameRaw, setGameRaw] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      customFetch<any>("/local-accounts").then(d => setLocalRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setLocalRaw([])),
      customFetch<any>("/kyc-entries").then(d => setKycRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setKycRaw([])),
      customFetch<any>("/game-entries").then(d => setGameRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setGameRaw([])),
    ]).finally(() => setLoading(false));
  }, []);

  const rows: OverviewRow[] = useMemo(() => {
    const vd = (vaultData as any[]) ?? [];
    return [
      ...computeRows("entity", vd, []).map(r => ({ ...r, category: "entity" as const })),
      ...computeRows("local", [], localRaw).map(r => ({ ...r, category: "local" as const })),
      ...computeRows("kyc", [], kycRaw).map(r => ({ ...r, category: "kyc" as const })),
      ...computeRows("game", [], gameRaw).map(r => ({ ...r, category: "game" as const })),
    ];
  }, [vaultData, localRaw, kycRaw, gameRaw]);

  const isLoading = vaultLoading || loading;
  const totalCodes = rows.reduce((sum, r) => sum + r.count, 0);

  if (isLoading) return <VaultLoadingIntro title="Loading backup codes" done={!isLoading} className="py-8" />;

  if (rows.length === 0) {
    return (
      <div className="text-center py-16 space-y-2">
        <LayoutDashboard className="w-8 h-8 text-muted-foreground/30 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No backup codes stored yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 px-1">
        {rows.length} account{rows.length !== 1 ? "s" : ""} · {totalCodes} backup code{totalCodes !== 1 ? "s" : ""}
      </p>
      {rows.map(row => {
        const Icon = CATEGORY_META[row.category].icon;
        return (
          <button
            key={`${row.category}-${row.id}`}
            onClick={() => navigate(`/vault/backup/${row.category}/${row.id}`)}
            className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-xl hover:border-primary/30 transition-colors text-left"
          >
            <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
              <Icon className="w-4 h-4 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs font-bold truncate">{row.name}</p>
              <p className="font-mono text-[9px] text-muted-foreground/45">
                {CATEGORY_META[row.category].label} · {row.count} backup code{row.count !== 1 ? "s" : ""}
              </p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground/30 flex-shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────
const TABS = (["overview", "entity", "local", "kyc", "game"] as const)
  .map(id => ({ id, label: CATEGORY_META[id].label, icon: CATEGORY_META[id].icon }));

export default function VaultBackup() {
  const params = useParams<{ category?: string }>();
  // No :category param at all means someone hit the bare "/vault/backup"
  // (old bookmark/link) — send them to Overview rather than 404ing.
  const rawCategory = (params.category as Category) ?? "overview";
  const category: Category = CATEGORY_META[rawCategory] ? rawCategory : "overview";
  const meta = CATEGORY_META[category];

  return (
    <VaultSectionPage title="Backup Code" description={meta.desc} icon={HardDrive}>
      <div className="space-y-4">
        <CategoryTabBar basePath="/vault/backup" active={category} tabs={TABS} />
        {category === "overview" ? <OverviewBackupList /> : <EntityBackupList category={category} />}
      </div>
    </VaultSectionPage>
  );
}
