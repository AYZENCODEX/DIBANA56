import { useState, useEffect, useCallback, useRef } from "react";
import { Search, FolderGit2, CheckSquare, Vault, Users, ShieldCheck, Gamepad2, Mail, UserCog, X, ArrowRight, Loader2, Receipt, Wallet, Store } from "lucide-react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

type ResultType = "project" | "task" | "vault" | "local" | "kyc" | "game" | "mail" | "user" | "finance" | "wallet" | "marketplace";

interface Result {
  id: number | string;
  label: string;
  sub?: string;
  type: ResultType;
  href: string;
}

// Raw row shapes returned by GET /api/search — snake_case, straight from
// the underlying tables (routes/search.ts uses raw SQL, not the ORM).
interface SearchApiResponse {
  projects: Array<{ id: number; name: string; category?: string }>;
  tasks: Array<{ id: number; name: string; project_name?: string }>;
  users: Array<{ id: number; username: string; email?: string; role?: string }>;
  entities: Array<{ id: number; project_name?: string; category?: string; email?: string }>;
  local: Array<{ id: number; label?: string; username?: string; email?: string; category?: string }>;
  kyc: Array<{ id: number; name?: string; username?: string; email?: string; platform?: string; category?: string }>;
  game: Array<{ id: number; username?: string; email?: string; category?: string; rank?: string }>;
  mail: Array<{ id: number; email_account_id: number; source_category?: string; source_id?: string; subject?: string; from_addr?: string }>;
  // Phase 7 — unified search federation: Ryft (finance + wallets), Verve (marketplace)
  finance: Array<{ id: number; title?: string; kind?: string; status?: string; currency?: string; amount?: number }>;
  wallets: Array<{ id: number; label?: string; address?: string; chain?: string }>;
  marketplace: Array<{ id: number; title?: string; listing_type?: string; price_azn?: number; status?: string }>;
}

