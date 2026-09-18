import { useState, useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Boxes, Plus, Edit2, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { getNftCategoryIcon, NFT_CATEGORY_ICONS } from "@/config/marketplace-nft";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface MarketCategory {
  id: number;
  name: string;
  label: string;
  color: string;
  icon: string;
  is_active: boolean;
  created_at: string;
}

const COLOR_OPTIONS = [
  "text-cyan-400", "text-teal-400", "text-violet-400", "text-amber-400",
  "text-emerald-400", "text-red-400", "text-blue-400", "text-primary",
];

const ICON_OPTIONS = Object.keys(NFT_CATEGORY_ICONS);

/**
 * AZN / NFT Market category management — create, edit (label / color /
 * icon), and activate/deactivate the categories that power the buy/sell
 * dropdown on pages/user/nft-marketplace.tsx. Backed by
 * nft_market_categories (routes/nft-subscriptions.ts + the admin-only
 * list/patch endpoints added alongside this page).
 */
export default function AdminMarketplaceCategories() {
  const { token } = useAuth();
  const { toast } = useToast();

  const [categories, setCategories] = useState<MarketCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MarketCategory | null>(null);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [icon, setIcon] = useState(ICON_OPTIONS[0]);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/admin/nft-market-categories`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setCategories(await r.json());
      else toast({ title: "Couldn't load categories", variant: "destructive" });
    } catch (e: any) {
      toast({ title: "Couldn't load categories", description: e?.message, variant: "destructive" });
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [token]);

  const openCreate = () => {
    setEditing(null);
    setName(""); setLabel(""); setColor(COLOR_OPTIONS[0]); setIcon(ICON_OPTIONS[0]);
    setDialogOpen(true);
  };

  const openEdit = (cat: MarketCategory) => {
    setEditing(cat);
    setName(cat.name); setLabel(cat.label); setColor(cat.color); setIcon(cat.icon);
    setDialogOpen(true);
  };

  const save = async () => {
    if (!label.trim() || !token) return;
    setSaving(true);
    try {
      if (editing) {
        const r = await fetch(`${BASE}/api/admin/nft-market-categories/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ label: label.trim(), color, icon }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to save");
        toast({ title: "Category updated" });
      } else {
        const slug = (name.trim() || label.trim()).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
        const r = await fetch(`${BASE}/api/nft-subscriptions/categories`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: slug, label: label.trim(), color, icon }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? "Failed to create");
        toast({ title: "Category created" });
      }
      setDialogOpen(false);
      await load();
    } catch (e: any) {
      toast({ title: "Couldn't save category", description: e?.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const toggleActive = async (cat: MarketCategory) => {
    if (!token) return;
    try {
      const r = await fetch(`${BASE}/api/admin/nft-market-categories/${cat.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_active: !cat.is_active }),
      });
      if (!r.ok) throw new Error("Failed to update");
      setCategories(prev => prev.map(c => c.id === cat.id ? { ...c, is_active: !c.is_active } : c));
    } catch (e: any) {
      toast({ title: "Couldn't update category", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
            <Boxes className="w-5 h-5 text-primary" /> Market Categories
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Categories buyers/sellers pick from on the AZN &amp; NFT market listing form.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={load} className="h-8 gap-1.5 text-xs">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
          <Button size="sm" onClick={openCreate} className="h-8 gap-1.5 text-xs">
            <Plus className="w-3.5 h-3.5" /> New Category
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : categories.length === 0 ? (
        <div className="text-center py-12 text-sm text-muted-foreground">No categories yet. Create one to get started.</div>
      ) : (
        <div className="bg-card/60 border border-border/40 rounded-lg divide-y divide-border/30">
          {categories.map(cat => {
            const Icon = getNftCategoryIcon(cat.icon);
            return (
              <div key={cat.id} className={cn("flex items-center gap-3 p-3", !cat.is_active && "opacity-50")}>
                <div className={cn("w-8 h-8 rounded-lg bg-muted/30 flex items-center justify-center flex-shrink-0", cat.color)}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{cat.label}</span>
                    <Badge variant="outline" className="text-[10px] font-mono text-muted-foreground/70">{cat.name}</Badge>
                    {!cat.is_active && <Badge variant="outline" className="text-[10px] text-muted-foreground">Inactive</Badge>}
                  </div>
                </div>
                <Switch checked={cat.is_active} onCheckedChange={() => toggleActive(cat)} />
                <button onClick={() => openEdit(cat)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Boxes className="w-4 h-4 text-primary" /> {editing ? "Edit" : "New"} Category
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Display label</label>
              <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Username NFT" className="h-9 text-sm bg-background/50" autoFocus />
            </div>
            {!editing && (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Internal name (slug — auto if left blank)</label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="username_nft" className="h-9 text-sm bg-background/50 font-mono" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Icon</label>
                <Select value={icon} onValueChange={setIcon}>
                  <SelectTrigger className="h-9 text-sm bg-background/50"><SelectValue /></SelectTrigger>
                  <SelectContent>{ICON_OPTIONS.map(i => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Color</label>
                <Select value={color} onValueChange={setColor}>
                  <SelectTrigger className="h-9 text-sm bg-background/50">
                    <SelectValue>
                      <span className="flex items-center gap-1.5"><span className={cn("w-2.5 h-2.5 rounded-full bg-current", color)} />{color.replace("text-", "").replace("-400", "")}</span>
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {COLOR_OPTIONS.map(c => (
                      <SelectItem key={c} value={c}>
                        <span className="flex items-center gap-1.5"><span className={cn("w-2.5 h-2.5 rounded-full bg-current", c)} />{c.replace("text-", "").replace("-400", "")}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving || !label.trim()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
