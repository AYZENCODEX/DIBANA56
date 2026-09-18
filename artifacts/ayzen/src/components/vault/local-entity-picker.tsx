/**
 * local-entity-picker.tsx
 * ─────────────────────────────────────────────
 * Compact inline picker shown at the top of each platform tab (Twitter /
 * Discord / Telegram) in the vault entity create/edit dialog. Lets the user
 * select an existing local account of that platform type and auto-fill the
 * credential fields — the local entity becomes the "source" of the platform
 * slot and its name is shown as a tag.
 *
 * The parent (vault.tsx EntityManager) owns the `accounts` list and the
 * `linked` state; this component is purely presentational + dispatch.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Link2, X, ChevronDown, Users } from "lucide-react";

interface LocalAcc {
  id: number;
  category: string;
  label: string | null;
  username: string | null;
  email: string | null;
  password: string | null;
  twofa: string | null;
  followers: string | null;
  account_worth: number;
  buy_price: number;
  vault_entry_id: number | null;
}

interface Props {
  platform: "twitter" | "discord" | "telegram";
  accounts: LocalAcc[];
  loading: boolean;
  linked: { id: number; label: string } | null;
  onImport: (acc: LocalAcc) => void;
  onClear: () => void;
}

const PLATFORM_COLOR: Record<string, string> = {
  twitter:  "text-sky-400 border-sky-400/20 bg-sky-400/5",
  discord:  "text-indigo-400 border-indigo-400/20 bg-indigo-400/5",
  telegram: "text-blue-400 border-blue-400/20 bg-blue-400/5",
};

export function LocalEntityPicker({ platform, accounts, loading, linked, onImport, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const color = PLATFORM_COLOR[platform] ?? "text-muted-foreground border-border bg-muted/10";

  // If already linked, show the tag + clear button
  if (linked) {
    return (
      <div className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-lg border font-mono text-[10px] mb-1",
        color
      )}>
        <Link2 className="w-3 h-3 flex-shrink-0" />
        <span className="flex-1 truncate">Local: <span className="font-bold">{linked.label}</span></span>
        <button
          onClick={onClear}
          title="Remove link"
          className="text-muted-foreground/50 hover:text-red-400 transition-colors flex-shrink-0"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  const free = accounts.filter(a => !a.vault_entry_id);
  const used = accounts.filter(a => !!a.vault_entry_id);

  return (
    <div className="space-y-1 mb-1">
      <button
        onClick={() => setOpen(o => !o)}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 rounded-lg border font-mono text-[10px] transition-all",
          open
            ? cn(color, "shadow-sm")
            : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground hover:border-border/60 bg-muted/5"
        )}
      >
        <Users className="w-3 h-3 flex-shrink-0" />
        <span className="flex-1 text-left">
          {loading ? "Loading local entities…" : free.length > 0 ? `Import from local entity (${free.length} available)` : "No unused local entities — fill manually"}
        </span>
        <ChevronDown className={cn("w-3 h-3 flex-shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && !loading && (
        <div className="border border-border/30 rounded-lg overflow-hidden bg-card shadow-sm">
          {free.length === 0 && used.length === 0 && (
            <p className="px-3 py-3 font-mono text-[10px] text-muted-foreground/50 text-center">
              No local {platform} entities yet. Add some from the Local tab.
            </p>
          )}
          {free.length > 0 && (
            <div>
              <p className="px-3 py-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/40 border-b border-border/20 bg-muted/10">
                Unused — click to import
              </p>
              {free.map(acc => (
                <button
                  key={acc.id}
                  onClick={() => { onImport(acc); setOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/20 transition-colors border-b border-border/10 last:border-0 text-left group"
                >
                  <div className={cn("w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0", color.split(" ").find(c => c.startsWith("bg-")))}>
                    <span className="font-mono text-[9px] font-bold uppercase">{platform[0]}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-[11px] font-medium text-foreground truncate">
                      {acc.label ?? acc.username ?? `#${acc.id}`}
                    </p>
                    {acc.username && acc.label && (
                      <p className="font-mono text-[9px] text-muted-foreground/50 truncate">@{acc.username}</p>
                    )}
                    {acc.email && (
                      <p className="font-mono text-[9px] text-muted-foreground/40 truncate">{acc.email}</p>
                    )}
                  </div>
                  <span className="font-mono text-[8px] text-emerald-400 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity">
                    Import →
                  </span>
                </button>
              ))}
            </div>
          )}
          {used.length > 0 && (
            <div>
              <p className="px-3 py-1.5 font-mono text-[8px] uppercase tracking-widest text-muted-foreground/40 border-b border-border/20 border-t border-border/10 bg-muted/10">
                Already linked to an entity
              </p>
              {used.map(acc => (
                <button
                  key={acc.id}
                  onClick={() => { onImport(acc); setOpen(false); }}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/20 transition-colors border-b border-border/10 last:border-0 text-left opacity-60 group"
                >
                  <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 bg-muted/30">
                    <Link2 className="w-2.5 h-2.5 text-muted-foreground/50" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-[11px] font-medium text-foreground truncate">
                      {acc.label ?? acc.username ?? `#${acc.id}`}
                    </p>
                    {acc.username && acc.label && (
                      <p className="font-mono text-[9px] text-muted-foreground/50 truncate">@{acc.username}</p>
                    )}
                  </div>
                  <span className="font-mono text-[8px] text-amber-400 opacity-0 group-hover:opacity-100 flex-shrink-0 transition-opacity">
                    Re-use →
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
