import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ImagePlus, X, Plus, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FieldDef, GroupDef } from "@/config/types";

interface PillSelectProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}

/** Reads a picked file as a base64 data URL. This app has no object-storage
 *  backend configured, so uploads are embedded directly into the DB text
 *  column (thumbnail_url / banner_url) as data URLs — same pattern already
 *  used for those columns, just populated from a file picker instead of a
 *  pasted external URL. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function ImageField({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: any) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const maxMB = def.maxSizeMB ?? 3;
  const url = (value as string) ?? "";

  const handleFile = async (file: File | undefined) => {
    setError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("Please pick an image file"); return; }
    if (file.size > maxMB * 1024 * 1024) { setError(`Image must be under ${maxMB}MB`); return; }
    try {
      const dataUrl = await fileToDataUrl(file);
      onChange(dataUrl);
    } catch {
      setError("Couldn't read that file");
    }
  };

  return (
    <div className="space-y-1.5">
      {url ? (
        <div className="relative rounded-lg overflow-hidden border border-border/40 bg-muted/10">
          <img src={url} alt={def.label} className="w-full h-24 object-cover" />
          <button
            type="button"
            onClick={() => { onChange(""); if (inputRef.current) inputRef.current.value = ""; }}
            className="absolute top-1.5 right-1.5 p-1 rounded-full bg-black/60 text-white hover:bg-red-500/80 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="w-full h-24 rounded-lg border border-dashed border-border/50 flex flex-col items-center justify-center gap-1 text-muted-foreground/50 hover:text-primary hover:border-primary/40 transition-colors"
        >
          <ImagePlus className="w-4 h-4" />
          <span className="font-mono text-[9px] uppercase tracking-wider">Click to upload</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={e => handleFile(e.target.files?.[0])}
      />
      {error && <p className="text-[9px] font-mono text-red-400">{error}</p>}
    </div>
  );
}

export interface TutorialStep {
  title: string;
  description?: string;
  link?: string;
  // Phase 8A — optional "full step details" toggle, off by default. When
  // enabled, extra content (longer text, images, sub-steps) can be authored
  // alongside the basic title/description/link. Consumer-facing render of
  // this content is Phase 8B — this is authoring only.
  fullDetailsEnabled?: boolean;
  fullDetails?: TutorialStepFullDetails;
}

export interface TutorialStepFullDetails {
  text?: string;
  images?: string[];
  subSteps?: TutorialSubStep[];
}

export interface TutorialSubStep {
  title: string;
  description?: string;
}

function parseSteps(value: unknown): TutorialStep[] {
  if (Array.isArray(value)) return value as TutorialStep[];
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* ignore malformed JSON, fall through to empty */ }
  }
  return [];
}

/** Step-by-step tutorial builder — add/edit/reorder/remove steps, each with
 *  a title, optional description, and optional link. Serialized to a JSON
 *  string on change (matches how the field is persisted server-side). */
