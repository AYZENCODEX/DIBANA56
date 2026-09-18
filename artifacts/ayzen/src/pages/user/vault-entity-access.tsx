/**
 * vault-entity-access.tsx
 * ─────────────────────────────────────────────
 * Phase 19 — unified per-entity "Access" page (2FA / Mail / Backup).
 *
 * Reached only via the "Access" button on vault-entity-detail.tsx. A single
 * full-page view scoped to one vault entity, with three tabs that reuse the
 * exact same logic/components already shipped elsewhere in the vault:
 *   - 2FA:    TOTPCard (components/vault/totp-card.tsx), fed from this
 *             entity's twitter2fa/discord2fa/telegram2fa secrets only — same
 *             fields vault-2fa-entity.tsx reads for category="entity".
 *   - Mail:   VaultMailEntityBody, extracted from vault-mail-entity.tsx,
 *             always called with category="entity" so it lists exactly this
 *             entity's mailboxes/messages — not the global inbox, not the
 *             category-hub view.
 *   - Backup: EntityBackupDetail, extracted from vault-backup.tsx, filtered
 *             to this entity's backup/recovery codes.
 *
 * Protected by the same shared entity-view PIN gate as vault-entity-detail.tsx
 * (EntityPinGate) — independent of the outer /vault/* VaultUnlockGate, which
 * is already applied generically to every /vault/* route in route-config.tsx.
 *
 * The pre-existing category-hub pages (vault-2fa-category.tsx,
 * vault-mail-category.tsx) and their per-category entity views are left
 * completely untouched; this page is an additional, entity-scoped surface,
 * not a replacement for them.
 */
import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Shield, ChevronLeft, Loader2, ShieldCheck, Mail, HardDrive,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityPinGate } from "@/components/vault/entity-pin-gate";
import { TOTPCard } from "@/components/vault/totp-card";
import { VaultMailEntityBody } from "@/pages/user/vault-mail-entity";
import { EntityBackupDetail } from "@/pages/user/vault-backup";

type EntryAny = any;
type AccessTab = "2fa" | "mail" | "backup";

const TAB_META: Record<AccessTab, { label: string; icon: React.ElementType }> = {
  "2fa":   { label: "2FA",    icon: ShieldCheck },
  mail:    { label: "Mail",   icon: Mail },
  backup:  { label: "Backup", icon: HardDrive },
};

const TABS: AccessTab[] = ["2fa", "mail", "backup"];

// Phase 5 — Vault Security: same shared entity-view PIN as vault-entity-detail.tsx.
// Nothing below mounts (no 2FA secrets, mail, or backup codes fetched/rendered)
// until the gate is open.
export default function VaultEntityAccess() {
  return (
    <EntityPinGate>
      <VaultEntityAccessContent />
    </EntityPinGate>
  );
}

function VaultEntityAccessContent() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { data, isLoading } = useListVaultEntries();
  const [tab, setTab] = useState<AccessTab>("2fa");

  const entries: EntryAny[] = (data as EntryAny[] | undefined) ?? [];
  const entry = entries.find(e => String(e.id) === String(params.id));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <Loader2 className="w-6 h-6 text-primary animate-spin" />
      </div>
    );
  }

  if (!entry) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate("/vault?tab=entity")} className="font-mono text-xs gap-1.5">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to Vault
        </Button>
        <div className="text-center py-20">
          <Shield className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground/60">Entity not found</p>
        </div>
      </div>
    );
  }

  const id = Number(entry.id);

  const totpItems: { id: string; label: string; issuer: string; secret: string }[] = [];
  if (entry.twitter2fa) totpItems.push({ id: "tw", label: "Twitter", issuer: entry.projectName, secret: entry.twitter2fa });
  if (entry.discord2fa) totpItems.push({ id: "dc", label: "Discord", issuer: entry.projectName, secret: entry.discord2fa });
  if (entry.telegram2fa) totpItems.push({ id: "tg", label: "Telegram", issuer: entry.projectName, secret: entry.telegram2fa });

  return (
    <div className="space-y-5 page-enter max-w-3xl mx-auto">
      {/* Back + header */}
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate(`/vault/entity/${id}`)} className="font-mono text-xs gap-1.5 mb-3 -ml-2">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to {entry.projectName}
        </Button>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold font-mono tracking-tighter">{entry.projectName}</h1>
            <div className="flex items-center gap-2 mt-1">
              <Badge variant="outline" className="font-mono text-[9px] uppercase tracking-wider px-1.5 text-primary border-primary/20 bg-primary/5">
                Access
              </Badge>
              <span className="font-mono text-[10px] text-muted-foreground/50">{entry.entitySerial}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-muted/20 rounded-lg overflow-x-auto">
        {TABS.map(t => {
          const { label, icon: Icon } = TAB_META[t];
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-[10px] uppercase tracking-wider flex-shrink-0 transition-all",
                tab === t ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/50 hover:text-muted-foreground"
              )}
            >
              <Icon className="w-3 h-3" />
              {label}
            </button>
          );
        })}
      </div>

      {/* 2FA Tab */}
      {tab === "2fa" && (
        totpItems.length === 0 ? (
          <div className="text-center py-16 space-y-2">
            <ShieldCheck className="w-8 h-8 text-muted-foreground/30 mx-auto" />
            <p className="font-mono text-xs text-muted-foreground/50">No 2FA codes found for this entity</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {totpItems.map(item => (
              <TOTPCard key={item.id} label={item.label} issuer={item.issuer} secret={item.secret} />
            ))}
          </div>
        )
      )}

      {/* Mail Tab — always category="entity", scoped to this vaultEntryId only */}
      {tab === "mail" && <VaultMailEntityBody category="entity" id={id} />}

      {/* Backup Tab */}
      {tab === "backup" && <EntityBackupDetail entity={entry} />}
    </div>
  );
}
