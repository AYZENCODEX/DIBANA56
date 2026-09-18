import { useMemo, useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  PALETTE_VAR_GROUPS, PALETTE_VAR_LABELS, hexToHslTriplet, hslTripletToHex,
  type PaletteVars,
} from "@/lib/theme-palettes";
import { PaintBucket, Shuffle, Wand2 } from "lucide-react";

const BASE_DARK: PaletteVars = {
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
};

const BASE_LIGHT: PaletteVars = {
  background: "210 30% 97%", foreground: "220 40% 14%",
  card: "0 0% 100%", cardForeground: "220 40% 14%", cardBorder: "210 25% 88%",
  popover: "0 0% 100%", popoverForeground: "220 40% 14%", popoverBorder: "210 25% 88%",
  primary: "265 55% 45%", primaryForeground: "0 0% 100%",
  secondary: "215 30% 55%", secondaryForeground: "0 0% 100%",
  muted: "210 25% 93%", mutedForeground: "215 15% 40%",
  accent: "213 45% 92%", accentForeground: "265 55% 35%",
  border: "210 25% 87%", input: "210 25% 91%", ring: "265 55% 45%",
  sidebarBackground: "210 30% 96%", sidebarForeground: "220 30% 25%",
  sidebarPrimary: "265 55% 45%", sidebarPrimaryForeground: "0 0% 100%",
  sidebarAccent: "213 45% 90%", sidebarAccentForeground: "265 55% 35%",
  sidebarBorder: "210 25% 86%", sidebarRing: "265 55% 45%",
};

/** Derives a full palette from a single hue by re-tinting a base template —
 *  gives a decent starting point before the person fine-tunes individual swatches. */
function tintFromHue(hue: number, isLight: boolean): PaletteVars {
  const base = isLight ? BASE_LIGHT : BASE_DARK;
  const shift = (hsl: string) => {
    const m = hsl.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
    if (!m) return hsl;
    return `${hue} ${m[2]}`;
  };
  const out: any = {};
  for (const k of Object.keys(base) as (keyof PaletteVars)[]) out[k] = shift(base[k]);
  return out;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (payload: { name: string; description?: string; isLight: boolean; swatch: [string, string, string]; vars: PaletteVars }) => Promise<void>;
}

export function PaletteBuilderDialog({ open, onOpenChange, onSave }: Props) {
  const [name, setName] = useState("");
  const [isLight, setIsLight] = useState(false);
  const [vars, setVars] = useState<PaletteVars>(BASE_DARK);
  const [saving, setSaving] = useState(false);

  const swatch = useMemo<[string, string, string]>(() => [
    `hsl(${vars.background})`, `hsl(${vars.primary})`, `hsl(${vars.accent})`,
  ], [vars]);

  const setVar = (key: keyof PaletteVars, hex: string) => {
    setVars(prev => ({ ...prev, [key]: hexToHslTriplet(hex) }));
  };

  const randomizeHue = () => {
    const hue = Math.floor(Math.random() * 360);
    setVars(tintFromHue(hue, isLight));
  };

  const toggleMode = (light: boolean) => {
    setIsLight(light);
    setVars(light ? BASE_LIGHT : BASE_DARK);
  };

  const reset = () => { setName(""); setIsLight(false); setVars(BASE_DARK); };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), isLight, swatch, vars });
      reset();
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><PaintBucket className="w-4 h-4 text-primary" /> Build a Palette</DialogTitle>
          <DialogDescription>
            Pick colors for every part of the UI, then save it into the palette library — it'll show up
            next to the built-in palettes for anyone to select.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Palette name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Midnight Coral" />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Label className="text-xs">Light mode</Label>
              <Switch checked={isLight} onCheckedChange={toggleMode} />
            </div>
            <Button type="button" variant="outline" size="sm" className="gap-1.5 h-9" onClick={randomizeHue}>
              <Shuffle className="w-3.5 h-3.5" /> Random hue
            </Button>
          </div>

          <div className="flex gap-1.5">
            {swatch.map((c, i) => <div key={i} className="w-8 h-8 rounded-lg border border-black/10" style={{ background: c }} />)}
            <div className="flex-1 rounded-lg border border-border/40 flex items-center px-3 text-[11px] text-muted-foreground font-mono">
              <Wand2 className="w-3 h-3 mr-1.5" /> Preview swatch — background / primary / accent
            </div>
          </div>

          <div className="space-y-4">
            {PALETTE_VAR_GROUPS.map(group => (
              <div key={group.label} className="space-y-2">
                <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">{group.label}</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  {group.keys.map(key => (
                    <div key={key} className="flex items-center gap-2 rounded-lg border border-border/40 px-2 py-1.5">
                      <input
                        type="color"
                        value={hslTripletToHex(vars[key])}
                        onChange={(e) => setVar(key, e.target.value)}
                        className="w-6 h-6 rounded border border-black/10 cursor-pointer shrink-0 bg-transparent"
                      />
                      <span className="text-[10px] font-mono truncate">{PALETTE_VAR_LABELS[key]}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>{saving ? "Saving…" : "Save to library"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
