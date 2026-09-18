/**
 * vault-enrollment-linked-detail.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Linked → [entity detail]: shows the full relationship graph
 * for a single vault entity. Visual diagram connects all linked entities
 * with labelled relationship edges. Each linked entity is clickable.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation, useParams } from "wouter";
import {
  Link2, Shield, Loader2, ChevronLeft,
  GitFork, Wallet, Mail, Cpu, Monitor, User2,
  AlertCircle, ChevronRight,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface EntityLink {
  id: number;
  entity_id: number;
  linked_entity_id: number;
  relation_type: string;
  note: string | null;
  entity_name: string;
  entity_category: string;
  entity_serial: string | null;
  linked_entity_name: string;
  linked_entity_category: string;
  linked_entity_serial: string | null;
  created_at: string;
}

const RELATION_META: Record<string, { label: string; icon: React.ElementType; color: string; bgColor: string; borderColor: string }> = {
  alt_of:        { label: "Alt of",        icon: GitFork,  color: "text-violet-400", bgColor: "bg-violet-400/10",  borderColor: "border-violet-400/25" },
  main_of:       { label: "Main of",       icon: GitFork,  color: "text-cyan-400",   bgColor: "bg-cyan-400/10",    borderColor: "border-cyan-400/25" },
  shares_wallet: { label: "Shares Wallet", icon: Wallet,   color: "text-amber-400",  bgColor: "bg-amber-400/10",   borderColor: "border-amber-400/25" },
  shares_email:  { label: "Shares Email",  icon: Mail,     color: "text-emerald-400",bgColor: "bg-emerald-400/10", borderColor: "border-emerald-400/25" },
  shares_ip:     { label: "Shares IP",     icon: Cpu,      color: "text-orange-400", bgColor: "bg-orange-400/10",  borderColor: "border-orange-400/25" },
  shares_device: { label: "Shares Device", icon: Monitor,  color: "text-blue-400",   bgColor: "bg-blue-400/10",    borderColor: "border-blue-400/25" },
  same_owner:    { label: "Same Owner",    icon: User2,    color: "text-pink-400",   bgColor: "bg-pink-400/10",    borderColor: "border-pink-400/25" },
  other:         { label: "Linked",        icon: Link2,    color: "text-muted-foreground", bgColor: "bg-muted/20", borderColor: "border-border/30" },
};

// ── Node component — the entity bubble in the visual graph ────────────────────
function EntityNode({
  name, category, isPrimary, onClick,
}: {
  name: string; category: string; isPrimary?: boolean; onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "flex flex-col items-center gap-1.5 min-w-[80px] max-w-[100px] group transition-all",
        onClick ? "cursor-pointer" : "cursor-default"
      )}
    >
      <div className={cn(
        "w-12 h-12 rounded-2xl flex items-center justify-center border-2 transition-all shadow-sm",
        isPrimary
          ? "bg-primary/20 border-primary/50 shadow-primary/10 shadow-md"
          : "bg-muted/30 border-border/40 group-hover:border-primary/30 group-hover:bg-primary/10"
      )}>
        <Shield className={cn("w-5 h-5", isPrimary ? "text-primary" : "text-muted-foreground/60 group-hover:text-primary/60 transition-colors")} />
      </div>
      <div className="text-center">
        <p className={cn(
          "font-mono text-[9px] font-bold leading-tight max-w-[90px] truncate",
          isPrimary ? "text-primary" : "text-foreground/80 group-hover:text-primary transition-colors"
        )}>
          {name}
        </p>
        <p className="font-mono text-[8px] text-muted-foreground/40">{category}</p>
      </div>
      {isPrimary && (
        <span className="font-mono text-[7px] uppercase tracking-wider text-primary/60 bg-primary/10 border border-primary/20 rounded px-1.5 py-0.5">
          Source
        </span>
      )}
    </button>
  );
}

// ── Edge — the connector line + relation badge ────────────────────────────────
function RelationEdge({ relation_type }: { relation_type: string }) {
  const meta = RELATION_META[relation_type] ?? RELATION_META.other;
  const Icon = meta.icon;
  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0 px-1">
      <div className="h-px w-8 bg-border/30" />
      <div className={cn("w-8 h-8 rounded-full flex items-center justify-center border shadow-sm", meta.bgColor, meta.borderColor)}>
        <Icon className={cn("w-3.5 h-3.5", meta.color)} />
      </div>
      <div className="h-px w-8 bg-border/30" />
      <span className={cn("font-mono text-[7px] font-bold uppercase tracking-wider text-center leading-tight max-w-[56px]", meta.color)}>
        {meta.label}
      </span>
    </div>
  );
}

// ── Full visual relationship card ─────────────────────────────────────────────
function RelationshipCard({
  link, onNavigate,
}: {
  link: EntityLink;
  onNavigate: (id: number) => void;
}) {
  const meta = RELATION_META[link.relation_type] ?? RELATION_META.other;
  return (
    <div className={cn("rounded-xl border overflow-hidden", meta.borderColor, meta.bgColor)}>
      {/* Visual diagram */}
      <div className="flex items-center justify-center gap-2 p-5">
        <EntityNode
          name={link.entity_name}
          category={link.entity_category}
          isPrimary
        />
        <RelationEdge relation_type={link.relation_type} />
        <EntityNode
          name={link.linked_entity_name}
          category={link.linked_entity_category}
          onClick={() => onNavigate(link.linked_entity_id)}
        />
      </div>

      {/* Footer — note + open link */}
      {(link.note || true) && (
        <div className="border-t border-border/20 px-4 py-2.5 flex items-center justify-between gap-3">
          <p className="font-mono text-[9px] text-muted-foreground/50 flex-1 min-w-0 truncate">
            {link.note ?? `${link.entity_name} ${meta.label.toLowerCase()} ${link.linked_entity_name}`}
          </p>
          <button
            onClick={() => onNavigate(link.linked_entity_id)}
            className={cn(
              "flex items-center gap-1 font-mono text-[9px] font-bold transition-colors flex-shrink-0",
              meta.color
            )}
          >
            Open {link.linked_entity_name}
            <ChevronRight className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
}

export default function VaultEnrollmentLinkedDetail() {
  const params = useParams<{ entityId: string }>();
  const entityId = Number(params.entityId);
  const [, navigate] = useLocation();

  const [links, setLinks] = useState<EntityLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!entityId) return;
    setLoading(true);
    setError(false);
    try {
      const all = await customFetch<EntityLink[]>("/api/vault/links/all");
      const filtered = Array.isArray(all)
        ? all.filter(l => l.entity_id === entityId)
        : [];
      setLinks(filtered);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [entityId]);

  useEffect(() => { load(); }, [load]);

  const entityName = links[0]?.entity_name ?? `Entity #${entityId}`;
  const entityCategory = links[0]?.entity_category ?? "";

  return (
    <VaultSectionPage
      title={entityName}
      description="Visual relationship map — all links for this entity"
      icon={Link2}
    >
      {/* Back + open entity */}
      <div className="mb-4 flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/vault/enrollment/linked")}
          className="font-mono text-xs text-muted-foreground/60 hover:text-foreground gap-1.5 pl-1"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          All Linked
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/vault/entity/${entityId}`)}
          className="font-mono text-xs gap-1.5"
        >
          <Shield className="w-3 h-3" />
          Open Entity
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <AlertCircle className="w-8 h-8 text-red-400/50" />
          <p className="font-mono text-xs text-muted-foreground/50">Failed to load links</p>
          <Button variant="outline" size="sm" onClick={load} className="font-mono text-xs">Retry</Button>
        </div>
      ) : links.length === 0 ? (
        <div className="text-center py-20 space-y-3 border border-dashed border-border/40 rounded-xl">
          <div className="w-14 h-14 rounded-2xl bg-primary/5 border border-primary/10 flex items-center justify-center mx-auto">
            <Link2 className="w-6 h-6 text-primary/40" />
          </div>
          <p className="font-mono text-sm text-muted-foreground/60">No links for {entityName}</p>
          <p className="font-mono text-[10px] text-muted-foreground/40 max-w-xs mx-auto">
            Add links from the entity's detail page — mark alts, shared wallets, IPs, and more.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Entity identity header */}
          <div className="flex items-center gap-3 p-3.5 bg-card border border-primary/15 rounded-xl">
            <div className="w-9 h-9 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
              <Shield className="w-4.5 h-4.5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-mono text-xs font-bold text-primary truncate">{entityName}</p>
              <p className="font-mono text-[9px] text-muted-foreground/50">{entityCategory}</p>
            </div>
            <Badge variant="outline" className="font-mono text-[9px] text-primary/70 border-primary/20 bg-primary/5 flex-shrink-0">
              {links.length} link{links.length === 1 ? "" : "s"}
            </Badge>
          </div>

          {/* Section label */}
          <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 px-1">
            Relationship Map
          </p>

          {/* Visual relationship cards */}
          <div className="space-y-3">
            {links.map(link => (
              <RelationshipCard
                key={link.id}
                link={link}
                onNavigate={id => navigate(`/vault/entity/${id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </VaultSectionPage>
  );
}