function StepListField({ value, onChange }: { value: unknown; onChange: (v: any) => void }) {
  const steps = parseSteps(value);

  const commit = (next: TutorialStep[]) => onChange(JSON.stringify(next));

  const addStep = () => commit([...steps, { title: "", description: "", link: "" }]);
  const updateStep = (i: number, patch: Partial<TutorialStep>) =>
    commit(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const removeStep = (i: number) => commit(steps.filter((_, idx) => idx !== i));
  const moveStep = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };

  // Phase 8A — merge a patch into one step's fullDetails without disturbing
  // its other fields. Toggling the switch off intentionally leaves any
  // already-authored fullDetails in place (re-enabling restores it) rather
  // than discarding it.
  const updateFullDetails = (i: number, patch: Partial<TutorialStepFullDetails>) =>
    updateStep(i, { fullDetails: { ...(steps[i].fullDetails ?? {}), ...patch } });

  return (
    <div className="space-y-2">
      {steps.length === 0 && (
        <p className="text-[10px] font-mono text-muted-foreground/40 text-center py-3 border border-dashed border-border/40 rounded-lg">
          No steps yet — add the first one below
        </p>
      )}
      {steps.map((step, i) => (
        <div key={i} className="rounded-lg border border-border/40 bg-muted/5 p-2.5 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <GripVertical className="w-3 h-3 text-muted-foreground/30 shrink-0" />
            <span className="font-mono text-[9px] text-muted-foreground/50 shrink-0">Step {i + 1}</span>
            <Input
              value={step.title}
              onChange={e => updateStep(i, { title: e.target.value })}
              placeholder="Step title, e.g. Connect your wallet"
              className="bg-input border-border font-mono text-xs h-7 flex-1"
            />
            <button type="button" onClick={() => moveStep(i, -1)} disabled={i === 0} className="text-muted-foreground/40 hover:text-primary disabled:opacity-20 text-xs px-1">↑</button>
            <button type="button" onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="text-muted-foreground/40 hover:text-primary disabled:opacity-20 text-xs px-1">↓</button>
            <button type="button" onClick={() => removeStep(i)} className="text-muted-foreground/40 hover:text-red-400 shrink-0">
              <X className="w-3 h-3" />
            </button>
          </div>
          <Textarea
            value={step.description ?? ""}
            onChange={e => updateStep(i, { description: e.target.value })}
            placeholder="What should the operator do in this step?"
            rows={2}
            className="bg-input border-border font-mono text-[11px] resize-none"
          />
          <Input
            value={step.link ?? ""}
            onChange={e => updateStep(i, { link: e.target.value })}
            placeholder="Optional link for this step (docs, video, dapp URL...)"
            className="bg-input border-border font-mono text-[10px] h-7"
          />
          {/* Phase 8A — "full step details" toggle, off by default. Extra
              content (longer text/images/sub-steps) is only shown/authored
              when enabled; steps left off render/persist exactly as before. */}
          <div className="flex items-center justify-between pt-1 border-t border-border/20">
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/50">
              Full step details
            </span>
            <Switch
              checked={!!step.fullDetailsEnabled}
              onCheckedChange={checked => updateStep(i, { fullDetailsEnabled: checked })}
            />
          </div>
          {step.fullDetailsEnabled && (
            <FullDetailsPanel
              fullDetails={step.fullDetails ?? {}}
              onChange={patch => updateFullDetails(i, patch)}
            />
          )}
        </div>
      ))}
      <Button type="button" variant="outline" onClick={addStep} className="w-full font-mono text-[10px] h-8 gap-1.5">
        <Plus className="w-3 h-3" /> Add Step
      </Button>
    </div>
  );
}

/** Phase 8A — the extra content authored for a step when its "full step
 *  details" toggle is on: a longer free-text block, any number of images
 *  (same data-URL upload pattern as ImageField, since there's no
 *  object-storage backend), and an optional list of sub-steps (title +
 *  description each, no further nesting). */
