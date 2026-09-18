/**
 * pages/admin/project-templates.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Project Templates — manager page for the shared team library of
 * one-click prefills used by admin/projects.tsx's "Initialize New Protocol"
 * dialog (see the "Load from Template" dropdown there). CRUD-list pattern,
 * same shape as admin/health-rules.tsx — a list of named rows, each
 * editable/deletable, plus a "New Template" entry point.
 *
 * A template's `data` is edited here via the exact same SchemaForm +
 * PROJECT_CREATE_FIELDS config the create dialog itself uses, restricted to
 * the Meta/Economics(XP-only)/Tutorial tabs — the identity/media/money
 * fields (name, description, images, funding/reward, deadline) never
 * belong to a template, so they're simply not part of this form. See
 * PROJECT_TEMPLATE_DATA_KEYS in @workspace/db for the authoritative list;
 * this page's TEMPLATE_TABS is just which PROJECT_CREATE_FIELDS tabs happen
 * to contain only allow-listed keys.
 *
 * Extended (migration 071) with three more things editable here:
 *  - folder — free-text grouping, cards are bucketed by it below
 *  - usageCount — read-only, shown as a "Used N×" pill
 *  - defaultForProjectType — a checkbox that, when the template has a
 *    projectType set, offers to make it THE auto-applied default for that
 *    type on the create form (admin/projects.tsx's handleFormChange).
 *    Setting one clears any other template that held that type's default.
 */
import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  LayoutTemplate, Plus, Pencil, Trash2, X, Save, Loader2, Info, Tag, BookOpen, Copy, Star, Folder, Search, Eye,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PROJECT_CREATE_FIELDS, PROJECT_CREATE_GROUPS } from "@/config/fields/project-create";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { buildTemplateDiff, TemplatePreviewModal } from "@/components/projects/template-preview";

interface ProjectTemplate {
  id: number;
  name: string;
  description: string | null;
  data: Record<string, unknown>;
  folder: string | null;
  usageCount: number;
  defaultForProjectType: string | null;
  createdBy: number;
  createdAt: string;
  updatedAt: string;
}

// Fields a template is allowed to carry — must match
// PROJECT_TEMPLATE_DATA_KEYS in lib/db/src/schema/project-templates.ts.
const TEMPLATE_DATA_KEYS = [
  "category", "subcategory", "projectType", "exchangeSubType", "accountCategory",
  "tier", "experienceLevel", "durationType", "difficulty", "costType",
  "xpName", "xpPrice",
  "tutorialLink", "tutorialSteps", "badges",
] as const;

type TemplateForm = Record<string, unknown>;
const EMPTY_TEMPLATE_FORM: TemplateForm = {
  category: "", subcategory: "", projectType: "", exchangeSubType: "", accountCategory: "",
  tier: "1", experienceLevel: "Beginner", durationType: "long", difficulty: "average", costType: "free",
  xpName: "", xpPrice: "0.01",
  tutorialLink: "", tutorialSteps: "", badges: [],
};

type TemplateTab = "meta" | "economics" | "tutorial";
const TEMPLATE_TABS: { id: TemplateTab; label: string; icon: React.ElementType }[] = [
  { id: "meta", label: "Meta", icon: Tag },
  { id: "economics", label: "XP System", icon: Tag },
  { id: "tutorial", label: "Tutorial", icon: BookOpen },
];

// SchemaForm's PROJECT_CREATE_FIELDS "economics" tab also has funding/reward/
// deadline fields that aren't template data — filter those out here rather
// than forking the field config.
const TEMPLATE_FIELDS = PROJECT_CREATE_FIELDS.filter(f => (TEMPLATE_DATA_KEYS as readonly string[]).includes(f.key));

const UNFILED_FOLDER = "__unfiled__";

