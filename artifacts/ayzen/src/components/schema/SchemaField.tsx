import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FieldDef } from "@/config/types";

interface SchemaFieldProps {
  def: FieldDef;
  value: unknown;
  onChange: (value: any) => void;
  className?: string;
}

/**
 * Renders one form control from a FieldDef, using the same existing UI
 * primitives (Input / Select / Textarea / Switch) and styling conventions
 * already used across the create/edit dialogs in this app.
 *
 * Pages migrated to config-driven fields render their whole form as:
 *   {FIELDS.map(f => (
 *     <SchemaField key={f.key} def={f} value={form[f.key]} onChange={v => setForm(p => ({ ...p, [f.key]: v }))} />
 *   ))}
 */
export function SchemaField({ def, value, onChange, className }: SchemaFieldProps) {
  const inputClass = "bg-input border-border font-mono text-xs h-9";

  return (
    <div className={className ?? "space-y-1.5"}>
      <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
        {def.label}
        {def.required && <span className="text-red-400 ml-0.5">*</span>}
      </Label>

      {def.type === "text" && (
        <Input
          value={(value as string) ?? ""}
          placeholder={def.placeholder}
          onChange={e => onChange(e.target.value)}
          className={inputClass}
        />
      )}

      {def.type === "number" && (
        <Input
          type="number"
          value={(value as string | number) ?? ""}
          placeholder={def.placeholder}
          onChange={e => onChange(e.target.value)}
          className={inputClass}
        />
      )}

      {def.type === "date" && (
        <Input
          type="date"
          value={(value as string) ?? ""}
          onChange={e => onChange(e.target.value)}
          className={inputClass}
        />
      )}

      {def.type === "textarea" && (
        <Textarea
          value={(value as string) ?? ""}
          placeholder={def.placeholder}
          onChange={e => onChange(e.target.value)}
          className="bg-input border-border font-mono text-xs resize-none"
          rows={3}
        />
      )}

      {def.type === "select" && (
        <Select value={(value as string) ?? ""} onValueChange={onChange}>
          <SelectTrigger className={inputClass}>
            <SelectValue placeholder={def.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {(def.options ?? []).map(opt => (
              <SelectItem key={opt.value} value={opt.value} className="font-mono text-xs">
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {def.type === "toggle" && (
        <Switch checked={Boolean(value)} onCheckedChange={onChange} />
      )}
    </div>
  );
}
