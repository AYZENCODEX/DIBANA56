import { useState, useRef, useEffect } from "react";
import type { KeyboardEvent } from "react";
import { Link } from "wouter";
import { useListProjects } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Search, Plus, ExternalLink, Activity, X, XCircle, Zap, Tag, DollarSign, Info, BookOpen, LayoutTemplate, Save, ChevronDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PROJECT_CATEGORIES } from "@/config/projects";
import { PROJECT_CREATE_FIELDS, PROJECT_CREATE_GROUPS } from "@/config/fields/project-create";
import { SchemaForm } from "@/components/schema/SchemaForm";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { buildTemplateDiff, TemplatePreviewModal } from "@/components/projects/template-preview";

// Non-identity keys a template may prefill — must match
// PROJECT_TEMPLATE_DATA_KEYS in lib/db/src/schema/project-templates.ts.
// Identity/media/money fields (name, description, images, funding/reward,
// deadline, social links) are never part of a template.
const TEMPLATE_DATA_KEYS = [
  "category", "subcategory", "projectType", "exchangeSubType", "accountCategory",
  "tier", "experienceLevel", "durationType", "difficulty", "costType",
  "xpName", "xpPrice",
  "tutorialLink", "tutorialSteps", "badges",
] as const;

// Shared by every "Load/Apply Template" dropdown — matches name or folder,
// case-insensitive substring. Kept tiny on purpose (no fuzzy matching) since
// template names are short and admins type exact-ish fragments.
function filterTemplates<T extends { name: string; folder?: string | null }>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(t => t.name.toLowerCase().includes(q) || (t.folder ?? "").toLowerCase().includes(q));
}

interface ProjectTemplate {
  id: number;
  name: string;
  description: string | null;
  data: Partial<CreateForm>;
  folder: string | null;
  usageCount: number;
  defaultForProjectType: string | null;
}

interface CreateForm {
  name: string;
  description: string;
  twitterHandle: string;
  discordUrl: string;
  websiteUrl: string;
  xpName: string;
  xpPrice: string;
  rewardEstimate: string;
  fundingAmount: string;
  deadline: string;
  category: string;
  subcategory: string;
  tier: string;
  durationType: string;
  difficulty: string;
  costType: string;
  experienceLevel: string;
  tutorialLink: string;
  tutorialSteps: string;
  badges: string[];
  thumbnailUrl: string;
  bannerUrl: string;
  projectType: string;
  exchangeSubType: string;
  accountCategory: string;
}

const EMPTY_FORM: CreateForm = {
  name: "", description: "",
  twitterHandle: "", discordUrl: "", websiteUrl: "",
  xpName: "", xpPrice: "0.01", rewardEstimate: "", fundingAmount: "", deadline: "",
  category: "", subcategory: "", tier: "1", durationType: "long", difficulty: "average", costType: "free", experienceLevel: "Beginner",
  tutorialLink: "", tutorialSteps: "", badges: [],
  thumbnailUrl: "", bannerUrl: "",
  projectType: "", exchangeSubType: "candydrop", accountCategory: "both",
};

type CreateTab = "basic" | "economics" | "meta" | "tutorial";

const CREATE_TABS: { id: CreateTab; label: string; icon: React.ElementType }[] = [
  { id: "basic",     label: "Basic",     icon: Info },
  { id: "economics", label: "Economics", icon: DollarSign },
  { id: "meta",      label: "Meta",      icon: Tag },
  { id: "tutorial",  label: "Tutorial",  icon: BookOpen },
];

// ─── Badge/tag input — Phase 7A. Type freely, press Space/Enter/, to commit
// a tag. Rendered manually outside SchemaForm since FieldDef has no generic
// "tags" type yet (same workaround components/game-entries.tsx and
// admin/project-detail.tsx's BadgeTagInput use). ────────────────────────────
function BadgeTagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = (raw: string) => {
    const tag = raw.trim();
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === " " || e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  const removeTag = (tag: string) => onChange(value.filter(t => t !== tag));

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[2.25rem] bg-input border border-border rounded-lg px-2.5 py-1.5 focus-within:border-primary/60 transition-colors"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map(tag => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/25"
        >
          {tag}
          <button
            type="button"
            onClick={e => { e.stopPropagation(); removeTag(tag); }}
            className="hover:text-red-400 transition-colors"
          >
            <XCircle className="w-2.5 h-2.5" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => commit(draft)}
        placeholder={value.length === 0 ? "e.g. hot, low-cost, testnet..." : ""}
        className="flex-1 min-w-[8ch] bg-transparent outline-none font-mono text-xs placeholder:text-muted-foreground"
      />
    </div>
  );
}

