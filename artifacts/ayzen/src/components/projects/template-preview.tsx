/**
 * components/projects/template-preview.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared between admin/projects.tsx (previewing a template against the
 * in-progress create-form) and admin/project-detail.tsx (previewing a
 * template against an already-existing project's current values) — one
 * diff renderer + confirmation modal so the two flows can't drift apart.
 *
 * Deliberately only shows rows for keys the template actually sets
 * (PROJECT_TEMPLATE_DATA_KEYS ∩ template.data) — a template is a partial
 * prefill, so fields it doesn't touch aren't part of "what would change".
 */
import { useMemo } from "react";
import { X, ArrowRight, Sparkles, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PROJECT_CREATE_FIELDS } from "@/config/fields/project-create";

// key -> human label + option value->label lookup, built once from the
// same field config the create form and template editor already use — so
// this never has to be kept in sync by hand.
const FIELD_LABELS: Record<string, string> = {};
const FIELD_VALUE_LABELS: Record<string, Record<string, string>> = {};
for (const f of PROJECT_CREATE_FIELDS) {
  FIELD_LABELS[f.key] = f.label.replace(/\s*\*$/, "");
  if ((f as any).options) {
    const map: Record<string, string> = {};
    for (const o of (f as any).options as { value: string; label: string }[]) map[o.value] = o.label;
    FIELD_VALUE_LABELS[f.key] = map;
  }
}

export function formatTemplateFieldValue(key: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (key === "badges") {
    const arr = Array.isArray(value) ? value : (() => { try { return JSON.parse(String(value)); } catch { return []; } })();
    return Array.isArray(arr) && arr.length ? arr.join(", ") : "—";
  }
  if (key === "tutorialSteps") {
    const arr = Array.isArray(value) ? value : (() => { try { return JSON.parse(String(value)); } catch { return null; } })();
    if (Array.isArray(arr)) return `${arr.length} step${arr.length === 1 ? "" : "s"}`;
    return String(value).slice(0, 40);
  }
  const mapped = FIELD_VALUE_LABELS[key]?.[String(value)];
  return mapped ?? String(value);
}

export interface TemplateDiffRow {
  key: string;
  label: string;
  from: string;
  to: string;
  changed: boolean;
}

// Builds one row per key the template sets, comparing against `current`
// (the in-progress form, or the existing project's fields).
export function buildTemplateDiff(templateData: Record<string, unknown>, current: Record<string, unknown>): TemplateDiffRow[] {
  return Object.keys(templateData)
    .filter(key => templateData[key] !== undefined && templateData[key] !== null && templateData[key] !== "")
    .map(key => {
      const from = formatTemplateFieldValue(key, current?.[key]);
      const to = formatTemplateFieldValue(key, templateData[key]);
      return { key, label: FIELD_LABELS[key] ?? key, from, to, changed: from !== to };
    });
}

interface TemplatePreviewModalProps {
  templateName: string;
  rows: TemplateDiffRow[];
  onConfirm?: () => void;
  onClose: () => void;
  confirmLabel?: string;
  /** Read-only mode (e.g. manager page's "Preview" action) — hides the confirm button. */
  readOnly?: boolean;
}

export function TemplatePreviewModal({ templateName, rows, onConfirm, onClose, confirmLabel = "Apply Template", readOnly }: TemplatePreviewModalProps) {
  const changedCount = useMemo(() => rows.filter(r => r.changed).length, [rows]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div className="bg-card border border-card-border rounded-xl w-full max-w-md shadow-2xl relative overflow-hidden flex flex-col max-h-[85vh]">
        <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent" />
        <div className="flex items-center justify-between px-5 py-4 border-b border-card-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {readOnly ? <Eye className="h-4 w-4 text-primary shrink-0" /> : <Sparkles className="h-4 w-4 text-primary shrink-0" />}
            <div className="min-w-0">
              <h2 className="font-mono font-bold uppercase tracking-wider text-primary text-xs truncate">
                {readOnly ? "Template Preview" : "Apply Template?"}
              </h2>
              <p className="text-[10px] font-mono text-muted-foreground truncate">{templateName}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 px-5 py-4">
          {rows.length === 0 ? (
            <p className="text-xs font-mono text-muted-foreground text-center py-6">This template doesn't set any fields.</p>
          ) : (
            <div className="space-y-1">
              {!readOnly && (
                <p className="text-[10px] font-mono text-muted-foreground/70 mb-2">
                  {changedCount > 0 ? `${changedCount} of ${rows.length} field${rows.length === 1 ? "" : "s"} will change` : "No changes — values already match"}
                </p>
              )}
              {rows.map(r => (
                <div key={r.key} className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs font-mono ${r.changed ? "bg-primary/5" : "opacity-50"}`}>
                  <span className="text-muted-foreground shrink-0 w-28 truncate">{r.label}</span>
                  <span className="flex items-center gap-1.5 min-w-0 justify-end text-right">
                    {r.changed && !readOnly ? (
                      <>
                        <span className="text-muted-foreground truncate max-w-[80px]">{r.from}</span>
                        <ArrowRight className="h-3 w-3 text-primary shrink-0" />
                        <span className="text-foreground font-bold truncate max-w-[100px]">{r.to}</span>
                      </>
                    ) : (
                      <span className="text-foreground truncate max-w-[140px]">{r.to}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-card-border shrink-0">
          <Button variant="ghost" onClick={onClose} className="font-mono text-xs">{readOnly ? "Close" : "Cancel"}</Button>
          {!readOnly && (
            <Button onClick={onConfirm} className="font-mono text-xs gap-1.5">
              <Sparkles className="h-3.5 w-3.5" /> {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
