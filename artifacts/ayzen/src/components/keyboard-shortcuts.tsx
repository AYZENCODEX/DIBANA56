import { useState, useEffect } from "react";
import { Keyboard, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Shortcut {
  keys: string[];
  label: string;
  group: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ["⌘", "K"], label: "Open global search", group: "Navigation" },
  { keys: ["?"], label: "Show this shortcuts panel", group: "Navigation" },
  { keys: ["Esc"], label: "Close any open dialog", group: "Navigation" },
  { keys: ["G", "D"], label: "Go to Dashboard", group: "Navigation" },
  { keys: ["G", "P"], label: "Go to Projects", group: "Navigation" },
  { keys: ["G", "T"], label: "Go to Tasks", group: "Navigation" },
  { keys: ["G", "V"], label: "Go to Vault", group: "Navigation" },
  { keys: ["⌘", "E"], label: "Export current list as CSV", group: "Actions" },
  { keys: ["⌘", "/"], label: "Focus search filter", group: "Actions" },
  { keys: ["⌘", "Enter"], label: "Submit form / confirm action", group: "Actions" },
  { keys: ["N"], label: "Create new item (context-sensitive)", group: "Actions" },
  { keys: ["R"], label: "Refresh current data", group: "Actions" },
  { keys: ["⌘", "B"], label: "Toggle sidebar collapse", group: "UI" },
  { keys: ["⌘", "\\"], label: "Toggle theme (dark/light)", group: "UI" },
];

export function KeyboardShortcuts() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); setOpen(v => !v); }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;

  const groups = Array.from(new Set(SHORTCUTS.map(s => s.group)));

  return (
    <div
      className="fixed inset-0 z-[99] bg-black/60 backdrop-blur-sm flex items-center justify-center px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg bg-card border border-card-border rounded-2xl shadow-2xl shadow-black/60 overflow-hidden animate-in fade-in zoom-in-95 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/60">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-primary" />
            <span className="font-mono font-bold text-sm uppercase tracking-widest text-foreground">Keyboard Shortcuts</span>
          </div>
          <button onClick={() => setOpen(false)} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          {groups.map(group => (
            <div key={group}>
              <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 mb-2">{group}</div>
              <div className="space-y-1">
                {SHORTCUTS.filter(s => s.group === group).map((s, i) => (
                  <div key={i} className="flex items-center justify-between py-1.5 px-3 rounded-lg hover:bg-muted/20 transition-colors">
                    <span className="font-mono text-xs text-muted-foreground">{s.label}</span>
                    <div className="flex items-center gap-1">
                      {s.keys.map((k, j) => (
                        <kbd
                          key={j}
                          className="px-1.5 py-0.5 rounded border border-border bg-muted/30 font-mono text-[11px] text-foreground/70 min-w-[22px] text-center"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border/40 font-mono text-[10px] text-muted-foreground/40">
          Press <kbd className="px-1 py-0.5 rounded border border-border/40 text-[10px]">?</kbd> to open · <kbd className="px-1 py-0.5 rounded border border-border/40 text-[10px]">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
