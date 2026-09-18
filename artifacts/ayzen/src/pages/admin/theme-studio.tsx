import { useRef, useState } from "react";
import { useUiTheme, type CustomTheme, type ThemeOverridableFields } from "@/hooks/use-ui-theme";
import { PALETTES, type PaletteVars } from "@/lib/theme-palettes";
import { PAGE_LIST } from "@/lib/route-config";
import { importTheme } from "@/lib/theme-import";
import { PaletteBuilderDialog } from "./theme-palette-builder";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Palette, Check, Contrast, Type, LayoutTemplate, Rows3, Sparkles,
  Upload, Trash2, Download, AlignJustify, PaintBucket, FileStack, RotateCcw, Wand2,
} from "lucide-react";

// A ready-to-edit starter file — mirrors PaletteVars exactly so anyone can
// tweak the HSL triplets in a text editor and re-upload.
const TEMPLATE: { name: string; description: string; isLight: boolean; vars: PaletteVars } = {
  name: "My Custom Theme",
  description: "Edit the HSL values below, then upload this file",
  isLight: false,
  vars: {
    background: "230 15% 7%", foreground: "220 15% 92%",
    card: "230 15% 9%", cardForeground: "220 15% 92%", cardBorder: "230 15% 18%",
    popover: "230 15% 9%", popoverForeground: "220 15% 92%", popoverBorder: "230 15% 18%",
    primary: "265 60% 60%", primaryForeground: "0 0% 100%",
    secondary: "230 10% 40%", secondaryForeground: "0 0% 100%",
    muted: "230 15% 14%", mutedForeground: "220 10% 58%",
    accent: "265 30% 18%", accentForeground: "265 40% 88%",
    border: "230 15% 18%", input: "230 15% 11%", ring: "265 60% 60%",
    sidebarBackground: "230 17% 6%", sidebarForeground: "220 12% 75%",
    sidebarPrimary: "265 60% 60%", sidebarPrimaryForeground: "0 0% 100%",
    sidebarAccent: "265 25% 15%", sidebarAccentForeground: "265 35% 90%",
    sidebarBorder: "230 15% 16%", sidebarRing: "265 60% 60%",
  },
};