export default function AdminProjectTemplates() {
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProjectTemplate | "new" | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [folder, setFolder] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [form, setForm] = useState<TemplateForm>(EMPTY_TEMPLATE_FORM);
  const [tab, setTab] = useState<TemplateTab>("meta");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTemplate | null>(null);
  const [search, setSearch] = useState("");
  const [folderFilter, setFolderFilter] = useState("all");
  const [previewTarget, setPreviewTarget] = useState<ProjectTemplate | null>(null);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const data = await customFetch<{ templates: ProjectTemplate[] }>("/project-templates");
      setTemplates(data.templates);
    } catch {
      toast({ variant: "destructive", title: "Failed to load templates" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const startEdit = (t: ProjectTemplate | "new") => {
    setEditing(t);
    setName(t === "new" ? "" : t.name);
    setDescription(t === "new" ? "" : (t.description ?? ""));
    setFolder(t === "new" ? "" : (t.folder ?? ""));
    setIsDefault(t !== "new" && !!t.defaultForProjectType);
    setForm(t === "new" ? EMPTY_TEMPLATE_FORM : { ...EMPTY_TEMPLATE_FORM, ...t.data });
    setTab("meta");
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || !editing) { toast({ variant: "destructive", title: "Name required" }); return; }
    const projectType = form.projectType ? String(form.projectType) : "";
    if (isDefault && !projectType) {
      toast({ variant: "destructive", title: "Pick a Project Type first", description: "Default-for-type needs a projectType set on the Meta tab" });
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === "new";
      const updated = await customFetch<ProjectTemplate>(
        isNew ? "/project-templates" : `/project-templates/${editing.id}`,
        {
          method: isNew ? "POST" : "PATCH",
          body: JSON.stringify({
            name: trimmed,
            description,
            folder: folder.trim() || null,
            data: form,
            defaultForProjectType: isDefault ? projectType : null,
          }),
        },
      );
      toast({ title: isNew ? "Template created" : "Template saved", description: updated.name });
      setEditing(null);
      load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Could not save template", description: err?.message ?? "Try again" });
    } finally {
      setSaving(false);
    }
  };

  const duplicate = async (t: ProjectTemplate) => {
    try {
      const created = await customFetch<ProjectTemplate>(`/project-templates/${t.id}/duplicate`, { method: "POST" });
      toast({ title: "Template duplicated", description: created.name });
      load();
    } catch {
      toast({ variant: "destructive", title: "Could not duplicate template" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await customFetch(`/project-templates/${deleteTarget.id}`, { method: "DELETE" });
      toast({ title: "Template deleted", description: deleteTarget.name });
      setDeleteTarget(null);
      load();
    } catch {
      toast({ variant: "destructive", title: "Could not delete template" });
    }
  };

  // Group by folder for display — ungrouped templates land in a trailing
  // "Unfiled" bucket rather than being hidden or mixed in unlabeled.
  // Search matches name/description/folder; folder filter narrows to one
  // bucket (or "unfiled") on top of that — both apply before grouping so
  // empty folders just disappear rather than showing as empty sections.
  const allFolders = Array.from(new Set((templates ?? []).map(t => t.folder?.trim()).filter(Boolean))) as string[];
  const q = search.trim().toLowerCase();
  const visible = (templates ?? []).filter(t => {
    if (folderFilter !== "all") {
      const bucket = t.folder?.trim() || UNFILED_FOLDER;
      if (bucket !== folderFilter) return false;
    }
    if (!q) return true;
    return t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q) || (t.folder ?? "").toLowerCase().includes(q);
  });
  const grouped: Record<string, ProjectTemplate[]> = {};
  for (const t of visible) {
    const key = t.folder?.trim() || UNFILED_FOLDER;
    (grouped[key] ??= []).push(t);
  }
  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === UNFILED_FOLDER) return 1;
    if (b === UNFILED_FOLDER) return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <LayoutTemplate className="w-5 h-5 text-primary" /> Project Templates
          </h1>
          <p className="text-muted-foreground font-mono text-sm">
            Saved prefills for "Initialize New Protocol" — category/type, tier, XP system, tutorial, badges.
          </p>
        </div>
        <Button className="font-mono uppercase text-xs tracking-wider gap-2" onClick={() => startEdit("new")}>
          <Plus className="h-4 w-4" /> New Template
        </Button>
      </div>

      {!loading && templates && templates.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search templates by name, folder, or description…"
              className="pl-8 font-mono text-sm"
            />
          </div>
          {allFolders.length > 0 && (
            <Select value={folderFilter} onValueChange={setFolderFilter}>
              <SelectTrigger className="sm:w-48 font-mono text-xs">
                <SelectValue placeholder="All folders" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="font-mono text-xs">All folders</SelectItem>
                {allFolders.sort().map(f => <SelectItem key={f} value={f} className="font-mono text-xs">{f}</SelectItem>)}
                <SelectItem value={UNFILED_FOLDER} className="font-mono text-xs">Unfiled</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {loading && (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
      )}

      {!loading && templates && templates.length === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground font-mono">
          No templates yet — save one from here or from the create-project dialog.
        </CardContent></Card>
      )}

      {!loading && templates && templates.length > 0 && visible.length === 0 && (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground font-mono">
          No templates match "{search}"{folderFilter !== "all" ? ` in that folder` : ""}.
        </CardContent></Card>
      )}

      {!loading && visible.length > 0 && (
        <div className="space-y-6">
          {folderKeys.map(key => (
            <div key={key} className="space-y-2">
              <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-muted-foreground/70">
                <Folder className="h-3 w-3" /> {key === UNFILED_FOLDER ? "Unfiled" : key}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {grouped[key].map(t => (
                  <Card key={t.id} className="relative">
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-sm font-mono truncate flex items-center gap-1.5">
                          {t.defaultForProjectType && <Star className="h-3 w-3 text-amber-400 fill-amber-400 shrink-0" />}
                          {t.name}
                        </CardTitle>
                        <div className="flex gap-1 shrink-0">
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Preview" onClick={() => setPreviewTarget(t)}>
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Duplicate" onClick={() => duplicate(t)}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => startEdit(t)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => setDeleteTarget(t)}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {t.description && <p className="text-xs text-muted-foreground">{t.description}</p>}
                      <div className="flex flex-wrap gap-1.5">
                        {t.data.projectType ? <Badge>{String(t.data.projectType)}</Badge> : null}
                        {t.data.tier ? <Badge>Tier {String(t.data.tier)}</Badge> : null}
                        {t.data.experienceLevel ? <Badge>{String(t.data.experienceLevel)}</Badge> : null}
                        {t.data.xpName ? <Badge>{String(t.data.xpName)}</Badge> : null}
                        {t.defaultForProjectType && <Badge>★ Default · {t.defaultForProjectType}</Badge>}
                        <Badge>{t.usageCount > 0 ? `Used ${t.usageCount}×` : "Unused"}</Badge>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create/Edit dialog — same tabbed SchemaForm shell as the create-project dialog ── */}
      {editing !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border border-card-border rounded-xl w-full max-w-xl shadow-2xl relative overflow-hidden flex flex-col max-h-[90vh]">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent" />
            <div className="flex items-center justify-between px-6 py-4 border-b border-card-border shrink-0">
              <h2 className="font-mono font-bold uppercase tracking-wider text-primary text-sm">
                {editing === "new" ? "New Template" : `Edit — ${editing.name}`}
              </h2>
              <button onClick={() => setEditing(null)} className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-6 pt-4 space-y-3 shrink-0">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Template name *</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Exchange Campaign" className="font-mono text-sm" autoFocus maxLength={60} />
                </div>
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Folder</Label>
                  <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. Exchange" className="font-mono text-sm" maxLength={40} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Description</Label>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="When to use this template" className="font-mono text-sm" />
              </div>
              <label className="flex items-center gap-2 text-xs font-mono text-muted-foreground cursor-pointer">
                <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(!!v)} />
                Make default for Project Type{form.projectType ? ` "${form.projectType}"` : ""} — auto-applied on the create form
              </label>
            </div>

            <div className="flex border-b border-border shrink-0 px-2 mt-3 overflow-x-auto">
              {TEMPLATE_TABS.map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-3 font-mono text-[10px] uppercase tracking-wider border-b-2 transition-all -mb-px whitespace-nowrap",
                      tab === t.id ? "border-primary text-primary font-bold" : "border-transparent text-muted-foreground/50 hover:text-muted-foreground",
                    )}
                  >
                    <Icon className="w-3 h-3" /> {t.label}
                  </button>
                );
              })}
            </div>

            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              <SchemaForm
                fields={TEMPLATE_FIELDS}
                groups={PROJECT_CREATE_GROUPS}
                tab={tab}
                form={form}
                onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
              />
            </div>

            <div className="flex justify-end gap-2 px-6 py-4 border-t border-card-border shrink-0">
              <Button variant="ghost" onClick={() => setEditing(null)} className="font-mono text-xs">Cancel</Button>
              <Button onClick={save} disabled={saving} className="font-mono text-xs gap-2">
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save Template
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Delete confirm ── */}
      {previewTarget && (
        <TemplatePreviewModal
          templateName={previewTarget.name}
          rows={buildTemplateDiff(previewTarget.data, {})}
          onClose={() => setPreviewTarget(null)}
          readOnly
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border border-card-border rounded-xl w-full max-w-sm shadow-2xl p-6 space-y-4">
            <div className="flex items-center gap-2 text-sm font-mono">
              <Info className="w-4 h-4 text-destructive" /> Delete "{deleteTarget.name}"?
            </div>
            <p className="text-xs text-muted-foreground">This can't be undone. Projects already created from this template are unaffected.</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDeleteTarget(null)} className="font-mono text-xs">Cancel</Button>
              <Button variant="destructive" onClick={confirmDelete} className="font-mono text-xs">Delete</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Tiny inline badge — avoids importing the shadcn Badge just for a plain
// mono-font pill here; matches the visual weight of the other admin cards.
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-border px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-muted-foreground">
      {children}
    </span>
  );
}