export function CommandSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const { token } = useAuth();
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const search = useCallback(async (q: string) => {
    if (!q.trim() || !token) { setResults([]); return; }
    setLoading(true);
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const data: SearchApiResponse = await fetch(`${BASE}/api/search?q=${encodeURIComponent(q)}`, { headers }).then(r => r.json());
      const out: Result[] = [];

      (data.projects ?? []).forEach(p =>
        out.push({ id: p.id, label: p.name, sub: p.category ?? "Project", type: "project", href: `/projects/${p.id}` }));

      (data.tasks ?? []).forEach(t =>
        out.push({ id: t.id, label: t.name, sub: t.project_name ?? "Task", type: "task", href: `/tasks` }));

      // Entity, Local, KYC, Game, and Mail each live in their own table —
      // route each result to wherever that category is actually browsable.
      // Local and Entity have real per-id detail pages; KYC/Game don't yet
      // (they're inline lists inside the Vault tab), so those land on the
      // tab itself rather than a specific record.
      (data.entities ?? []).forEach(e =>
        out.push({ id: e.id, label: e.project_name || "Vault Entry", sub: e.email ?? "Entity", type: "vault", href: `/vault/entity/${e.id}` }));

      (data.local ?? []).forEach(l =>
        out.push({ id: l.id, label: l.label || l.username || l.email || "Local Account", sub: l.category ?? "Local", type: "local", href: `/vault/local/${l.id}` }));

      (data.kyc ?? []).forEach(k =>
        out.push({ id: k.id, label: k.name || k.username || "KYC Entity", sub: k.platform || k.category || "KYC", type: "kyc", href: `/vault?tab=kyc` }));

      (data.game ?? []).forEach(g =>
        out.push({ id: g.id, label: g.username || g.email || "Game Account", sub: g.category ?? "Game", type: "game", href: `/vault?tab=game` }));

      (data.mail ?? []).forEach(m =>
        out.push({ id: m.id, label: m.subject || "(no subject)", sub: m.from_addr ?? "Mail", type: "mail", href: `/vault/mail-hub/${m.source_category}/${m.source_id}/mail/${m.id}` }));

      (data.users ?? []).forEach(u =>
        out.push({ id: u.id, label: u.username, sub: u.role ?? u.email ?? "User", type: "user", href: `/admin/users` }));

      // Phase 7 — unified search federation: Ryft (finance + wallets), Verve (marketplace).
      // No per-record detail pages exist for these yet (list/dashboard-only,
      // same as KYC/Game above), so results land on the app's own dashboard.
      (data.finance ?? []).forEach(f =>
        out.push({ id: f.id, label: f.title || "Ledger Entry", sub: `${f.kind ?? ""} · ${f.status ?? ""}`.trim(), type: "finance", href: `/finance/dashboard` }));

      (data.wallets ?? []).forEach(w =>
        out.push({ id: w.id, label: w.label || "Wallet", sub: w.chain ?? "Wallet", type: "wallet", href: `/vault/wallet-hub/overview` }));

      (data.marketplace ?? []).forEach(m =>
        out.push({ id: m.id, label: m.title || "Listing", sub: `${m.listing_type ?? ""} · ${m.price_azn ?? ""} AZN`.trim(), type: "marketplace", href: `/marketplace/hub?listing=${m.id}` }));

      setResults(out);
      setSelected(0);
    } catch {}
    setLoading(false);
  }, [token]);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 250);
    return () => clearTimeout(debounceRef.current);
  }, [query, search]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") { e.preventDefault(); setOpen(v => !v); }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) { setTimeout(() => inputRef.current?.focus(), 50); setQuery(""); setResults([]); }
  }, [open]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected(s => Math.min(s + 1, results.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); }
      if (e.key === "Enter" && results[selected]) { navigate(results[selected].href); setOpen(false); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, results, selected, navigate]);

  const TYPE_CONFIG: Record<ResultType, { icon: typeof Vault; color: string }> = {
    project: { icon: FolderGit2, color: "text-primary" },
    task:    { icon: CheckSquare, color: "text-violet-400" },
    vault:   { icon: Vault, color: "text-amber-400" },
    local:   { icon: Users, color: "text-sky-400" },
    kyc:     { icon: ShieldCheck, color: "text-emerald-400" },
    game:    { icon: Gamepad2, color: "text-orange-400" },
    mail:    { icon: Mail, color: "text-rose-400" },
    user:    { icon: UserCog, color: "text-muted-foreground" },
    finance: { icon: Receipt, color: "text-emerald-400" },
    wallet:  { icon: Wallet, color: "text-cyan-400" },
    marketplace: { icon: Store, color: "text-orange-400" },
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-20 px-4"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl bg-card border border-card-border rounded-2xl shadow-2xl shadow-black/60 overflow-hidden animate-in fade-in slide-in-from-top-3 duration-150"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/60">
          {loading ? <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" /> : <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search projects, tasks, entity, local, KYC, game, mail..."
            className="flex-1 bg-transparent font-mono text-sm outline-none text-foreground placeholder:text-muted-foreground/50"
          />
          {query && <button onClick={() => setQuery("")} className="text-muted-foreground/40 hover:text-muted-foreground"><X className="w-3.5 h-3.5" /></button>}
          <kbd className="hidden sm:block px-1.5 py-0.5 rounded border border-border font-mono text-[10px] text-muted-foreground/50">ESC</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {!query && (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground/40">
              Type to search across projects, tasks, and every Vault section...
            </div>
          )}
          {query && !loading && results.length === 0 && (
            <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground/40">No results for "{query}"</div>
          )}
          {results.map((r, i) => {
            const { icon: Icon, color } = TYPE_CONFIG[r.type];
            return (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => { navigate(r.href); setOpen(false); }}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 transition-colors text-left group",
                  i === selected ? "bg-primary/10" : "hover:bg-muted/30"
                )}
                onMouseEnter={() => setSelected(i)}
              >
                <div className={cn("w-7 h-7 rounded-lg flex items-center justify-center bg-muted/30", color)}>
                  <Icon className={cn("w-3.5 h-3.5", color)} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-mono text-sm text-foreground truncate">{r.label}</div>
                  <div className="font-mono text-[10px] text-muted-foreground/50 uppercase tracking-wider">{r.sub}</div>
                </div>
                <ArrowRight className={cn("w-3.5 h-3.5 opacity-0 group-hover:opacity-100 text-muted-foreground transition-opacity", i === selected && "opacity-100")} />
              </button>
            );
          })}
        </div>

        <div className="px-4 py-2 border-t border-border/40 flex items-center gap-4 text-[10px] font-mono text-muted-foreground/40">
          <span><kbd className="px-1 py-0.5 rounded border border-border/40">↑↓</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded border border-border/40">↵</kbd> open</span>
          <span><kbd className="px-1 py-0.5 rounded border border-border/40">⌘K</kbd> toggle</span>
        </div>
      </div>
    </div>
  );
}

export function useCommandSearch() {
  const openSearch = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  return { openSearch };
}
