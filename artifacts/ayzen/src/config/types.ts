import type { ElementType } from "react";

// Shared config-schema types for the config-driven UI pattern.
// See UI_CONFIG_PLAN.md — these are the three shapes every migrated
// page's config/ arrays conform to: FieldDef (create/edit forms),
// ColumnDef (table/list/dashboard views), ActionDef (submit buttons).

export interface SelectOption {
  value: string;
  label: string;
}

export interface FieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "toggle" | "date" | "password" | "image" | "steps";
  options?: SelectOption[]; // required when type === "select" (ignored if dynamicOptions is set)
  /** For type === "select": compute the option list from the current form
   *  state instead of a fixed `options` array — used for cascading selects
   *  like Category → Subcategory → Type, where each step's choices depend
   *  on the step before it. Takes priority over `options` when present. */
  dynamicOptions?: (form: Record<string, any>) => SelectOption[];
  required?: boolean;
  placeholder?: string;

  // ── Extensions used by multi-tab / multi-section create-edit dialogs ──
  // (first needed migrating pages/admin/projects.tsx's 4-tab create dialog;
  // kept generic here so any future FIELDS array can opt into the same
  // layout behavior in its shared <SchemaForm>.)

  /** Which tab of the dialog this field appears on (omit for single-tab forms). */
  tab?: string;
  /** Which nested sub-tab (within `tab`) this field appears on, for dialogs
   *  that group one tab's fields into further sub-sections (e.g. the entity
   *  Account tab's Main / Info / Recovery / Wallet sub-tabs). Consumers filter
   *  on this themselves before calling <SchemaForm> — it isn't read by
   *  SchemaForm's own tab filter. Omit for forms without sub-tabs. */
  subtab?: string;
  /** Groups consecutive fields sharing the same id into one bordered/boxed
   *  section (e.g. "Social Links", "XP System"). Looked up in the page's
   *  GROUPS map. Omit for a field that isn't part of a visual group. */
  group?: string;
  /** Consecutive fields sharing the same pairKey render side-by-side in a
   *  2-column row instead of full width, stacked. */
  pairKey?: string;
  /** Gap size class suffix for the 2-column row (e.g. "gap-2", "gap-3").
   *  Defaults to "gap-3". */
  pairGap?: string;
  /** Caption shown under the field, in the same muted small-print style
   *  used across these forms (e.g. "Leave blank if no known deadline"). */
  help?: string;
  /** Override the caption's className — only needed where the original
   *  markup used a different muted-text opacity than the default. */
  helpClassName?: string;
  /** For type === "select": render as pill-buttons (PillSelect) instead of
   *  a native dropdown. Defaults to "dropdown". */
  uiVariant?: "dropdown" | "pills";
  /** Only show this field while the predicate returns true, evaluated
   *  against the current form state (e.g. exchange-only fields). */
  showIf?: (form: Record<string, any>) => boolean;
  /** Field keys to clear (set to "") whenever this field's value changes —
   *  used by cascading selects so picking a new Category clears a
   *  now-invalid Subcategory/Type instead of leaving a stale selection. */
  resetsFields?: string[];
  autoFocus?: boolean;
  /** Renders the input/select smaller (text-xs h-8/h-9) to match the
   *  compact fields used inside grouped boxes and secondary rows in the
   *  original markup — default fields render at normal size. */
  compact?: boolean;
  /** number/date input constraints, forwarded straight to the <input>. */
  step?: string;
  min?: string;
  /** textarea row count. */
  rows?: number;
  /** For type === "image": max upload size in MB before rejecting (default 3). */
  maxSizeMB?: number;
}

export interface GroupDef {
  id: string;
  label: string;
  icon: ElementType;
  /** Full className for the box wrapper (border/bg color). */
  boxClassName: string;
  /** className for the header icon + label. */
  headerClassName: string;
  /** Optional caption shown once at the bottom of the whole group. */
  help?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  render?: "text" | "badge" | "currency" | "date" | "icon";
  sortable?: boolean;
}

export interface ActionDef {
  key: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  onSubmitKey: string; // maps to a handler already defined on the page
}
