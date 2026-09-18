/**
 * vault-enrollment-linked.tsx
 * ─────────────────────────────────────────────
 * Enrollment → Linked: shows all vault entity links grouped by source entity.
 * Clicking an entity navigates to /vault/enrollment/linked/:entityId which
 * shows the full visual relationship diagram for that entity.
 */
import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Link2, Loader2, Shield, ChevronRight, GitFork, Wallet, Mail, Cpu, Monitor, User2 } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface AllLink {
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

const RELATION_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  alt_of:        { label: "Alt of",        icon: GitFork,  color: "text-violet-400" },
  main_of:       { label: "Main of",       icon: GitFork,  color: "text-cyan-400" },
  shares_wallet: { label: "Shares Wallet", icon: Wallet,   color: "text-amber-400" },
  shares_email:  { label: "Shares Email",  icon: Mail,     color: "text-emerald-400" },
  shares_ip:     { label: "Shares IP",     icon: Cpu,      color: "text-orange-400" },
  shares_device: { label: "Shares Device", icon: Monitor,  color: "text-blue-400" },
  same_owner:    { label: "Same Owner",    icon: User2,    color: "text-pink-400" },
  other:         { label: "Linked",        icon: Link2,    color: "text-muted-foreground" },
};

// Compact pill showing relation type used in the entity card preview
function RelationPill({ relation_type }: { relation_type: string }) {
  const meta = RELATION_META[relation_type] ?? RELATION_META.other;
  const Icon = meta.icon;
  return (
    <div className={cn("flex items-center gap-1 font-mono text-[8px] font-bold", meta.color)}>
      <Icon className="w-2.5 h-2.5 flex-shrink-0" />
      {meta.label}
    </div>
  );
}

export default function VaultEnrollmentLinked() {
  const [, navigate] = useLocation();
  const [links, setLinks] = useState<AllLink[]>([]);
  const [loading, setLoading] = useState(true);

  const loadLinks = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await customFetch<AllLink[]>("/api/vault/links/all");
      setLinks(Array.isArray(rows) ? rows : []);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  // Group by entity_id (the "from" side)
  const grouped = new Map<number, { name: string; category: string; links: AllLink[] }>();
  for (const link of links) {
    if (!grouped.has(link.entity_id)) {
      grouped.set(link.entity_id, { name: link.entity_name, category: link.entity_category, links: [] });
    }
    grouped.get(link.entity_id)!.links.push(link);
  }

  return (
    <VaultSectionPage
      title="Linked"
      description="Networked entity relationships — click an entity to view its relationship map"
      icon={Link2}
    >
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : grouped.size === 0 ? (
        <VaultSectionEmptyState
          icon={Link2}
          title="No linked entities"
          note="Link entities from an entity's detail page — mark alts, shared wallets, shared IPs, and more."
        />
      ) : (
        <div className="space-y-2">
          {[...grouped.entries()].map(([entityId, { name, category, links: eLinks }]) => (
            <button
              key={entityId}
              onClick={() => navigate(`/vault/enrollment/linked/${entityId}`)}
              className="w-full bg-card border border-card-border rounded-xl p-3.5 flex items-center gap-3 hover:border-primary/30 hover:bg-primary/5 transition-all text-left group"
            >
              <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/15 flex items-center justify-center flex-shrink-0 group-hover:bg-primary/20 group-hover:border-primary/30 transition-colors">
                <Shield className="w-4 h-4 text-primary/70 group-hover:text-primary transition-colors" />
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs font-bold text-foreground truncate group-hover:text-primary transition-colors">
                  {name}
                </p>
                <p className="font-mono text-[9px] text-muted-foreground/50 mt-0.5">{category}</p>
                {/* Relation type preview pills */}
                <div className="flex flex-wrap gap-2 mt-1.5">
                  {eLinks.slice(0, 3).map(l => (
                    <RelationPill key={l.id} relation_type={l.relation_type} />
                  ))}
                  {eLinks.length > 3 && (
                    <span className="font-mono text-[8px] text-muted-foreground/40">
                      +{eLinks.length - 3} more
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <Badge variant="outline" className="font-mono text-[9px] text-primary/70 border-primary/20 bg-primary/5">
                  {eLinks.length} link{eLinks.length === 1 ? "" : "s"}
                </Badge>
                <span className="font-mono text-[8px] text-muted-foreground/30 flex items-center gap-0.5">
                  View map <ChevronRight className="w-2.5 h-2.5" />
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </VaultSectionPage>
  );
}
