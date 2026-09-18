import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Layers, Plus, Trash2, Edit2, ChevronRight, ChevronDown,
  Loader2, Tag, Globe, Lock,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Category = { id: number; name: string; type: string; parent_id: number | null; is_custom: boolean };
type Template = { id: number; name: string; type: string; sub_categories: any; is_global: boolean };

const TYPES = ["exchange", "instant", "web3", "content", "local", "other"];
const TYPE_COLORS: Record<string, string> = {
  exchange: "text-cyan-400 border-cyan-400/20 bg-cyan-400/5",
  instant: "text-violet-400 border-violet-400/20 bg-violet-400/5",
  web3: "text-emerald-400 border-emerald-400/20 bg-emerald-400/5",
  content: "text-orange-400 border-orange-400/20 bg-orange-400/5",
  local: "text-blue-400 border-blue-400/20 bg-blue-400/5",
  other: "text-muted-foreground border-border bg-muted/10",
};

function CatRow({ cat, children, onEdit, onDelete }: { cat: Category; children?: React.ReactNode; onEdit: (c: Category) => void; onDelete: (id: number) => void }) {
  const [open, setOpen] = useState(false);
  const hasChildren = !!children && (children as any[]).length > 0;
  return (
    <div>
      <div className="flex items-center gap-2 p-2.5 rounded hover:bg-muted/20 group/row">
        <button onClick={() => setOpen(o => !o)} className="text-muted-foreground/40 w-4">
          {hasChildren ? (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : null}
        </button>
        <Tag className="w-3.5 h-3.5 text-muted-foreground/50 flex-shrink-0" />
        <span className="text-sm text-foreground flex-1">{cat.name}</span>
        <Badge variant="outline" className={cn("text-[10px] capitalize", TYPE_COLORS[cat.type] ?? TYPE_COLORS.other)}>{cat.type}</Badge>
        {cat.is_custom && <Lock className="w-3 h-3 text-muted-foreground/30" />}
        <div className="flex gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
          <button onClick={() => onEdit(cat)} className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"><Edit2 className="w-3 h-3" /></button>
          <button onClick={() => onDelete(cat.id)} className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>
      {open && children && <div className="ml-8 border-l border-border/30 pl-2">{children}</div>}
    </div>
  );
}

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"categories" | "templates">("categories");
  const [filterType, setFilterType] = useState("all");
  const [catDialog, setCatDialog] = useState(false);
  const [tmplDialog, setTmplDialog] = useState(false);
  const [editCat, setEditCat] = useState<Category | null>(null);
  const [catName, setCatName] = useState("");
  const [catType, setCatType] = useState("exchange");
  const [catParent, setCatParent] = useState<string>("none");
  const [tmplName, setTmplName] = useState("");
  const [tmplType, setTmplType] = useState("exchange");
  const [tmplSubs, setTmplSubs] = useState("");
  const [tmplGlobal, setTmplGlobal] = useState(true);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const [cats, tmpls] = await Promise.all([
        customFetch<Category[]>("/categories/all").catch(() => []),
        customFetch<Template[]>("/category-templates").catch(() => []),
      ]);
      setCategories(Array.isArray(cats) ? cats : []);
      setTemplates(Array.isArray(tmpls) ? tmpls : []);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditCat(null); setCatName(""); setCatType("exchange"); setCatParent("none"); setCatDialog(true); };
  const openEdit = (cat: Category) => { setEditCat(cat); setCatName(cat.name); setCatType(cat.type); setCatParent(cat.parent_id ? String(cat.parent_id) : "none"); setCatDialog(true); };

  const saveCategory = async () => {
    if (!catName.trim()) return;
    setSaving(true);
    try {
      const body = { name: catName.trim(), type: catType, parentId: catParent !== "none" ? parseInt(catParent) : undefined };
      if (editCat) {
        await customFetch(`/categories/${editCat.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast({ title: "Category updated" });
      } else {
        await customFetch("/categories", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Category created" });
      }
      setCatDialog(false);
      await load();
    } catch { toast({ title: "Failed to save", variant: "destructive" }); } finally { setSaving(false); }
  };

  const deleteCategory = async (id: number) => {
    if (!confirm("Delete this category?")) return;
    try {
      await customFetch(`/categories/${id}`, { method: "DELETE" });
      toast({ title: "Deleted" });
      await load();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const saveTemplate = async () => {
    if (!tmplName.trim()) return;
    setSaving(true);
    try {
      let subCats: any[] = [];
      try { subCats = tmplSubs.split("\n").map(s => s.trim()).filter(Boolean).map(s => ({ name: s })); } catch {}
      await customFetch("/category-templates", { method: "POST", body: JSON.stringify({ name: tmplName.trim(), type: tmplType, subCategories: subCats, isGlobal: tmplGlobal }) });
      toast({ title: "Template created" });
      setTmplDialog(false);
      await load();
    } catch { toast({ title: "Failed to save", variant: "destructive" }); } finally { setSaving(false); }
  };

  const deleteTemplate = async (id: number) => {
    try {
      await customFetch(`/category-templates/${id}`, { method: "DELETE" });
      toast({ title: "Deleted" });
      await load();
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const filtered = filterType === "all" ? categories : categories.filter(c => c.type === filterType);
  const roots = filtered.filter(c => !c.parent_id);
  const childrenOf = (id: number) => categories.filter(c => c.parent_id === id);
  const parentCats = categories.filter(c => !c.parent_id);

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Layers className="w-5 h-5 text-primary" /> Categories</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage project categories, sub-categories, and templates — used across projects, vault, and local accounts.</p>
        </div>
        <Button size="sm" onClick={tab === "categories" ? openCreate : () => setTmplDialog(true)} className="h-9 gap-2">
          <Plus className="w-4 h-4" /> {tab === "categories" ? "New Category" : "New Template"}
        </Button>
      </div>

      <div className="flex gap-1 border-b border-border/40">
        {(["categories", "templates"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={cn("px-4 py-2.5 text-sm font-medium capitalize transition-all border-b-2 -mb-px",
              tab === t ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
            {t === "categories" ? `Categories (${categories.length})` : `Templates (${templates.length})`}
          </button>
        ))}
      </div>

      {tab === "categories" && (
        <div className="space-y-3">
          <div className="flex gap-2 items-center">
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="h-8 text-xs bg-background/50 w-36">
                <SelectValue placeholder="All types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">{filtered.length} categor{filtered.length !== 1 ? "ies" : "y"}</span>
          </div>

          {loading ? <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            : roots.length === 0 ? <div className="text-center py-12 text-sm text-muted-foreground">No categories yet. Create one to get started.</div>
            : (
              <div className="bg-card/60 border border-border/40 rounded-lg p-2 space-y-0.5">
                {roots.map(cat => {
                  const kids = childrenOf(cat.id);
                  return (
                    <CatRow key={cat.id} cat={cat} onEdit={openEdit} onDelete={deleteCategory}>
                      {kids.map(k => <CatRow key={k.id} cat={k} onEdit={openEdit} onDelete={deleteCategory} />)}
                    </CatRow>
                  );
                })}
              </div>
            )}
        </div>
      )}

      {tab === "templates" && (
        <div className="space-y-3">
          {loading ? <div className="flex items-center justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            : templates.length === 0 ? <div className="text-center py-12 text-sm text-muted-foreground">No templates yet.</div>
            : (
              <div className="space-y-2">
                {templates.map(t => (
                  <div key={t.id} className="flex items-start gap-3 p-4 bg-card/60 border border-border/40 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-foreground">{t.name}</span>
                        <Badge variant="outline" className={cn("text-[10px] capitalize", TYPE_COLORS[t.type] ?? TYPE_COLORS.other)}>{t.type}</Badge>
                        {t.is_global ? <Globe className="w-3 h-3 text-emerald-400" /> : <Lock className="w-3 h-3 text-muted-foreground/40" />}
                      </div>
                      {Array.isArray(t.sub_categories) && t.sub_categories.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {t.sub_categories.slice(0, 8).map((s: any, i: number) => (
                            <span key={i} className="px-1.5 py-0.5 bg-muted/30 rounded text-[10px] text-muted-foreground">{s.name ?? s}</span>
                          ))}
                          {t.sub_categories.length > 8 && <span className="text-[10px] text-muted-foreground">+{t.sub_categories.length - 8}</span>}
                        </div>
                      )}
                    </div>
                    <button onClick={() => deleteTemplate(t.id)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
        </div>
      )}

      {/* Category dialog */}
      <Dialog open={catDialog} onOpenChange={setCatDialog}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Tag className="w-4 h-4 text-primary" /> {editCat ? "Edit" : "New"} Category</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input value={catName} onChange={e => setCatName(e.target.value)} placeholder="Category name" className="h-9 text-sm bg-background/50" autoFocus />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select value={catType} onValueChange={setCatType}>
                <SelectTrigger className="h-9 text-sm bg-background/50"><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Parent (optional)</label>
              <Select value={catParent} onValueChange={setCatParent}>
                <SelectTrigger className="h-9 text-sm bg-background/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None (root category)</SelectItem>
                  {parentCats.filter(c => !editCat || c.id !== editCat.id).map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name} ({c.type})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCatDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={saveCategory} disabled={saving || !catName.trim()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Template dialog */}
      <Dialog open={tmplDialog} onOpenChange={setTmplDialog}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Layers className="w-4 h-4 text-primary" /> New Template</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Name</label>
              <Input value={tmplName} onChange={e => setTmplName(e.target.value)} placeholder="Template name" className="h-9 text-sm bg-background/50" autoFocus />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select value={tmplType} onValueChange={setTmplType}>
                <SelectTrigger className="h-9 text-sm bg-background/50"><SelectValue /></SelectTrigger>
                <SelectContent>{TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Sub-categories (one per line)</label>
              <textarea value={tmplSubs} onChange={e => setTmplSubs(e.target.value)} placeholder="CandyDrop&#10;CandyBomb&#10;Booster" className="w-full min-h-[80px] text-sm bg-background/50 border border-input rounded-md px-3 py-2 resize-none" />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={tmplGlobal} onChange={e => setTmplGlobal(e.target.checked)} className="w-3.5 h-3.5" />
              <span className="text-xs text-muted-foreground">Make global (visible to all users)</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setTmplDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={saveTemplate} disabled={saving || !tmplName.trim()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
