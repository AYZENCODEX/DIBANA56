/**
 * components/vault/linked-entities-section.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * "Linked Entities" section for vault-entity-detail.tsx — airdrop farming
 * setups have one main account plus multiple alt accounts, each stored as an
 * independent vault_entries row. This lets the user mark the relationship
 * explicitly ("alt of X", "shares wallet with Y") and see it both as a list
 * and as a small radial graph. Backed by routes/vault-entity-links.ts.
 *
 * No graph library dependency — a plain SVG radial layout is enough for the
 * handful of alt accounts a farming entity typically has. Swap in React Flow
 * later if this needs pan/zoom/drag for larger link counts.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Network, Link2, Plus, Trash2, Loader2, Search, X } from "lucide-react";
import { useListVaultEntries } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  listEntityLinks, createEntityLink, deleteEntityLink,
  RELATION_TYPES, RELATION_LABELS, type RelationType, type EntityLink,
} from "@/lib/vault-entity-links-api";

const RELATION_COLOR: Record<RelationType, string> = {
  alt_of: "text-cyan-400 border-cyan-400/20 bg-cyan-400/5",
  main_of: "text-cyan-400 border-cyan-400/20 bg-cyan-400/5",
  shares_wallet: "text-amber-400 border-amber-400/20 bg-amber-400/5",
  shares_email: "text-sky-400 border-sky-400/20 bg-sky-400/5",
  shares_ip: "text-orange-400 border-orange-400/20 bg-orange-400/5",
  shares_device: "text-purple-400 border-purple-400/20 bg-purple-400/5",
  same_owner: "text-emerald-400 border-emerald-400/20 bg-emerald-400/5",
  other: "text-muted-foreground border-border bg-muted/20",
};

function entityLabel(e: any): string {
  return e?.projectName || e?.username || `Entity #${e?.id}`;
}

function LinkGraph({ centerLabel, links }: { centerLabel: string; links: EntityLink[] }) {
  const width = 320;
  const height = 220;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 46;

  const nodes = links.map((l, i) => {
    const angle = (i / Math.max(links.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return {
      link: l,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto max-w-md mx-auto">
      {nodes.map(({ link, x, y }) => (
        <g key={link.id}>
          <line x1={cx} y1={cy} x2={x} y2={y} stroke="currentColor" className="text-border" strokeWidth={1} />
          <text
            x={(cx + x) / 2}
            y={(cy + y) / 2 - 4}
            textAnchor="middle"
            className="fill-muted-foreground/60 font-mono"
            fontSize={7}
          >
            {RELATION_LABELS[link.relationType]}
          </text>
        </g>
      ))}
      {nodes.map(({ link, x, y }) => (
        <g key={`node-${link.id}`}>
          <circle cx={x} cy={y} r={20} className="fill-card stroke-border" strokeWidth={1} />
          <text x={x} y={y + 3} textAnchor="middle" className="fill-foreground font-mono" fontSize={7}>
            {link.linkedEntity.label.slice(0, 10)}
          </text>
        </g>
      ))}
      <circle cx={cx} cy={cy} r={26} className="fill-primary/10 stroke-primary" strokeWidth={1.5} />
      <text x={cx} y={cy + 3} textAnchor="middle" className="fill-primary font-mono font-bold" fontSize={8}>
        {centerLabel.slice(0, 12)}
      </text>
    </svg>
  );
}

export function LinkedEntitiesSection({ entityId }: { entityId: number }) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [links, setLinks] = useState<EntityLink[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [targetId, setTargetId] = useState<number | null>(null);
  const [relationType, setRelationType] = useState<RelationType>("alt_of");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: allEntries } = useListVaultEntries();

  async function refresh() {
    setLoading(true);
    try {
      const rows = await listEntityLinks(entityId);
      setLinks(rows);
    } catch {
      setLinks([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entityId]);

  const alreadyLinkedIds = useMemo(
    () => new Set((links ?? []).map(l => l.linkedEntity.id)),
    [links]
  );

  const candidates = useMemo(() => {
    const list: any[] = Array.isArray(allEntries) ? allEntries : [];
    const q = search.trim().toLowerCase();
    return list
      .filter(e => e.id !== entityId && !alreadyLinkedIds.has(e.id))
      .filter(e => !q || entityLabel(e).toLowerCase().includes(q))
      .slice(0, 20);
  }, [allEntries, search, entityId, alreadyLinkedIds]);

  function openDialog() {
    setSearch("");
    setTargetId(null);
    setRelationType("alt_of");
    setNote("");
    setDialogOpen(true);
  }

  async function handleCreate() {
    if (!targetId) return;
    setSaving(true);
    try {
      await createEntityLink({ entityId, linkedEntityId: targetId, relationType, note: note.trim() || undefined });
      toast({ title: "Entity linked" });
      setDialogOpen(false);
      refresh();
    } catch (err: any) {
      toast({ title: "Failed to link entity", description: err?.message ?? "Try again", variant: "destructive" as any });
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(link: EntityLink) {
    try {
      await deleteEntityLink(link.id);
      setLinks(prev => (prev ?? []).filter(l => l.id !== link.id));
      toast({ title: "Link removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove link", description: err?.message ?? "Try again", variant: "destructive" as any });
    }
  }

  return (
    <div className="bg-card border border-card-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-primary" />
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">
            Linked Entities{links && links.length > 0 ? ` (${links.length})` : ""}
          </span>
        </div>
        <Button size="sm" variant="outline" className="h-7 font-mono text-[10px] gap-1" onClick={openDialog}>
          <Plus className="w-3 h-3" /> Link Entity
        </Button>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-6 text-muted-foreground/40">
          <Loader2 className="w-4 h-4 animate-spin" />
        </div>
      )}

      {!loading && links && links.length === 0 && (
        <p className="font-mono text-[10px] text-muted-foreground/40 text-center py-4">
          No linked entities yet — mark alts, shared wallets, or shared owners here.
        </p>
      )}

      {!loading && links && links.length > 0 && (
        <div className="space-y-4">
          <div className="hidden sm:flex items-center justify-center py-2 border border-border/30 rounded-lg bg-muted/10">
            <Network className="w-3 h-3 text-muted-foreground/30 absolute" />
            <LinkGraph centerLabel="This entity" links={links} />
          </div>

          <div className="space-y-1.5">
            {links.map(link => (
              <div
                key={link.id}
                className="flex items-center gap-2 rounded-lg px-3 py-2 border border-border/30 bg-muted/10"
              >
                <span className={cn("font-mono text-[9px] px-1.5 py-0.5 rounded border flex-shrink-0", RELATION_COLOR[link.relationType])}>
                  {RELATION_LABELS[link.relationType]}
                </span>
                <button
                  className="font-mono text-[11px] text-foreground/80 hover:text-primary truncate text-left flex-1"
                  onClick={() => setLocation(`/vault/entity/${link.linkedEntity.id}`)}
                >
                  {link.linkedEntity.label}
                </button>
                {link.note && (
                  <span className="font-mono text-[9px] text-muted-foreground/40 truncate max-w-[120px] hidden sm:inline">
                    {link.note}
                  </span>
                )}
                <button
                  className="text-muted-foreground/30 hover:text-red-400 flex-shrink-0"
                  onClick={() => handleRemove(link)}
                  title="Remove link"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">Link Entity</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-1.5 block">
                Relationship
              </label>
              <Select value={relationType} onValueChange={(v) => setRelationType(v as RelationType)}>
                <SelectTrigger className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RELATION_TYPES.map(rt => (
                    <SelectItem key={rt} value={rt} className="font-mono text-xs">{RELATION_LABELS[rt]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-1.5 block">
                Target entity
              </label>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search your entities..."
                  className="pl-8 font-mono text-xs"
                />
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto space-y-1 border border-border/30 rounded-lg p-1.5">
                {candidates.length === 0 && (
                  <p className="font-mono text-[10px] text-muted-foreground/40 text-center py-3">No matches</p>
                )}
                {candidates.map(e => (
                  <button
                    key={e.id}
                    onClick={() => setTargetId(e.id)}
                    className={cn(
                      "w-full text-left px-2.5 py-1.5 rounded font-mono text-[11px] flex items-center justify-between",
                      targetId === e.id ? "bg-primary/10 text-primary border border-primary/30" : "hover:bg-muted/20 text-foreground/70 border border-transparent"
                    )}
                  >
                    {entityLabel(e)}
                    {targetId === e.id && <X className="w-3 h-3" onClick={(ev) => { ev.stopPropagation(); setTargetId(null); }} />}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 mb-1.5 block">
                Note (optional)
              </label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. same seed phrase, funded from same wallet"
                className="font-mono text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!targetId || saving} onClick={handleCreate}>
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
