import { useEffect, useState } from "react";
import {
  useCustomButtons, type CustomButton, type CustomButtonPosition,
  type CustomButtonVariant, type CustomButtonColor, type CustomButtonShape, type CustomButtonSize,
} from "@/hooks/use-custom-buttons";
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
  MousePointerClick, Plus, Trash2, Edit2, Loader2, ExternalLink,
  ArrowUp, ArrowDown, Link2,
} from "lucide-react";

const POSITIONS: { value: CustomButtonPosition; label: string }[] = [
  { value: "bottom-right", label: "Bottom right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
];
const VARIANTS: CustomButtonVariant[] = ["solid", "outline", "ghost"];
const COLORS: CustomButtonColor[] = ["primary", "secondary", "accent", "success", "warning", "danger"];
const SHAPES: CustomButtonShape[] = ["pill", "rounded", "square"];
const SIZES: CustomButtonSize[] = ["sm", "md", "lg"];

interface EditState {
  mode: "create" | "edit";
  id?: number;
  label: string;
  icon: string;
  href: string;
  external: boolean;
  position: CustomButtonPosition;
  variant: CustomButtonVariant;
  color: CustomButtonColor;
  shape: CustomButtonShape;
  size: CustomButtonSize;
}

const BLANK_EDIT: Omit<EditState, "mode" | "id"> = {
  label: "", icon: "Link2", href: "", external: false,
  position: "bottom-right", variant: "solid", color: "primary", shape: "pill", size: "md",
};

function ButtonRow({ button, onEdit, onDelete, onToggle, onMove, isFirst, isLast }: {
  button: CustomButton;
  onEdit: (b: CustomButton) => void;
  onDelete: (b: CustomButton) => void;
  onToggle: (b: CustomButton, enabled: boolean) => void;
  onMove: (b: CustomButton, dir: "up" | "down") => void;
  isFirst: boolean;
  isLast: boolean;
}) {
  const Icon = resolveDevNavIcon(button.icon);
  return (
    <div className={cn(
      "flex items-center gap-2 p-2.5 rounded-lg hover:bg-muted/20 group/row border border-transparent",
      !button.enabled && "opacity-50"
    )}>
      <div className="flex flex-col -my-1">
        <button onClick={() => onMove(button, "up")} disabled={isFirst} className="text-muted-foreground/40 hover:text-primary disabled:opacity-20">
          <ArrowUp className="w-3 h-3" />
        </button>
        <button onClick={() => onMove(button, "down")} disabled={isLast} className="text-muted-foreground/40 hover:text-primary disabled:opacity-20">
          <ArrowDown className="w-3 h-3" />
        </button>
      </div>
      <Icon className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
      <span className="text-sm font-mono flex-1 truncate">{button.label}</span>
      <a href={button.href} target="_blank" rel="noreferrer" className="text-[10px] text-muted-foreground/50 font-mono hidden sm:flex items-center gap-1 hover:text-primary max-w-[14rem] truncate">
        {button.href} <ExternalLink className="w-2.5 h-2.5 flex-shrink-0" />
      </a>
      <Badge variant="outline" className="text-[9px] font-mono capitalize">{button.variant}/{button.color}</Badge>
      <Badge variant="outline" className="text-[9px] font-mono capitalize">{button.shape} · {button.size}</Badge>
      <Switch checked={button.enabled} onCheckedChange={(v) => onToggle(button, v)} />
      <div className="flex gap-1">
        <button onClick={() => onEdit(button)} className="p-1 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors">
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => onDelete(button)} className="p-1 rounded hover:bg-danger/10 text-muted-foreground hover:text-danger transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function AdminCustomButtons() {
  const { adminButtons, isLoading, createButton, updateButton, deleteButton, refreshAdmin } = useCustomButtons();
  const { toast } = useToast();
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<CustomButton | null>(null);

  useEffect(() => { refreshAdmin(); }, [refreshAdmin]);

  const groups = POSITIONS.map(p => ({
    ...p,
    items: adminButtons.filter(b => b.position === p.value).slice().sort((a, b) => a.sortOrder - b.sortOrder),
  }));

  const openCreate = (position?: CustomButtonPosition) => {
    setEdit({ mode: "create", ...BLANK_EDIT, position: position ?? "bottom-right" });
  };
  const openEdit = (b: CustomButton) => {
    setEdit({
      mode: "edit", id: b.id, label: b.label, icon: b.icon, href: b.href, external: b.external,
      position: b.position, variant: b.variant, color: b.color, shape: b.shape, size: b.size,
    });
  };

  const save = async () => {
    if (!edit || !edit.label.trim() || !edit.href.trim()) return;
    setSaving(true);
    try {
      const payload = {
        label: edit.label.trim(), icon: edit.icon, href: edit.href.trim(), external: edit.external,
        position: edit.position, variant: edit.variant, color: edit.color, shape: edit.shape, size: edit.size,
      };
      if (edit.mode === "create") {
        const created = await createButton(payload);
        if (created) toast({ title: "Button added", description: `"${created.label}" is now live.` });
      } else if (edit.id) {
        await updateButton(edit.id, payload);
        toast({ title: "Button updated" });
      }
      setEdit(null);
    } catch (err: any) {
      toast({ title: "Couldn't save button", description: err?.message, variant: "destructive" as any });
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (b: CustomButton, enabled: boolean) => {
    try { await updateButton(b.id, { enabled }); } catch { }
  };

  const move = async (b: CustomButton, dir: "up" | "down") => {
    const siblings = adminButtons.filter(x => x.position === b.position).slice().sort((a, c) => a.sortOrder - c.sortOrder);
    const idx = siblings.findIndex(x => x.id === b.id);
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;
    const other = siblings[swapIdx];
    try {
      await Promise.all([
        updateButton(b.id, { sortOrder: other.sortOrder } as any),
        updateButton(other.id, { sortOrder: b.sortOrder } as any),
      ]);
    } catch { }
  };

  const confirmedDelete = async () => {
    if (!confirmDelete) return;
    await deleteButton(confirmDelete.id);
    toast({ title: `"${confirmDelete.label}" removed` });
    setConfirmDelete(null);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <MousePointerClick className="w-5 h-5 text-primary" />
          <div>
            <h1 className="text-lg font-mono font-semibold">Custom Buttons</h1>
            <p className="text-xs text-muted-foreground font-mono">
              Add floating action buttons anywhere on the site — set their link, corner, and style. Visible to every signed-in user.
            </p>
          </div>
        </div>
        <Button size="sm" className="gap-1.5" onClick={() => openCreate()}>
          <Plus className="w-3.5 h-3.5" /> Add Button
        </Button>
      </div>

      {isLoading && adminButtons.length === 0 ? (
        <Card><CardContent className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin" />
        </CardContent></Card>
      ) : (
        <div className="space-y-4">
          {groups.map(group => (
            <Card key={group.value}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between px-1.5 pb-2">
                  <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">{group.label}</Label>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px] gap-1" onClick={() => openCreate(group.value)}>
                    <Plus className="w-3 h-3" /> Add here
                  </Button>
                </div>
                {group.items.length === 0 ? (
                  <p className="text-xs text-muted-foreground font-mono px-1.5 pb-2">No buttons in this corner.</p>
                ) : (
                  <div className="space-y-0.5">
                    {group.items.map((b, i) => (
                      <ButtonRow
                        key={b.id}
                        button={b}
                        onEdit={openEdit}
                        onDelete={setConfirmDelete}
                        onToggle={toggle}
                        onMove={move}
                        isFirst={i === 0}
                        isLast={i === group.items.length - 1}
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add / Edit dialog */}
      <Dialog open={!!edit} onOpenChange={(v) => !v && setEdit(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{edit?.mode === "create" ? "Add Button" : "Edit Button"}</DialogTitle>
          </DialogHeader>
          {edit && (
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Label</Label>
                <Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} placeholder="e.g. Join Discord" />
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5"><Link2 className="w-3.5 h-3.5" /> Redirect link (href)</Label>
                <Input value={edit.href} onChange={(e) => setEdit({ ...edit, href: e.target.value })} placeholder="https://... or /internal/path" />
                <div className="flex items-center gap-2 pt-1">
                  <Switch checked={edit.external} onCheckedChange={(v) => setEdit({ ...edit, external: v })} />
                  <span className="text-[11px] text-muted-foreground font-mono">Open in a new tab (external link)</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Icon</Label>
                  <Select value={edit.icon} onValueChange={(v) => setEdit({ ...edit, icon: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {DEV_NAV_ICON_NAMES.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Position</Label>
                  <Select value={edit.position} onValueChange={(v) => setEdit({ ...edit, position: v as CustomButtonPosition })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {POSITIONS.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Style (variant)</Label>
                  <Select value={edit.variant} onValueChange={(v) => setEdit({ ...edit, variant: v as CustomButtonVariant })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {VARIANTS.map(v => <SelectItem key={v} value={v} className="capitalize">{v}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Color</Label>
                  <Select value={edit.color} onValueChange={(v) => setEdit({ ...edit, color: v as CustomButtonColor })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {COLORS.map(c => <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Shape</Label>
                  <Select value={edit.shape} onValueChange={(v) => setEdit({ ...edit, shape: v as CustomButtonShape })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SHAPES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Size</Label>
                  <Select value={edit.size} onValueChange={(v) => setEdit({ ...edit, size: v as CustomButtonSize })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SIZES.map(s => <SelectItem key={s} value={s} className="uppercase">{s}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button onClick={save} disabled={saving || !edit?.label.trim() || !edit?.href.trim()} className="gap-1.5">
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
          <p className="text-sm text-muted-foreground font-mono">This can't be undone.</p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmedDelete}>Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
