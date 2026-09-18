import { cn } from "@/lib/utils";
import { X } from "lucide-react";

/**
 * components/mail/label-badge.tsx
 * ─────────────────────────────────────────────────────────────────────────
 * Fixed color palette for mailbox labels + the chip that renders one.
 * Mirrors components/ui/task-category-badge.tsx's approach (a small enum
 * of Tailwind bg/border/text triples, not free-form hex) so every label
 * stays visually consistent with the rest of the app's dark theme instead
 * of a color picker producing something that clashes.
 *
 * The `keys` here (AYZEN_LABEL_COLORS) must match
 * lib/db/src/schema/ayzen-mailbox.ts's AYZEN_LABEL_COLORS exactly — the
 * backend validates against that list, this just maps it to classes.
 */
export const AYZEN_LABEL_COLORS = ["red", "orange", "yellow", "emerald", "sky", "violet", "pink", "slate"] as const;
export type AyzenLabelColor = (typeof AYZEN_LABEL_COLORS)[number];

const COLOR_CLASSES: Record<AyzenLabelColor, { text: string; bg: string; border: string; dot: string }> = {
  red: { text: "text-red-400", bg: "bg-red-400/10", border: "border-red-400/30", dot: "bg-red-400" },
  orange: { text: "text-orange-400", bg: "bg-orange-400/10", border: "border-orange-400/30", dot: "bg-orange-400" },
  yellow: { text: "text-yellow-400", bg: "bg-yellow-400/10", border: "border-yellow-400/30", dot: "bg-yellow-400" },
  emerald: { text: "text-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/30", dot: "bg-emerald-400" },
  sky: { text: "text-sky-400", bg: "bg-sky-400/10", border: "border-sky-400/30", dot: "bg-sky-400" },
  violet: { text: "text-violet-400", bg: "bg-violet-400/10", border: "border-violet-400/30", dot: "bg-violet-400" },
  pink: { text: "text-pink-400", bg: "bg-pink-400/10", border: "border-pink-400/30", dot: "bg-pink-400" },
  slate: { text: "text-slate-400", bg: "bg-slate-400/10", border: "border-slate-400/30", dot: "bg-slate-400" },
};

function classesFor(color: string) {
  return COLOR_CLASSES[color as AyzenLabelColor] ?? COLOR_CLASSES.slate;
}

export interface MailLabel {
  id: number;
  name: string;
  color: string;
}

// A small colored dot only — used inline in dense list rows where a full
// text chip would crowd the layout (e.g. next to the subject line).
export function LabelDot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block w-1.5 h-1.5 rounded-full flex-shrink-0", classesFor(color).dot, className)} />;
}

// The full chip — colored border/background, label text, optional remove (×).
export function LabelChip({
  label, onRemove, size = "xs",
}: {
  label: MailLabel;
  onRemove?: (id: number) => void;
  size?: "xs" | "sm";
}) {
  const c = classesFor(label.color);
  return (
    <span className={cn(
      "inline-flex items-center gap-1 font-mono rounded border px-1.5 py-0.5 uppercase tracking-wide flex-shrink-0",
      size === "xs" ? "text-[8px]" : "text-[9px]",
      c.text, c.bg, c.border,
    )}>
      {label.name}
      {onRemove && (
        <button onClick={(e) => { e.stopPropagation(); onRemove(label.id); }} className="hover:opacity-70">
          <X className="w-2 h-2" />
        </button>
      )}
    </span>
  );
}

// A row in the color-picker grid (create/edit label dialog).
export function ColorSwatch({ color, selected, onClick }: { color: AyzenLabelColor; selected: boolean; onClick: () => void }) {
  const c = classesFor(color);
  return (
    <button
      type="button"
      onClick={onClick}
      title={color}
      className={cn(
        "w-6 h-6 rounded-full border-2 flex items-center justify-center transition-transform",
        c.dot.replace("bg-", "bg-"), // dot class already carries the fill color
        selected ? "border-foreground scale-110" : "border-transparent opacity-70 hover:opacity-100",
      )}
    >
      <span className={cn("w-full h-full rounded-full", c.dot)} />
    </button>
  );
}