export default function AdminProjects() {
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState("All");
  const [showCreate, setShowCreate] = useState(false);
  const [createTab, setCreateTab] = useState<CreateTab>("basic");
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [templates, setTemplates] = useState<ProjectTemplate[] | null>(null);
  const [templateSearch, setTemplateSearch] = useState("");
  const [previewTemplate, setPreviewTemplate] = useState<ProjectTemplate | null>(null);
  const autoDefaultTried = useRef(false);
  const { data, isLoading, refetch } = useListProjects({ search, page: 1, limit: 50 });
  const { toast } = useToast();

  const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem("ayzen_token") ?? ""}` });
  const apiBase = () => (import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "") + "/api";

  // Lazy-loaded once, the first time the create dialog is opened — a plain
  // authed fetch (same pattern as handleCreate below) rather than
  // useListProjects-style codegen, since this is a small one-off list.
  const openCreate = () => {
    setShowCreate(true);
    autoDefaultTried.current = false;
    setTemplateSearch("");
    if (templates !== null) return;
    fetch(`${apiBase()}/project-templates`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : { templates: [] })
      .then(d => setTemplates(d.templates ?? []))
      .catch(() => setTemplates([]));
  };

  // Fire-and-forget usage tracking — never blocks the merge itself, and a
  // failed count-bump shouldn't surface as an error to the admin (the
  // template still applied fine either way).
  const trackTemplateUse = (id: number) => {
    fetch(`${apiBase()}/project-templates/${id}/apply`, { method: "POST", headers: authHeaders() }).catch(() => {});
  };

  // Merges a template's saved fields into the current form — never touches
  // name/description/media/social/funding fields, so applying a template
  // mid-fill-in doesn't clobber identity info already typed.
  const applyTemplate = (t: ProjectTemplate, opts?: { silent?: boolean }) => {
    setForm(prev => ({ ...prev, ...t.data }));
    trackTemplateUse(t.id);
    autoDefaultTried.current = true; // a manual pick also counts as "handled" for this session
    if (!opts?.silent) toast({ title: "Template applied", description: t.name });
  };

  // Wraps the plain setForm SchemaForm normally gets. The actual
  // default-template auto-apply lives in the effect below, not inline
  // here — see that effect's comment for why (this used to mark the
  // "already tried" flag the instant projectType was set, even if the
  // templates list hadn't finished loading yet, which silently disabled
  // auto-apply for the rest of the session whenever an admin picked a
  // project type quickly).
  const handleFormChange = (key: string, value: unknown) => {
    setForm(prev => ({ ...prev, [key]: value } as CreateForm));
  };

  // Auto-applies a projectType's default template once per dialog session.
  // Runs as an effect (not inline in handleFormChange) specifically so it
  // can WAIT for `templates` to finish loading: if an admin picks
  // projectType before the fetch in openCreate resolves, this re-runs the
  // moment `templates` arrives instead of having already given up. Still
  // only fires once (autoDefaultTried), so it never overwrites a manual
  // template pick (applyTemplate sets the ref too) or fights the admin if
  // they change projectType again later after adjusting fields by hand.
  useEffect(() => {
    if (!showCreate || autoDefaultTried.current || !templates || !form.projectType) return;
    autoDefaultTried.current = true;
    const defaultTemplate = templates.find(t => t.defaultForProjectType === form.projectType);
    if (defaultTemplate) {
      setForm(prev => ({ ...prev, ...defaultTemplate.data } as CreateForm));
      trackTemplateUse(defaultTemplate.id);
      toast({ title: "Default template applied", description: defaultTemplate.name });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showCreate, templates, form.projectType]);

  // Quick save straight from the create dialog — captures only the
  // allow-listed template fields out of the current form. Full rename/
  // edit/delete lives on the Project Templates manager page
  // (/admin/project-templates); this is just the fast path.
  const saveAsTemplate = () => {
    const name = window.prompt("Template name:");
    if (!name?.trim()) return;
    const data: Record<string, unknown> = {};
    for (const key of TEMPLATE_DATA_KEYS) {
      const val = (form as Record<string, unknown>)[key];
      if (val !== undefined && val !== null && val !== "" && !(Array.isArray(val) && val.length === 0)) data[key] = val;
    }
    fetch(`${apiBase()}/project-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ name: name.trim(), data }),
    }).then(async r => {
      const d = await r.json();
      if (r.ok) {
        toast({ title: "Template saved", description: d.name });
        setTemplates(prev => [d, ...(prev ?? [])]);
      } else {
        toast({ variant: "destructive", title: "Could not save template", description: d.error });
      }
    }).catch(() => toast({ variant: "destructive", title: "Connection error" }));
  };

  const handleCreate = () => {
    if (!form.name.trim()) { toast({ variant: "destructive", title: "Name required" }); return; }
    const token = localStorage.getItem("ayzen_token") ?? "";
    const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${BASE}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        twitterHandle: form.twitterHandle || undefined,
        discordUrl: form.discordUrl || undefined,
        websiteUrl: form.websiteUrl || undefined,
        xpName: form.xpName.trim() || undefined,
        xpPrice: form.xpPrice ? Number(form.xpPrice) : 0.01,
        rewardEstimate: form.rewardEstimate ? Number(form.rewardEstimate) : 0,
        fundingAmount: form.fundingAmount ? Number(form.fundingAmount) : 0,
        deadline: form.deadline || undefined,
        category: form.category,
        tier: form.tier,
        durationType: form.durationType,
        difficulty: form.difficulty,
        costType: form.costType,
        experienceLevel: form.experienceLevel,
        tutorialLink: form.tutorialLink || undefined,
        tutorialSteps: form.tutorialSteps || undefined,
        badges: form.badges.length > 0 ? form.badges : undefined,
        thumbnailUrl: form.thumbnailUrl || undefined,
        bannerUrl: form.bannerUrl || undefined,
        projectType: form.projectType,
        exchangeSubType: form.exchangeSubType,
        accountCategory: form.accountCategory,
      }),
    }).then(async r => {
      if (r.ok) {
        toast({ title: "Project created", description: `${form.name} initialized.` });
        setForm(EMPTY_FORM); setShowCreate(false); setCreateTab("basic"); refetch();
      } else {
        const d = await r.json();
        toast({ variant: "destructive", title: "Failed", description: d.error });
      }
    }).catch(() => toast({ variant: "destructive", title: "Connection error" }));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Project Database</h1>
          <p className="text-muted-foreground font-mono text-sm">Manage airdrop campaigns and protocols</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/project-templates">
            <Button variant="outline" className="font-mono uppercase text-xs tracking-wider gap-2">
              <LayoutTemplate className="h-4 w-4" /> Templates
            </Button>
          </Link>
          <Button className="font-mono uppercase text-xs tracking-wider gap-2" onClick={openCreate}>
            <Plus className="h-4 w-4" /> Initialize Project
          </Button>
        </div>
      </div>

      {/* ── Create dialog (4-tab overlay) ── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border border-card-border rounded-xl w-full max-w-xl shadow-2xl relative overflow-hidden flex flex-col max-h-[90vh]">
            <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent" />

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-card-border shrink-0">
              <h2 className="font-mono font-bold uppercase tracking-wider text-primary text-sm">Initialize New Protocol</h2>
              <div className="flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-7 font-mono text-[10px] uppercase gap-1 text-muted-foreground hover:text-foreground">
                      <LayoutTemplate className="h-3.5 w-3.5" /> Load Template <ChevronDown className="h-3 w-3" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    {templates && templates.length > 3 && (
                      <div className="px-2 py-1.5" onKeyDown={(e) => e.stopPropagation()}>
                        <Input
                          value={templateSearch}
                          onChange={(e) => setTemplateSearch(e.target.value)}
                          placeholder="Search templates…"
                          className="h-7 text-xs font-mono"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                    )}
                    {(!templates || templates.length === 0) && (
                      <div className="px-2 py-1.5 text-[11px] font-mono text-muted-foreground">
                        {templates === null ? "Loading…" : "No templates yet"}
                      </div>
                    )}
                    {templates && templates.length > 0 && filterTemplates(templates, templateSearch).length === 0 && (
                      <div className="px-2 py-1.5 text-[11px] font-mono text-muted-foreground">No matches</div>
                    )}
                    {filterTemplates(templates ?? [], templateSearch).map(t => (
                      <DropdownMenuItem key={t.id} onClick={() => setPreviewTemplate(t)} className="font-mono text-xs flex items-center justify-between gap-2">
                        <span className="truncate">{t.name}</span>
                        <span className="flex items-center gap-1 shrink-0 text-muted-foreground/60">
                          {t.defaultForProjectType && <span title={`Default for ${t.defaultForProjectType}`}>★</span>}
                          {t.usageCount > 0 && <span className="text-[9px]">{t.usageCount}×</span>}
                        </span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={saveAsTemplate} className="font-mono text-xs gap-2">
                      <Save className="h-3.5 w-3.5" /> Save current as template
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <button onClick={() => { setShowCreate(false); setForm(EMPTY_FORM); setCreateTab("basic"); }} className="text-muted-foreground hover:text-foreground p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {previewTemplate && (
              <TemplatePreviewModal
                templateName={previewTemplate.name}
                rows={buildTemplateDiff(previewTemplate.data as Record<string, unknown>, form as unknown as Record<string, unknown>)}
                onClose={() => setPreviewTemplate(null)}
                onConfirm={() => { applyTemplate(previewTemplate, { silent: true }); setPreviewTemplate(null); }}
              />
            )}

            {/* Tab navigation */}
            <div className="flex border-b border-border shrink-0 px-2 overflow-x-auto">
              {CREATE_TABS.map(t => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => setCreateTab(t.id)}
                    className={cn(
                      "flex items-center gap-1.5 px-4 py-3 font-mono text-[10px] uppercase tracking-wider border-b-2 transition-all -mb-px whitespace-nowrap",
                      createTab === t.id
                        ? "border-primary text-primary font-bold"
                        : "border-transparent text-muted-foreground/50 hover:text-muted-foreground"
                    )}
                  >
                    <Icon className="w-3 h-3" /> {t.label}
                  </button>
                );
              })}
            </div>

            {/* Tab content — one generic SchemaForm driven by PROJECT_CREATE_FIELDS.
                Adding/reordering/hiding a field on any tab is now purely a
                config/fields/project-create.ts edit; this JSX never changes. */}
            <div className="overflow-y-auto flex-1 px-6 py-5 space-y-4">
              <SchemaForm
                fields={PROJECT_CREATE_FIELDS}
                groups={PROJECT_CREATE_GROUPS}
                tab={createTab}
                form={form}
                onChange={(key, value) => handleFormChange(key, value)}
              />
              {/* Phase 7A — badges/tags, next to Description on the Basic tab.
                  Rendered manually since SchemaForm/FieldDef has no "tags" type. */}
              {createTab === "basic" && (
                <div className="space-y-1">
                  <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Badges / Tags</Label>
                  <BadgeTagInput
                    value={form.badges}
                    onChange={tags => setForm(prev => ({ ...prev, badges: tags }))}
                  />
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-card-border px-6 py-4 flex gap-3 shrink-0">
              <div className="flex gap-1 flex-1 mr-2">
                {CREATE_TABS.map((t, i) => (
                  <div
                    key={t.id}
                    className={cn(
                      "flex-1 h-1 rounded-full transition-all",
                      i <= CREATE_TABS.findIndex(x => x.id === createTab)
                        ? "bg-primary"
                        : "bg-muted/40"
                    )}
                  />
                ))}
              </div>
              <Button
                variant="outline"
                className="font-mono text-xs"
                onClick={() => {
                  const idx = CREATE_TABS.findIndex(t => t.id === createTab);
                  if (idx > 0) setCreateTab(CREATE_TABS[idx - 1].id);
                  else { setShowCreate(false); setForm(EMPTY_FORM); }
                }}
              >
                {createTab === "basic" ? "Cancel" : "Back"}
              </Button>
              {createTab !== "tutorial" ? (
                <Button
                  className="font-mono text-xs"
                  onClick={() => {
                    const idx = CREATE_TABS.findIndex(t => t.id === createTab);
                    setCreateTab(CREATE_TABS[idx + 1].id);
                  }}
                >
                  Next →
                </Button>
              ) : (
                <Button className="font-mono text-xs" onClick={handleCreate}>
                  Initialize Protocol
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-4">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by protocol name..."
              className="pl-9 font-mono bg-card border-card-border"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {catFilter !== "All" && (
            <button onClick={() => setCatFilter("All")} className="flex items-center gap-1 text-xs font-mono text-muted-foreground/50 hover:text-primary transition-colors">
              <X className="w-3 h-3" /> Clear filter
            </button>
          )}
        </div>
        {/* Category filter pills */}
        <div className="flex flex-wrap gap-1.5 pb-1">
          {PROJECT_CATEGORIES.map(cat => (
            <button key={cat} onClick={() => setCatFilter(cat)}
              className={cn("px-2.5 py-1 rounded-lg font-mono text-[10px] border transition-all",
                catFilter === cat
                  ? "border-primary/50 bg-primary/10 text-primary font-bold"
                  : "border-border/30 text-muted-foreground/50 hover:border-primary/20 hover:text-muted-foreground")}>
              {cat}
            </button>
          ))}
        </div>
      </div>

      {(() => {
        const allProjects = data?.projects ?? [];
        const projects = catFilter === "All" ? allProjects : allProjects.filter((p: any) => p.category === catFilter);
        return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {isLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="bg-card border-card-border shadow-none">
              <CardHeader className="pb-2"><Skeleton className="h-6 w-3/4" /><Skeleton className="h-4 w-1/2 mt-2" /></CardHeader>
              <CardContent><div className="space-y-2 mt-4"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-full" /></div></CardContent>
              <CardFooter><Skeleton className="h-8 w-full" /></CardFooter>
            </Card>
          ))
        ) : projects.length === 0 ? (
          <div className="col-span-full py-12 text-center font-mono text-muted-foreground bg-card border border-card-border rounded-md">
            No active protocols in the database.{" "}
            <button onClick={() => setShowCreate(true)} className="text-primary hover:underline">Initialize one now.</button>
          </div>
        ) : (
          projects.map((project: any) => (
            <Card key={project.id} className="bg-card border-card-border shadow-none flex flex-col group hover:border-primary/50 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex justify-between items-start">
                  <CardTitle className="font-mono font-bold truncate pr-2 text-primary">{project.name}</CardTitle>
                  <Badge variant="outline" className="font-mono text-[10px] uppercase rounded-sm border-primary/30">Tier {project.tier}</Badge>
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-xs font-mono text-muted-foreground truncate">Funding: ${project.fundingAmount?.toLocaleString() ?? 0}</div>
                  {(project as any).xpName && (
                    <Badge variant="outline" className="font-mono text-[9px] uppercase border-yellow-500/30 text-yellow-400 bg-yellow-400/5 flex items-center gap-1">
                      <Zap className="w-2.5 h-2.5" />{(project as any).xpName}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex-1">
                <p className="text-sm text-muted-foreground line-clamp-3 mb-4">{project.description ?? "No data provided."}</p>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-background/50 rounded p-2 border border-border">
                    <div className="text-muted-foreground mb-1 uppercase">Operators</div>
                    <div className="font-bold">{project.activeUserCount ?? 0}</div>
                  </div>
                  <div className="bg-background/50 rounded p-2 border border-border">
                    <div className="text-muted-foreground mb-1 uppercase">Tasks</div>
                    <div className="font-bold">{project.taskCount ?? 0}</div>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-0 flex gap-2">
                <Link href={`/admin/projects/${project.id}`} className="flex-1">
                  <Button variant="outline" className="w-full font-mono text-xs uppercase bg-transparent border-card-border hover:bg-primary/10 hover:text-primary">
                    <Activity className="h-3 w-3 mr-2" /> Details
                  </Button>
                </Link>
                {project.websiteUrl && (
                  <Button variant="ghost" size="icon" className="border border-card-border hover:bg-primary/10 hover:text-primary" onClick={() => window.open(project.websiteUrl!, "_blank")}>
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))
        )}
      </div>
        );
      })()}
    </div>
  );
}