function FullDetailsPanel({
  fullDetails, onChange,
}: {
  fullDetails: TutorialStepFullDetails;
  onChange: (patch: Partial<TutorialStepFullDetails>) => void;
}) {
  const images = fullDetails.images ?? [];
  const subSteps = fullDetails.subSteps ?? [];
  const imageInputRef = useRef<HTMLInputElement>(null);

  const addImage = async (file: File | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    }).catch(() => null);
    if (dataUrl) onChange({ images: [...images, dataUrl] });
  };
  const removeImage = (idx: number) => onChange({ images: images.filter((_, i) => i !== idx) });

  const addSubStep = () => onChange({ subSteps: [...subSteps, { title: "", description: "" }] });
  const updateSubStep = (idx: number, patch: Partial<TutorialSubStep>) =>
    onChange({ subSteps: subSteps.map((s, i) => (i === idx ? { ...s, ...patch } : s)) });
  const removeSubStep = (idx: number) => onChange({ subSteps: subSteps.filter((_, i) => i !== idx) });

  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-2.5 space-y-2.5">
      {/* Longer text */}
      <div className="space-y-1">
        <Label className="font-mono text-[9px] uppercase tracking-wider text-violet-400/70">Extended text</Label>
        <Textarea
          value={fullDetails.text ?? ""}
          onChange={e => onChange({ text: e.target.value })}
          placeholder="Longer walkthrough content for this step..."
          rows={3}
          className="bg-input border-border font-mono text-[11px] resize-none"
        />
      </div>

      {/* Images */}
      <div className="space-y-1">
        <Label className="font-mono text-[9px] uppercase tracking-wider text-violet-400/70">Images</Label>
        <div className="flex flex-wrap gap-1.5">
          {images.map((src, idx) => (
            <div key={idx} className="relative w-14 h-14 rounded border border-border/40 overflow-hidden shrink-0">
              <img src={src} alt="" className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(idx)}
                className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white hover:bg-red-500/80"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => imageInputRef.current?.click()}
            className="w-14 h-14 rounded border border-dashed border-border/50 flex items-center justify-center text-muted-foreground/50 hover:text-primary hover:border-primary/40 transition-colors shrink-0"
          >
            <ImagePlus className="w-3.5 h-3.5" />
          </button>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={e => { addImage(e.target.files?.[0]); e.target.value = ""; }}
          />
        </div>
      </div>

      {/* Sub-steps */}
      <div className="space-y-1">
        <Label className="font-mono text-[9px] uppercase tracking-wider text-violet-400/70">Sub-steps</Label>
        {subSteps.map((sub, idx) => (
          <div key={idx} className="flex items-start gap-1.5">
            <div className="flex-1 space-y-1">
              <Input
                value={sub.title}
                onChange={e => updateSubStep(idx, { title: e.target.value })}
                placeholder={`Sub-step ${idx + 1} title`}
                className="bg-input border-border font-mono text-[11px] h-7"
              />
              <Input
                value={sub.description ?? ""}
                onChange={e => updateSubStep(idx, { description: e.target.value })}
                placeholder="Optional detail"
                className="bg-input border-border font-mono text-[10px] h-7"
              />
            </div>
            <button type="button" onClick={() => removeSubStep(idx)} className="text-muted-foreground/40 hover:text-red-400 mt-1">
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <Button type="button" variant="outline" onClick={addSubStep} className="w-full font-mono text-[9px] h-7 gap-1.5">
          <Plus className="w-3 h-3" /> Add Sub-step
        </Button>
      </div>
    </div>
  );
}

/** Same pill-button select style used across these create dialogs
 *  (previously a private component duplicated per-page as `PillSelect`). */
function PillSelect({ options, value, onChange }: PillSelectProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={cn(
            "px-3 py-1 rounded-full font-mono text-[10px] border transition-all",
            value === opt.value
              ? "bg-primary/20 border-primary/50 text-primary font-bold"
              : "border-border/40 text-muted-foreground/60 hover:border-primary/30 hover:text-primary/60"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function FieldControl({
  def, value, form, onChange,
}: {
  def: FieldDef;
  value: unknown;
  form: Record<string, any>;
  onChange: (v: any) => void;
}) {
  if (def.type === "image") {
    return <ImageField def={def} value={value} onChange={onChange} />;
  }

  if (def.type === "steps") {
    return <StepListField value={value} onChange={onChange} />;
  }

  // dynamicOptions (used by cascading selects like Category → Subcategory →
  // Type) takes priority over a fixed `options` array when present.
  const resolvedOptions = def.dynamicOptions ? def.dynamicOptions(form) : (def.options ?? []);

  if (def.type === "select" && def.uiVariant === "pills") {
    return <PillSelect options={resolvedOptions} value={(value as string) ?? ""} onChange={onChange} />;
  }

  if (def.type === "select") {
    return (
      <Select value={(value as string) ?? ""} onValueChange={onChange}>
        <SelectTrigger className="bg-input border-border font-mono text-xs h-9">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {resolvedOptions.map(opt => (
            <SelectItem key={opt.value} value={opt.value} className="font-mono text-xs">{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (def.type === "textarea") {
    return (
      <Textarea
        value={(value as string) ?? ""}
        onChange={e => onChange(e.target.value)}
        placeholder={def.placeholder}
        className={cn("bg-input border-border font-mono resize-none", def.compact && "text-xs")}
        rows={def.rows ?? 3}
      />
    );
  }

  return (
    <Input
      type={def.type === "number" ? "number" : def.type === "date" ? "date" : def.type === "password" ? "password" : "text"}
      value={(value as string) ?? ""}
      onChange={e => onChange(e.target.value)}
      placeholder={def.placeholder}
      step={def.step}
      min={def.min}
      autoFocus={def.autoFocus}
      className={cn("bg-input border-border font-mono", def.compact && "text-xs h-8")}
    />
  );
}

function FieldBlock({
  def, value, form, onChange,
}: {
  def: FieldDef;
  value: unknown;
  form: Record<string, any>;
  onChange: (v: any) => void;
}) {
  return (
    <div className={def.group ? "space-y-1" : "space-y-1.5"}>
      <Label className={cn(
        "font-mono uppercase tracking-widest text-muted-foreground",
        def.group ? "text-[9px]" : "text-[10px]"
      )}>
        {def.label}
      </Label>
      <FieldControl def={def} value={value} form={form} onChange={onChange} />
      {def.help && (
        <p className={def.helpClassName ?? "text-[9px] font-mono text-muted-foreground/50"}>{def.help}</p>
      )}
    </div>
  );
}

function chunkByGroup(fields: FieldDef[]): { group?: string; fields: FieldDef[] }[] {
  const chunks: { group?: string; fields: FieldDef[] }[] = [];
  for (const f of fields) {
    const last = chunks[chunks.length - 1];
    if (last && last.group === f.group) last.fields.push(f);
    else chunks.push({ group: f.group, fields: [f] });
  }
  return chunks;
}

function chunkByPair(fields: FieldDef[]): FieldDef[][] {
  const rows: FieldDef[][] = [];
  for (const f of fields) {
    const last = rows[rows.length - 1];
    if (f.pairKey && last && last[last.length - 1].pairKey === f.pairKey) last.push(f);
    else rows.push([f]);
  }
  return rows;
}

/** Tailwind needs static class strings (no dynamic `grid-cols-${n}`), so a
 *  row's column count is looked up here rather than interpolated. Extend
 *  this map if a future row ever needs more than 3 columns. */
const ROW_COLS: Record<number, string> = { 2: "grid-cols-2", 3: "grid-cols-3" };

interface SchemaFormProps {
  fields: FieldDef[];
  groups?: Record<string, GroupDef>;
  tab?: string;
  form: Record<string, any>;
  onChange: (key: string, value: any) => void;
}

/**
 * Renders one tab's worth of fields from a FIELDS array, honoring each
 * field's group (boxed section), pairKey (2-col row), and showIf
 * (conditional visibility) — so a page's create/edit dialog stays generic
 * JSX that never needs editing to add, remove, reorder, or hide a field.
 */
export function SchemaForm({ fields, groups, tab, form, onChange }: SchemaFormProps) {
  const visible = fields
    .filter(f => (tab === undefined || f.tab === tab))
    .filter(f => !f.showIf || f.showIf(form));

  // Wraps the raw onChange so cascading selects (Category → Subcategory →
  // Type) can declare `resetsFields` and have the now-invalid downstream
  // selections cleared automatically instead of left stale.
  const handleChange = (def: FieldDef, value: any) => {
    onChange(def.key, value);
    def.resetsFields?.forEach(key => onChange(key, ""));
  };

  const groupChunks = chunkByGroup(visible);

  return (
    <>
      {groupChunks.map((chunk, i) => {
        const rows = chunkByPair(chunk.fields);
        const rowsEl = rows.map((row, ri) =>
          row.length > 1 ? (
            <div key={ri} className={cn("grid", ROW_COLS[row.length] ?? "grid-cols-2", row[0].pairGap ?? "gap-3")}>
              {row.map(f => (
                <FieldBlock key={f.key} def={f} value={form[f.key]} form={form} onChange={v => handleChange(f, v)} />
              ))}
            </div>
          ) : (
            <FieldBlock key={row[0].key} def={row[0]} value={form[row[0].key]} form={form} onChange={v => handleChange(row[0], v)} />
          )
        );

        const groupDef = chunk.group ? groups?.[chunk.group] : undefined;
        if (!groupDef) {
          return <div key={i} className="space-y-4">{rowsEl}</div>;
        }

        const Icon = groupDef.icon;
        return (
          <div key={i} className={groupDef.boxClassName}>
            <div className="flex items-center gap-1.5">
              <Icon className={cn("w-3 h-3", groupDef.headerClassName)} />
              <span className={cn("font-mono text-[10px] uppercase tracking-widest font-bold", groupDef.headerClassName)}>
                {groupDef.label}
              </span>
            </div>
            <div className="space-y-2">{rowsEl}</div>
            {groupDef.help && (
              <p className="text-[9px] font-mono text-muted-foreground/60">{groupDef.help}</p>
            )}
          </div>
        );
      })}
    </>
  );
}
