import { useState, useEffect, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { Search, FolderGit2, Users, CheckSquare, Shield, X, Loader2, ArrowRight, Smartphone, ShieldCheck, Gamepad2, Mail, Lock, Wallet, Receipt, Store } from "lucide-react";
import { cn } from "@/lib/utils";
import { isVaultUnlocked } from "@/lib/vault-lock";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface SearchResult {
  projects: any[];
  users: any[];
  tasks: any[];
  entities: any[];
  local: any[];
  kyc: any[];
  game: any[];
  mail: any[];
  finance: any[];
  wallets: any[];
  marketplace: any[];
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export function GlobalSearch({ isAdmin }: { isAdmin?: boolean }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Security gate: vault results are shown only when the vault is unlocked
  const [vaultPinSet, setVaultPinSet] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [, navigate] = useLocation();
  const debouncedQuery = useDebounce(query, 300);

  // Check whether a vault PIN is configured so we know if we need to gate results
  useEffect(() => {
    const token = localStorage.getItem("ayzen_token") ?? "";
    fetch(`${BASE}/api/vault/security/status`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setVaultPinSet(!!d.vaultPinSet); })
      .catch(() => {});
  }, []);

  const vaultAccessible = !vaultPinSet || isVaultUnlocked();

  const total = results ? results.projects.length + results.users.length + results.tasks.length + results.entities.length
    + results.local.length + results.kyc.length + results.game.length + results.mail.length
    + results.finance.length + results.wallets.length + results.marketplace.length : 0;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else { setQuery(""); setResults(null); }
  }, [open]);

  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 2) { setResults(null); return; }
    setLoading(true);
    const token = localStorage.getItem("ayzen_token") ?? "";
    fetch(`${BASE}/api/search?q=${encodeURIComponent(debouncedQuery)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setResults(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [debouncedQuery]);

  const go = useCallback((href: string) => { navigate(href); setOpen(false); }, [navigate]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 h-8 px-3 rounded-lg border border-border/50 bg-muted/20 hover:bg-muted/40 hover:border-primary/30 transition-all text-muted-foreground/60 hover:text-muted-foreground group"
      >
        <Search className="w-3.5 h-3.5" />
        <span className="font-mono text-xs hidden sm:block">Search...</span>
        <kbd className="hidden sm:flex items-center gap-0.5 font-mono text-[9px] bg-muted/60 px-1.5 py-0.5 rounded border border-border/50 ml-2">
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-20 px-4" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-lg bg-card border border-card-border rounded-xl shadow-2xl overflow-hidden animate-pop-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/40">
          {loading ? <Loader2 className="w-4 h-4 text-primary animate-spin flex-shrink-0" /> : <Search className="w-4 h-4 text-primary flex-shrink-0" />}
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search projects, tasks, users, Vault, Ryft, Verve, mail..."
            className="flex-1 bg-transparent font-mono text-sm outline-none text-foreground placeholder:text-muted-foreground/40"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-muted-foreground/40 hover:text-foreground transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <kbd className="font-mono text-[9px] bg-muted/60 px-1.5 py-0.5 rounded border border-border/50 text-muted-foreground/50">ESC</kbd>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {!query && (
            <div className="p-6 text-center">
              <Search className="w-8 h-8 text-muted-foreground/20 mx-auto mb-2" />
              <p className="font-mono text-xs text-muted-foreground/40">Type to search across the platform</p>
            </div>
          )}

          {query && !loading && results && total === 0 && (
            <div className="p-6 text-center">
              <p className="font-mono text-xs text-muted-foreground/40">No results for "{query}"</p>
            </div>
          )}

          {results && total > 0 && (
            <div className="py-2">
              {results.projects.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <FolderGit2 className="w-3 h-3" /> Projects
                  </div>
                  {results.projects.map((p: any) => (
                    <button
                      key={p.id}
                      onClick={() => go(isAdmin ? `/admin/projects/${p.id}` : `/projects/${p.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0">
                        <FolderGit2 className="w-3 h-3 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{p.name}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{p.category} · Tier {p.tier}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {results.tasks.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <CheckSquare className="w-3 h-3" /> Tasks
                  </div>
                  {results.tasks.map((t: any) => (
                    <button
                      key={t.id}
                      onClick={() => go(isAdmin ? "/admin/tasks" : "/tasks")}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
                        <CheckSquare className="w-3 h-3 text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{t.name}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{t.project_name ?? "No project"}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {results.users.length > 0 && isAdmin && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Users className="w-3 h-3" /> Users
                  </div>
                  {results.users.map((u: any) => (
                    <button
                      key={u.id}
                      onClick={() => go(`/admin/users`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded-full bg-secondary/10 border border-secondary/20 flex items-center justify-center flex-shrink-0 font-bold font-mono text-[10px] text-secondary">
                        {(u.username || "?")[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{u.username}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{u.email} · {u.role}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {/* Vault results are gated behind the vault PIN when one is configured */}
              {!vaultAccessible && (results.entities.length > 0 || results.local.length > 0 || results.kyc.length > 0 || results.game.length > 0) && (
                <div className="mx-4 my-2 flex items-center gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2.5">
                  <Lock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  <div>
                    <p className="font-mono text-[10px] font-bold text-amber-400">Vault is locked</p>
                    <p className="font-mono text-[9px] text-muted-foreground/50">Unlock your vault to view matching vault entries.</p>
                  </div>
                </div>
              )}

              {vaultAccessible && results.entities.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Shield className="w-3 h-3" /> Vault · Entity
                  </div>
                  {results.entities.map((e: any) => (
                    <button
                      key={e.id}
                      onClick={() => go(`/vault/entity/${e.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-violet-500/10 border border-violet-500/20 flex items-center justify-center flex-shrink-0">
                        <Shield className="w-3 h-3 text-violet-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{e.project_name}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{e.category} · {e.email || "No email"}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {vaultAccessible && results.local.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Smartphone className="w-3 h-3" /> Vault · Local
                  </div>
                  {results.local.map((a: any) => (
                    <button
                      key={a.id}
                      onClick={() => go(`/vault/local/${a.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-sky-500/10 border border-sky-500/20 flex items-center justify-center flex-shrink-0">
                        <Smartphone className="w-3 h-3 text-sky-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{a.label || a.username || a.email || `Account #${a.id}`}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{a.category} · {a.email || "No email"}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {vaultAccessible && results.kyc.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <ShieldCheck className="w-3 h-3" /> Vault · KYC
                  </div>
                  {results.kyc.map((k: any) => (
                    <button
                      key={k.id}
                      onClick={() => go(`/vault/2fa/kyc/${k.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                        <ShieldCheck className="w-3 h-3 text-amber-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{k.name || k.username || k.platform || `KYC #${k.id}`}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{k.category} · {k.email || "No email"}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {vaultAccessible && results.game.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Gamepad2 className="w-3 h-3" /> Vault · Game
                  </div>
                  {results.game.map((g: any) => (
                    <button
                      key={g.id}
                      onClick={() => go(`/vault/2fa/game/${g.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-fuchsia-500/10 border border-fuchsia-500/20 flex items-center justify-center flex-shrink-0">
                        <Gamepad2 className="w-3 h-3 text-fuchsia-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{g.username || `Game #${g.id}`}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{g.category} · {g.email || "No email"}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {vaultAccessible && results.mail.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Mail className="w-3 h-3" /> Mail Hub
                  </div>
                  {results.mail.map((m: any) => (
                    <button
                      key={m.id}
                      onClick={() => go(m.source_id != null ? `/vault/mail-hub/${m.source_category}/${m.source_id}/mail/${m.id}` : "/vault/mail-hub/entity")}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-rose-500/10 border border-rose-500/20 flex items-center justify-center flex-shrink-0">
                        <Mail className="w-3 h-3 text-rose-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{m.subject || "(no subject)"}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{m.from_addr}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {/* Phase 7 — unified search federation: Ryft (finance + wallets) and Verve (marketplace) */}
              {results.finance.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Receipt className="w-3 h-3" /> Ryft · Finance
                  </div>
                  {results.finance.map((f: any) => (
                    <button
                      key={f.id}
                      onClick={() => go("/finance/dashboard")}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0">
                        <Receipt className="w-3 h-3 text-emerald-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{f.title}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{f.kind} · {f.currency} {f.amount} · {f.status}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {results.wallets.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Wallet className="w-3 h-3" /> Ryft · Wallets
                  </div>
                  {results.wallets.map((w: any) => (
                    <button
                      key={w.id}
                      onClick={() => go("/vault/wallet-hub/overview")}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center flex-shrink-0">
                        <Wallet className="w-3 h-3 text-cyan-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{w.label}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{w.chain} · {w.address?.slice(0, 10)}…</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}

              {results.marketplace.length > 0 && (
                <div>
                  <div className="px-4 py-1.5 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/40 flex items-center gap-1.5">
                    <Store className="w-3 h-3" /> Verve · Marketplace
                  </div>
                  {results.marketplace.map((m: any) => (
                    <button
                      key={m.id}
                      onClick={() => go(`/marketplace/hub?listing=${m.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-primary/5 transition-colors group"
                    >
                      <div className="w-6 h-6 rounded bg-orange-500/10 border border-orange-500/20 flex items-center justify-center flex-shrink-0">
                        <Store className="w-3 h-3 text-orange-400" />
                      </div>
                      <div className="flex-1 min-w-0 text-left">
                        <p className="font-mono text-sm text-foreground truncate">{m.title}</p>
                        <p className="font-mono text-[9px] text-muted-foreground/40">{m.listing_type} · {m.price_azn} AZN · {m.status}</p>
                      </div>
                      <ArrowRight className="w-3 h-3 text-muted-foreground/30 group-hover:text-primary transition-colors" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-border/30 flex items-center gap-3 text-[10px] font-mono text-muted-foreground/30">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>ESC close</span>
        </div>
      </div>
    </div>
  );
}
