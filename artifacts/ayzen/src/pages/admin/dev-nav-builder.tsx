import { useState } from "react";
import { useNavConfig, type DevNavTreeLeaf, type NavType } from "@/hooks/use-dev-nav";
import { DEV_NAV_ICON_NAMES, resolveDevNavIcon } from "@/lib/dev-nav-icons";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  LayoutList, Plus, Trash2, Edit2, ChevronRight, ChevronDown,
  Loader2, ExternalLink, FileText,
} from "lucide-react";

const LEVEL_LABEL: Record<number, string> = {
  1: "Category", 2: "Section / link", 3: "Sub-item", 4: "Sub-sub-item", 5: "Deepest item",
};
const MAX_NAV_LEVEL = 5;

const NAV_TYPE_LABEL: Record<NavType, string> = {
  dev: "Dev", user: "User", admin: "Admin", moderator: "Moderator", team_leader: "Team Leader",
};
const NAV_TYPE_ORDER: NavType[] = ["dev", "user", "admin", "moderator", "team_leader"];

interface EditState {
  mode: "create" | "edit";
  parentId?: number;
  level: number;
  id?: number;
  label: string;
  icon: string;
  href: string;
}

function NavRow({ node, onAddChild, onEdit, onDelete, onToggle }: {
  node: DevNavTreeLeaf;
  onAddChild?: (parent: DevNavTreeLeaf) => void;
  onEdit: (node: DevNavTreeLeaf) => void;
  onDelete: (node: DevNavTreeLeaf) => void;
  onToggle: (node: DevNavTreeLeaf, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const Icon = resolveDevNavIcon(node.icon);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className={cn(
        "flex items-center gap-2 p-2.5 rounded-lg hover:bg-muted/20 group/row border border-transparent",
        !node.enabled && "opacity-50"
      )}>
        <button onClick={() => setOpen(o => !o)} className="text-muted-foreground/40 w-4 flex-shrink-0" disabled={!hasChildren}>
          {hasChildren ? (open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />) : null}
        </button>
        <Icon className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
        <span className="text-sm font-mono flex-1 truncate">{node.label}</span>
        {node.href && (
          <a href={node.href} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground/50 font-mono hidden sm:flex items-center gap-1 hover:text-primary">
            {node.href} <ExternalLink className="w-2.5 h-2.5" />
          </a>
        )}
        <Badge variant="outline" className="text-[9px] font-mono">{LEVEL_LABEL[node.level]}</Badge>
        <Switch checked={node.enabled} onCheckedChange={(v) => onToggle(node, v)} />
        <div className="flex gap-1">
          {node.level < MAX_NAV_LEVEL && onAddChild && (
            <button onClick={() => onAddChild(node)} title="Add sub-item" className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors">
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
          <button onClick={() => onEdit(node)} className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors">
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => onDelete(node)} className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {open && hasChildren && (
        <div className="ml-6 border-l border-border/30 pl-3 space-y-0.5">
          {node.children.map(child => (
            <NavRow key={child.id} node={child} onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminDevNavBuilder() {
  const [navType, setNavType] = useState<NavType>("dev");
  const { tree, isLoading, addItem, updateItem, removeItem } = useNavConfig(navType);
  const { toast } = useToast();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DevNavTreeLeaf | null>(null);

  const openCreate = (level: number, parent?: DevNavTreeLeaf) => {
    setEdit({ mode: "create", parentId: parent?.id, level, label: "", icon: "Circle", href: "" });
  };
  const openEdit = (node: DevNavTreeLeaf) => {
    setEdit({ mode: "edit", id: node.id, level: node.level, label: node.label, icon: node.icon, href: node.href ?? "" });
  };

  const save = async () => {
    if (!edit || !edit.label.trim()) return;
    setSaving(true);
    try {
      if (edit.mode === "create") {
        const created = await addItem({ parentId: edit.parentId, label: edit.label.trim(), icon: edit.icon, href: edit.href.trim() || undefined });
        if (created) {
          toast({ title: "Sidebar item added", description: created.href ? `Ready at ${created.href}` : "Added." });
        } else {
          toast({ title: "Couldn't add item", variant: "destructive" });
        }
      } else if (edit.id) {
        const result = await updateItem(edit.id, { label: edit.label.trim(), icon: edit.icon, href: edit.href.trim() || undefined });
        if (result.ok) toast({ title: "Sidebar item updated" });
        else { toast({ title: "Couldn't save changes", description: result.error, variant: "destructive" }); return; }
      }
      setEdit(null);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (node: DevNavTreeLeaf, enabled: boolean) => {
    const result = await updateItem(node.id, { enabled });
    if (!result.ok) toast({ title: "Couldn't toggle item", description: result.error, variant: "destructive" });
  };

  const confirmedDelete = async () => {
    if (!confirmDelete) return;
    const result = await removeItem(confirmDelete.id);
    if (result.ok) toast({ title: `${LEVEL_LABEL[confirmDelete.level]} removed` });
    else toast({ title: "Couldn't remove item", description: result.error, variant: "destructive" });
    setConfirmDelete(null);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <LayoutList className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg font-mono font-semibold">{NAV_TYPE_LABEL[navType]} Sidebar Builder</h1>
            <p className="text-xs text-muted-foreground font-mono">
              Add, edit, remove, and enable/disable categories and links in the {NAV_TYPE_LABEL[navType]} sidebar — up to 5 levels deep.
              New items without a link auto-create a blank page.
            </p>
          </div>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => openCreate(1)}>
          <Plus className="w-3.5 h-3.5" /> Add Category
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {NAV_TYPE_ORDER.map(nt => (
          <button
            key={nt}
            onClick={() => setNavType(nt)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-xs font-mono border transition-colors",
              nt === navType
                ? "bg-primary/10 text-primary border-primary/30"
                : "text-muted-foreground border-transparent hover:bg-muted/30 hover:text-foreground"
            )}
          >
            {NAV_TYPE_LABEL[nt]}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="p-3">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-muted-foreground">
              <FileText className="w-6 h-6 opacity-40" />
              <p className="text-sm font-mono">No sidebar categories yet.</p>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openCreate(1)}>
                <Plus className="w-3.5 h-3.5" /> Add your first category
              </Button>
            </div>
          ) : (
            <div className="space-y-0.5">
              {tree.map(node => (
                <NavRow
                  key={node.id}
                  node={node}
                  onAddChild={(parent) => openCreate(parent.level + 1, parent)}
                  onEdit={openEdit}
                  onDelete={setConfirmDelete}
                  onToggle={toggle}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit dialog */}
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {edit?.mode === "create" ? `Add ${LEVEL_LABEL[edit.level]}` : `Edit ${edit ? LEVEL_LABEL[edit.level] : ""}`}
            </DialogTitle>
          </DialogHeader>
          {edit && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Label</Label>
                <Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} placeholder="e.g. Live Console" />
              </div>
              <div className="space-y-1.5">
                <Label>Icon</Label>
                <Select value={edit.icon} onValueChange={(v) => setEdit({ ...edit, icon: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {DEV_NAV_ICON_NAMES.map(name => (
                      <SelectItem key={name} value={name}>{name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Link (optional)</Label>
                <Input value={edit.href} onChange={(e) => setEdit({ ...edit, href: e.target.value })} placeholder="Leave blank to auto-create a blank page" />
                <p className="text-[11px] text-muted-foreground font-mono">
                  Leave this empty to get a ready-to-use blank page automatically.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !edit?.label.trim()} className="gap-1.5">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove "{confirmDelete?.label}"?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground font-mono">
            {confirmDelete && confirmDelete.children.length > 0
              ? `This will also remove its ${confirmDelete.children.length} sub-item(s).`
              : "This can't be undone."}
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmedDelete}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