function downloadTemplate() {
  const blob = new Blob([JSON.stringify(TEMPLATE, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ayzen-theme-template.json";
  a.click();
  URL.revokeObjectURL(url);
}

export default function AdminThemeStudio() {
  const {
    theme, customThemes, update, uploadCustomTheme, deleteCustomTheme, isLoading,
    pageOverrides, getOverrideForPage, savePageOverride, deletePageOverride,
  } = useUiTheme();
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<CustomTheme | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [selectedPage, setSelectedPage] = useState<string>(PAGE_LIST[0]?.path ?? "/dashboard");
  const [savingOverride, setSavingOverride] = useState(false);

  const activeOverride = getOverrideForPage(selectedPage);
  const overriddenPageCount = pageOverrides.length;

  const patchOverride = async (patch: ThemeOverridableFields) => {
    setSavingOverride(true);
    try {
      await savePageOverride(selectedPage, patch);
      toast({ title: "Page override updated", description: `Applies only to ${selectedPage}` });
    } catch (err: any) {
      toast({ title: "Couldn't save override", description: err?.message, variant: "destructive" as any });
    } finally {
      setSavingOverride(false);
    }
  };

  const resetPageToGlobal = async () => {
    await deletePageOverride(selectedPage);
    toast({ title: "Reverted to global theme", description: selectedPage });
  };

  const setPalette = (id: string) => { update({ paletteId: id }); toast({ title: "Palette updated" }); };

  const handleFilePick = () => fileRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const text = await file.text();
      // importTheme() handles any format: our own schema, a shadcn/tweakcn
      // registry export ({ cssVars: { light, dark } }), a raw :root/.dark CSS
      // file downloaded from any theme marketplace, or a flat var-name→color
      // JSON map. Colors are normalized (hex/rgb/hsl/oklch) to our HSL triplets
      // and any vars the source theme didn't define are filled with sane
      // fallbacks, so a real-world "bought from some website" file just works.
      const parsed = importTheme(text, file.name);
      const created = await uploadCustomTheme({
        name: parsed.name,
        description: parsed.description,
        isLight: parsed.isLight,
        swatch: parsed.swatch,
        vars: parsed.vars,
      });
      if (created) {
        toast({ title: "Custom theme uploaded", description: `"${created.name}" is now available in the palette grid.` });
      }
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message || "Couldn't read that theme file.", variant: "destructive" as any });
    } finally {
      setUploading(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteCustomTheme(pendingDelete.id);
    toast({ title: "Custom theme removed" });
    setPendingDelete(null);
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center gap-2.5">
        <Palette className="w-5 h-5 text-primary" />
        <div>
          <h1 className="text-lg font-mono font-semibold">Theme Studio</h1>
          <p className="text-xs text-muted-foreground font-mono">
            Configure the platform's color, layout, font, and style. Build your own palettes, save them to the
            library, and override any page's theme or layout independently of the global default.
          </p>
        </div>
      </div>

      {/* Color palette */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><Palette className="w-3.5 h-3.5" /> Color Palette</Label>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1.5" onClick={downloadTemplate}>
                <Download className="w-3 h-3" /> Starter file
              </Button>
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1.5" onClick={() => setBuilderOpen(true)}>
                <Wand2 className="w-3 h-3" /> Build palette
              </Button>
              <input ref={fileRef} type="file" accept="application/json,.json,text/css,.css" className="hidden" onChange={handleFileChange} />
              <Button size="sm" className="h-7 text-[11px] gap-1.5" onClick={handleFilePick} disabled={uploading}>
                <Upload className="w-3 h-3" /> {uploading ? "Uploading…" : "Upload theme"}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {PALETTES.map(p => {
              const active = theme.paletteId === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => setPalette(p.id)}
                  className={cn(
                    "text-left rounded-xl border p-3 transition-all",
                    active ? "border-primary/50 bg-primary/5 shadow-[0_0_0_1px_rgba(34,211,238,0.15)]" : "border-border/40 hover:border-border"
                  )}
                >
                  <div className="flex gap-1 mb-2">
                    {p.swatch.map((c, i) => (
                      <div key={i} className="w-5 h-5 rounded-full border border-black/10" style={{ background: c }} />
                    ))}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono font-semibold">{p.name}</span>
                    {active && <Check className="w-3 h-3 text-primary" />}
                  </div>
                  <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{p.description}</p>
                </button>
              );
            })}

            {customThemes.map(p => {
              const active = theme.paletteId === p.id;
              return (
                <div
                  key={p.id}
                  className={cn(
                    "relative text-left rounded-xl border p-3 transition-all group",
                    active ? "border-primary/50 bg-primary/5 shadow-[0_0_0_1px_rgba(34,211,238,0.15)]" : "border-border/40 hover:border-border"
                  )}
                >
                  <button onClick={() => setPalette(p.id)} className="text-left w-full">
                    <div className="flex gap-1 mb-2">
                      {p.swatch.map((c, i) => (
                        <div key={i} className="w-5 h-5 rounded-full border border-black/10" style={{ background: c }} />
                      ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-mono font-semibold truncate max-w-[7rem]">{p.name}</span>
                      {active && <Check className="w-3 h-3 text-primary shrink-0" />}
                    </div>
                    <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">{p.description || "Custom upload"}</p>
                  </button>
                  <Badge variant="outline" className="absolute top-2 right-2 text-[9px] px-1 py-0 opacity-70">custom</Badge>
                  <button
                    onClick={() => setPendingDelete(p)}
                    className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                    title="Delete custom theme"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-[10px] text-muted-foreground/70 font-mono">
            Upload a theme file to add your own palette — works with our starter JSON, or a theme exported from
            tweakcn / ui.shadcn.com / any other theme generator (.json or .css, light or dark).
          </p>
        </CardContent>
      </Card>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* Contrast */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><Contrast className="w-3.5 h-3.5" /> Contrast</Label>
            <Select value={theme.contrast} onValueChange={(v) => update({ contrast: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High contrast</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Text / UI size */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><Type className="w-3.5 h-3.5" /> Size</Label>
            <Select value={theme.textSize} onValueChange={(v) => update({ textSize: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sm">Small</SelectItem>
                <SelectItem value="md">Medium</SelectItem>
                <SelectItem value="lg">Large</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Font */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><AlignJustify className="w-3.5 h-3.5" /> Font</Label>
            <Select value={theme.fontFamily} onValueChange={(v) => update({ fontFamily: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mono">Mono (default)</SelectItem>
                <SelectItem value="sans">Sans</SelectItem>
                <SelectItem value="serif">Serif</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Style / corner radius */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><PaintBucket className="w-3.5 h-3.5" /> Style</Label>
            <Select value={theme.radius} onValueChange={(v) => update({ radius: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sharp">Sharp</SelectItem>
                <SelectItem value="soft">Soft (default)</SelectItem>
                <SelectItem value="round">Round</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Sidebar width */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><LayoutTemplate className="w-3.5 h-3.5" /> Sidebar Layout</Label>
            <Select value={theme.sidebarWidth} onValueChange={(v) => update({ sidebarWidth: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="narrow">Narrow</SelectItem>
                <SelectItem value="default">Default</SelectItem>
                <SelectItem value="wide">Wide</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>

        {/* Density */}
        <Card>
          <CardContent className="p-4 space-y-3">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><Rows3 className="w-3.5 h-3.5" /> Sidebar Density</Label>
            <Select value={theme.density} onValueChange={(v) => update({ density: v as any })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Compact</SelectItem>
                <SelectItem value="comfortable">Comfortable</SelectItem>
                <SelectItem value="spacious">Spacious</SelectItem>
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </div>

      {/* Sidebar animation */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground"><Sparkles className="w-3.5 h-3.5" /> Sidebar Animation</Label>
          <p className="text-[11px] text-muted-foreground font-mono -mt-1">Expand/collapse speed for categories and sections.</p>
          <Select value={theme.sidebarAnimationSpeed} onValueChange={(v) => update({ sidebarAnimationSpeed: v as any })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off (instant)</SelectItem>
              <SelectItem value="fast">Fast</SelectItem>
              <SelectItem value="normal">Normal (default)</SelectItem>
              <SelectItem value="slow">Slow</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* Per-page theme & layout overrides */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <Label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
              <FileStack className="w-3.5 h-3.5" /> Per-Page Overrides
            </Label>
            {overriddenPageCount > 0 && (
              <Badge variant="outline" className="text-[10px]">{overriddenPageCount} page{overriddenPageCount === 1 ? "" : "s"} customized</Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground font-mono -mt-1">
            Give any page — a project, the vault, marketplace — its own palette and layout, independent of the
            global theme above. Unset fields keep inheriting from global.
          </p>

          <div className="flex items-center gap-2">
            <Select value={selectedPage} onValueChange={setSelectedPage}>
              <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
              <SelectContent className="max-h-72">
                {PAGE_LIST.map(p => (
                  <SelectItem key={p.path} value={p.path}>
                    {p.group === "admin" ? "Admin › " : ""}{p.label}
                    {pageOverrides.some(o => o.pageKey === p.path) ? " •" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeOverride ? (
              <Badge className="text-[10px]">custom</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px]">inherits global</Badge>
            )}
            {activeOverride && (
              <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1.5" onClick={resetPageToGlobal} disabled={savingOverride}>
                <RotateCcw className="w-3 h-3" /> Reset to global
              </Button>
            )}
          </div>

          <div className="grid sm:grid-cols-2 gap-3 pt-1">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Palette (this page)</Label>
              <Select
                value={activeOverride?.paletteId ?? "__inherit__"}
                onValueChange={(v) => patchOverride({ paletteId: v === "__inherit__" ? null as any : v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit global ({theme.paletteId})</SelectItem>
                  {PALETTES.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
                  {customThemes.map(p => <SelectItem key={p.id} value={p.id}>{p.name} (custom)</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Contrast (this page)</Label>
              <Select
                value={activeOverride?.contrast ?? "__inherit__"}
                onValueChange={(v) => patchOverride({ contrast: v === "__inherit__" ? null as any : (v as any) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit global ({theme.contrast})</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High contrast</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Layout — density (this page)</Label>
              <Select
                value={activeOverride?.density ?? "__inherit__"}
                onValueChange={(v) => patchOverride({ density: v === "__inherit__" ? null as any : (v as any) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit global ({theme.density})</SelectItem>
                  <SelectItem value="compact">Compact</SelectItem>
                  <SelectItem value="comfortable">Comfortable</SelectItem>
                  <SelectItem value="spacious">Spacious</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Layout — sidebar width (this page)</Label>
              <Select
                value={activeOverride?.sidebarWidth ?? "__inherit__"}
                onValueChange={(v) => patchOverride({ sidebarWidth: v === "__inherit__" ? null as any : (v as any) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit global ({theme.sidebarWidth})</SelectItem>
                  <SelectItem value="narrow">Narrow</SelectItem>
                  <SelectItem value="default">Default</SelectItem>
                  <SelectItem value="wide">Wide</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Layout — corner style (this page)</Label>
              <Select
                value={activeOverride?.radius ?? "__inherit__"}
                onValueChange={(v) => patchOverride({ radius: v === "__inherit__" ? null as any : (v as any) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit global ({theme.radius})</SelectItem>
                  <SelectItem value="sharp">Sharp</SelectItem>
                  <SelectItem value="soft">Soft</SelectItem>
                  <SelectItem value="round">Round</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Text size (this page)</Label>
              <Select
                value={activeOverride?.textSize ?? "__inherit__"}
                onValueChange={(v) => patchOverride({ textSize: v === "__inherit__" ? null as any : (v as any) })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__inherit__">Inherit global ({theme.textSize})</SelectItem>
                  <SelectItem value="sm">Small</SelectItem>
                  <SelectItem value="md">Medium</SelectItem>
                  <SelectItem value="lg">Large</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <PaletteBuilderDialog
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        onSave={async (payload) => {
          try {
            const created = await uploadCustomTheme(payload);
            if (created) toast({ title: "Palette saved", description: `"${created.name}" added to the library.` });
          } catch (err: any) {
            toast({ title: "Couldn't save palette", description: err?.message, variant: "destructive" as any });
          }
        }}
      />

      {/* Live preview */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">Live Preview</Label>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="sm">Primary Action</Button>
            <Button size="sm" variant="outline">Outline</Button>
            <Button size="sm" variant="secondary">Secondary</Button>
            <Badge>Badge</Badge>
            <Badge variant="outline">Outline Badge</Badge>
          </div>
          <div className="rounded-lg border border-border p-3 bg-muted/20 text-sm font-mono text-muted-foreground">
            This card, the sidebar, and every screen update live as you change any setting above.
          </div>
        </CardContent>
      </Card>

      {isLoading && <p className="text-[11px] text-muted-foreground font-mono">Syncing theme…</p>}

      {/* Delete confirmation */}
      <Dialog open={!!pendingDelete} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{pendingDelete?.name}"?</DialogTitle>
            <DialogDescription>
              This removes the uploaded theme for everyone. If it's the active palette, the platform will fall back to Ash.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
