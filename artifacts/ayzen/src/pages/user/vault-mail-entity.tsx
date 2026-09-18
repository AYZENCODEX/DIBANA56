import { useState, useEffect, useMemo, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  ArrowLeft, Shield, Smartphone, ShieldCheck, Gamepad2, Mail,
  Loader2, RefreshCw, ChevronRight, LayoutDashboard, Inbox, AtSign, Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  buildEntityMailItems, buildLocalMailItems, buildKycMailItems, buildGameMailItems,
  type MailCategory, type MailItem,
} from "@/lib/vault-mail-items";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

const CATEGORY_META: Record<MailCategory, { label: string; icon: React.ElementType }> = {
  kyc:    { label: "KYC",    icon: ShieldCheck },
  local:  { label: "Local",  icon: Smartphone },
  entity: { label: "Entity", icon: Shield },
  game:   { label: "Game",   icon: Gamepad2 },
};

interface StoredMessage {
  id: number; uid: number; seqno: number; from: string; to: string;
  subject: string; date: string | null; hasBody: boolean; accountId: number; accountEmail: string;
}

interface EmailAccountLite { id: number; emailAddress: string; imapHost: string | null; }

export default function VaultMailEntity() {
  const params = useParams<{ category: string; id: string }>();
  const [, navigate] = useLocation();
  const category = (params.category as MailCategory) ?? "entity";
  const id = Number(params.id);
  const meta = CATEGORY_META[category] ?? CATEGORY_META.entity;

  return (
    <div className="space-y-5 page-enter">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="h-8 w-8 flex-shrink-0" onClick={() => navigate(`/vault/mail-hub/${category}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-bold font-mono tracking-tighter truncate flex items-center gap-2">
            <meta.icon className="w-4 h-4 text-primary flex-shrink-0" />
            <MailEntityName category={category} id={id} fallback={meta.label} />
          </h1>
          <p className="text-muted-foreground font-mono text-[10px] mt-0.5">Mail Hub · {meta.label}</p>
        </div>
      </div>
      <VaultMailEntityBody category={category} id={id} />
    </div>
  );
}

/** Small helper so the page header can show the entity name without duplicating the data-fetch below. */
function MailEntityName({ category, id, fallback }: { category: MailCategory; id: number; fallback: string }) {
  const { data: vaultData } = useListVaultEntries();
  const [raw, setRaw] = useState<any[]>([]);
  useEffect(() => {
    if (category === "entity") return;
    const endpoint = category === "kyc" ? "/kyc-entries" : category === "game" ? "/game-entries" : "/local-accounts";
    customFetch<any>(endpoint).then(d => setRaw(Array.isArray(d) ? d : (d?.accounts ?? []))).catch(() => setRaw([]));
  }, [category]);
  const items = category === "entity" ? buildEntityMailItems((vaultData as any[]) ?? [])
    : category === "local" ? buildLocalMailItems(raw)
    : category === "kyc" ? buildKycMailItems(raw)
    : buildGameMailItems(raw);
  const match = items.find(i => i.entityId === id);
  return <>{match?.entityName || fallback}</>;
}

/**
 * VaultMailEntityBody — the per-entity mail listing (Overview/Mail sub-tabs,
 * search, sync) with no page-level chrome. Filtered to a single
 * `{category, id}` entity/local/kyc/game record. Used both by the standalone
 * Mail Hub entity page above and by the Phase 19 unified Access page's
 * Mail tab (always called with category="entity").
 */
export function VaultMailEntityBody({ category, id }: { category: MailCategory; id: number }) {
  const [, navigate] = useLocation();
  const { token } = useAuth();

  const [tab, setTab] = useState<"overview" | "email">("overview");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StoredMessage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const { data: vaultData, isLoading: vaultLoading } = useListVaultEntries();
  const [raw, setRaw] = useState<any[]>([]);
  const [rawLoading, setRawLoading] = useState(category !== "entity");
  const [accounts, setAccounts] = useState<EmailAccountLite[]>([]);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (category === "entity") return;
    const endpoint = category === "kyc" ? "/kyc-entries" : category === "game" ? "/game-entries" : "/local-accounts";
    setRawLoading(true);
    customFetch<any>(endpoint).then(d => setRaw(Array.isArray(d) ? d : (d?.accounts ?? [])))
      .catch(() => setRaw([])).finally(() => setRawLoading(false));
  }, [category]);

  useEffect(() => {
    if (!token) return;
    fetch(`${BASE}/api/email-accounts`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then(list => setAccounts(Array.isArray(list) ? list : []))
      .catch(() => setAccounts([]));
  }, [token]);

  const { entityName, items }: { entityName: string; items: MailItem[] } = useMemo(() => {
    if (category === "entity") {
      const all = buildEntityMailItems((vaultData as any[]) ?? []);
      const items = all.filter(i => i.entityId === id);
      return { entityName: items[0]?.entityName ?? "", items };
    }
    const builder = category === "local" ? buildLocalMailItems : category === "kyc" ? buildKycMailItems : buildGameMailItems;
    const all = builder(raw);
    const items = all.filter(i => i.entityId === id);
    return { entityName: items[0]?.entityName ?? "", items };
  }, [category, id, vaultData, raw]);

  const accountByEmail = useMemo(() => {
    const map = new Map<string, EmailAccountLite>();
    accounts.forEach(a => map.set(a.emailAddress, a));
    return map;
  }, [accounts]);

  const linkedAccounts = useMemo(
    () => items.map(i => accountByEmail.get(i.email)).filter((a): a is EmailAccountLite => !!a),
    [items, accountByEmail]
  );

  const loadStoredMessages = useCallback(async () => {
    if (!token || linkedAccounts.length === 0) { setMessages([]); return; }
    setMsgLoading(true);
    try {
      const results = await Promise.all(linkedAccounts.map(async acc => {
        const r = await fetch(`${BASE}/api/email-accounts/${acc.id}/stored-messages`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return [];
        const d = await r.json();
        return (d.messages ?? []).map((m: any) => ({ ...m, accountId: acc.id, accountEmail: acc.emailAddress }));
      }));
      const merged = results.flat().sort((a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0));
      setMessages(merged);
    } finally {
      setMsgLoading(false);
    }
  }, [token, linkedAccounts]);

  useEffect(() => { loadStoredMessages(); }, [loadStoredMessages]);

  useEffect(() => {
    if (!searchQuery.trim() || !token) { setSearchResults(null); return; }
    const t = setTimeout(() => {
      setSearching(true);
      fetch(`${BASE}/api/mail-messages/search?q=${encodeURIComponent(searchQuery)}&category=${category}&sourceId=${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : { messages: [] })
        .then(d => setSearchResults((d.messages ?? []).map((m: any) => ({ ...m, hasBody: true, accountId: m.emailAccountId, accountEmail: m.accountEmail }))))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [searchQuery, category, id, token]);

  const syncNow = async () => {
    if (!token || linkedAccounts.length === 0) return;
    setSyncing(true);
    try {
      await Promise.all(linkedAccounts.map(acc =>
        fetch(`${BASE}/api/email-accounts/${acc.id}/fetch-inbox`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ limit: 30, sourceCategory: category, sourceId: id }),
        }).catch(() => null)
      ));
      await loadStoredMessages();
    } finally {
      setSyncing(false);
    }
  };

  const isLoading = category === "entity" ? vaultLoading : rawLoading;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1 w-fit">
          <button onClick={() => setTab("overview")} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", tab === "overview" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}>
            <LayoutDashboard className="w-3 h-3" /> Overview
          </button>
          <button onClick={() => setTab("email")} className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-md font-mono text-xs transition-all", tab === "email" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}>
            <Inbox className="w-3 h-3" /> Mail
          </button>
        </div>
        <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing || linkedAccounts.length === 0} className="font-mono text-[10px] gap-1.5 flex-shrink-0 ml-auto">
          {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Sync
        </Button>
      </div>

      {items.length === 0 && !isLoading ? (
        <div className="text-center py-16 space-y-2">
          <AtSign className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">No email addresses on this entity</p>
        </div>
      ) : tab === "overview" ? (
        // Overview — rollup summary only, aggregated across every one of this
        // entity's connected email accounts. Never renders a scrollable/clickable
        // mail list; open the Mail tab above to read individual messages.
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Addresses", value: items.length },
              { label: "Configured", value: linkedAccounts.length },
              { label: "Emails", value: messages.length },
            ].map(s => (
              <div key={s.label} className="bg-card border border-card-border rounded-xl p-3">
                <p className="font-mono text-lg font-bold text-primary">{s.value}</p>
                <p className="font-mono text-[9px] text-muted-foreground/50">{s.label}</p>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/40 px-1">Addresses</p>
            {items.map(i => {
              const count = messages.filter(m => m.accountEmail === i.email).length;
              return (
                <div key={i.id} className="flex items-center gap-2 px-3 py-2 bg-card border border-card-border rounded-lg">
                  <Mail className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                  <span className="font-mono text-[11px] truncate">{i.email}</span>
                  <span className="font-mono text-[9px] text-muted-foreground/40 ml-auto">{i.label}</span>
                  {accountByEmail.has(i.email) ? (
                    <span className="font-mono text-[9px] font-bold text-primary flex-shrink-0">{count}</span>
                  ) : (
                    <span className="font-mono text-[8px] px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20 flex-shrink-0">not configured</span>
                  )}
                </div>
              );
            })}
          </div>

          {msgLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-primary" /></div>
          ) : messages.length > 0 && (
            <div className="bg-card border border-card-border rounded-xl p-3.5 flex items-center gap-3">
              <Inbox className="w-4 h-4 text-primary flex-shrink-0" />
              <div className="min-w-0">
                <p className="font-mono text-[11px] font-bold truncate">
                  Last activity {messages[0].date ? new Date(messages[0].date).toLocaleString() : "—"}
                </p>
                <p className="font-mono text-[9px] text-muted-foreground/45 truncate">
                  {messages[0].subject || "(no subject)"} · {messages[0].accountEmail}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setTab("email")} className="font-mono text-[9px] gap-1.5 h-7 flex-shrink-0 ml-auto">
                Open Mail <ChevronRight className="w-3 h-3" />
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-3 py-2 bg-card border border-card-border rounded-lg">
            <Search className="w-3.5 h-3.5 text-muted-foreground/40 flex-shrink-0" />
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search subject or sender…"
              className="flex-1 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/40"
            />
            {searching && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary flex-shrink-0" />}
          </div>

          {searchQuery.trim() ? (
            <div className="space-y-1.5">
              {(searchResults ?? []).length === 0 && !searching ? (
                <div className="text-center py-10">
                  <p className="font-mono text-xs text-muted-foreground/50">No matches for "{searchQuery}"</p>
                </div>
              ) : (
                (searchResults ?? []).map(m => <MailRow key={m.id} m={m} onClick={() => navigate(`/vault/mail-hub/${category}/${id}/mail/${m.id}`)} />)
              )}
            </div>
          ) : msgLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
          ) : messages.length === 0 ? (
            <div className="text-center py-16 space-y-2">
              <Inbox className="w-8 h-8 text-muted-foreground/30 mx-auto" />
              <p className="font-mono text-xs text-muted-foreground/50">No synced emails yet</p>
              <Button size="sm" variant="outline" onClick={syncNow} disabled={syncing || linkedAccounts.length === 0} className="font-mono text-xs gap-1.5 mt-2">
                {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Sync now
              </Button>
            </div>
          ) : (
            <div className="space-y-1.5">
              {messages.map(m => <MailRow key={m.id} m={m} onClick={() => navigate(`/vault/mail-hub/${category}/${id}/mail/${m.id}`)} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MailRow({ m, onClick }: { m: StoredMessage; onClick: () => void }) {
  return (
    <button onClick={onClick} className="w-full flex items-center gap-3 px-4 py-2.5 bg-card border border-card-border rounded-lg hover:border-primary/30 transition-colors text-left">
      <Mail className="w-3.5 h-3.5 text-primary flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[11px] font-bold truncate">{m.subject || "(no subject)"}</p>
        <p className="font-mono text-[9px] text-muted-foreground/45 truncate">{m.from} · {m.accountEmail}</p>
      </div>
      <span className="font-mono text-[9px] text-muted-foreground/40 flex-shrink-0">{m.date ? new Date(m.date).toLocaleDateString() : ""}</span>
      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/30 flex-shrink-0" />
    </button>
  );
}
