import { useState, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import {
  Hash, Search, Twitter, MessageCircle, Wallet, Mail,
  ChevronDown, ChevronRight, Database, Eye, EyeOff,
  Copy, Check, Shield, Smartphone, Users, KeyRound,
  Lock, Globe, Phone, AtSign, RefreshCw, User,
} from "lucide-react";
import { cn } from "@/lib/utils";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const token = () => localStorage.getItem("ayzen_token") || "";
const apiFetch = (url: string) =>
  fetch(`${BASE}${url}`, { headers: { Authorization: `Bearer ${token()}` } }).then(r => {
    if (!r.ok) throw new Error("Failed");
    return r.json();
  });

// ─── Reusable reveal field ────────────────────────────────────────────────────
function RevealField({ label, value, mono = true, defaultShown = false }: { label: string; value: string | null | undefined; mono?: boolean; defaultShown?: boolean }) {
  const [shown, setShown] = useState(defaultShown);
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="flex items-center gap-2 py-0.5 group/f">
      <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider w-20 flex-shrink-0">{label}</span>
      <span className={cn("flex-1 text-[11px] truncate", mono && "font-mono", shown ? "text-foreground/90 select-all" : "text-muted-foreground/40 select-none")}>
        {shown ? value : "•".repeat(Math.min(value.length, 14))}
      </span>
      <div className="flex gap-1 transition-opacity">
        <button onClick={() => setShown(s => !s)} className="text-muted-foreground/40 hover:text-primary transition-colors">
          {shown ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
        </button>
        <button onClick={copy} className={cn("transition-colors", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary")}>
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
    </div>
  );
}

function PlainField({ label, value }: { label: string; value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <div className="flex items-center gap-2 py-0.5 group/f">
      <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider w-20 flex-shrink-0">{label}</span>
      <span className="flex-1 font-mono text-[11px] text-foreground/80 truncate">{value}</span>
      <button onClick={copy} className={cn("opacity-0 group-hover/f:opacity-100 transition-all", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary")}>
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

// ─── Full Entity Row ──────────────────────────────────────────────────────────
function FullEntityRow({ entry }: { entry: any }) {
  const [open, setOpen] = useState(false);
  const serial = entry.entitySerial || `AYZN${entry.id}`;
  return (
    <div className={cn("border border-card-border rounded-lg overflow-hidden transition-all animate-pop-in", open && "border-primary/30")}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/10 transition-colors text-left">
        <Hash className="w-4 h-4 text-primary flex-shrink-0" />
        <div className="flex-1 min-w-0 grid grid-cols-4 gap-2 items-center">
          <div className="font-mono text-sm font-bold text-primary">{serial}</div>
          <div className="font-mono text-xs text-foreground/80 truncate">{entry.projectName}</div>
          <div className="font-mono text-xs text-muted-foreground truncate">{entry.username} · {entry.userEmail}</div>
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-primary flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-card-border px-4 py-3 bg-muted/5 space-y-3 animate-slide-down">
          {/* Email section */}
          {(entry.email || entry.emailPassword) && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-cyan-400 mb-1.5 flex items-center gap-1.5"><Mail className="w-3 h-3" /> Email</p>
              <PlainField label="Address" value={entry.email} />
              <RevealField label="Password" value={entry.emailPassword} defaultShown />
              <PlainField label="Recovery" value={entry.emailRecovery} />
              <RevealField label="Rec. Pass" value={entry.emailRecoveryPassword} defaultShown />
            </div>
          )}
          {/* Twitter */}
          {(entry.twitterUsername || entry.twitterPassword) && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-sky-400 mb-1.5 flex items-center gap-1.5"><Twitter className="w-3 h-3" /> Twitter / X</p>
              <PlainField label="Username" value={entry.twitterUsername} />
              <RevealField label="Password" value={entry.twitterPassword} defaultShown />
              <PlainField label="Email" value={entry.twitterEmail} />
              <RevealField label="Email Pass" value={entry.twitterEmailPassword} defaultShown />
              <RevealField label="2FA" value={entry.twitter2fa} defaultShown />
              <PlainField label="Followers" value={entry.twitterFollowers} />
              <PlainField label="Recovery" value={entry.twitterEmailRecovery} />
              <RevealField label="Rec. Pass" value={entry.twitterEmailRecoveryPassword} defaultShown />
            </div>
          )}
          {/* Discord */}
          {(entry.discordUsername || entry.discordPassword) && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-violet-400 mb-1.5 flex items-center gap-1.5"><MessageCircle className="w-3 h-3" /> Discord</p>
              <PlainField label="Username" value={entry.discordUsername} />
              <RevealField label="Password" value={entry.discordPassword} defaultShown />
              <PlainField label="Email" value={entry.discordEmail} />
              <RevealField label="Email Pass" value={entry.discordEmailPassword} defaultShown />
              <RevealField label="2FA" value={entry.discord2fa} defaultShown />
              <PlainField label="Recovery" value={entry.discordEmailRecovery} />
              <RevealField label="Rec. Pass" value={entry.discordEmailRecoveryPassword} defaultShown />
            </div>
          )}
          {/* Telegram */}
          {(entry.telegramUsername || entry.telegramPassword) && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-blue-400 mb-1.5 flex items-center gap-1.5"><Phone className="w-3 h-3" /> Telegram</p>
              <PlainField label="Username" value={entry.telegramUsername} />
              <RevealField label="Password" value={entry.telegramPassword} defaultShown />
              <PlainField label="Phone" value={entry.telegramPhone} />
              <RevealField label="2FA" value={entry.telegram2fa} defaultShown />
              <PlainField label="Linked Email" value={entry.telegramLinkedEmail} />
              <RevealField label="Email Pass" value={entry.telegramLinkedEmailPassword} defaultShown />
            </div>
          )}
          {/* Wallets */}
          {entry.walletAddresses?.length > 0 && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-yellow-400 mb-1.5 flex items-center gap-1.5"><Wallet className="w-3 h-3" /> Wallets</p>
              {entry.walletAddresses.map((w: string, i: number) => (
                <PlainField key={i} label={`Addr ${i + 1}`} value={w} />
              ))}
            </div>
          )}
          {/* Seed phrase */}
          {entry.seedPhrase && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-emerald-400 mb-1.5 flex items-center gap-1.5"><KeyRound className="w-3 h-3" /> Seed Phrase</p>
              <RevealField label="Seed" value={entry.seedPhrase} />
            </div>
          )}
          {/* Backup codes */}
          {entry.backupCodes?.length > 0 && (
            <div className="space-y-0.5 pb-2 border-b border-border/20">
              <p className="text-[9px] font-mono uppercase tracking-widest text-orange-400 mb-1.5 flex items-center gap-1.5"><Shield className="w-3 h-3" /> Backup Codes</p>
              {entry.backupCodes.map((c: string, i: number) => (
                <PlainField key={i} label={`Code ${i + 1}`} value={c} />
              ))}
            </div>
          )}
          {entry.notes && <p className="text-[10px] font-mono text-muted-foreground/60 pt-1">{entry.notes}</p>}
          <div className="text-[9px] font-mono text-muted-foreground/30 pt-1">Created {new Date(entry.createdAt).toLocaleString()}</div>
        </div>
      )}
    </div>
  );
}

// ─── Local Account Row ────────────────────────────────────────────────────────
function LocalAccountRow({ acc }: { acc: any }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={cn("border border-card-border rounded-lg overflow-hidden transition-all animate-pop-in", open && "border-primary/30")}>
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/10 transition-colors text-left">
        <Smartphone className="w-4 h-4 text-secondary flex-shrink-0" />
        <div className="flex-1 min-w-0 grid grid-cols-4 gap-2 items-center">
          <div className="font-mono text-sm font-bold text-secondary">{acc.label || acc.username || acc.email || "—"}</div>
          <div className="font-mono text-xs text-muted-foreground capitalize">{acc.category}</div>
          <div className="font-mono text-xs text-muted-foreground truncate">{acc.username || acc.user_email}</div>
          <div className="font-mono text-xs text-muted-foreground/50">{acc.username}</div>
        </div>
        {open ? <ChevronDown className="w-3.5 h-3.5 text-primary flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
      </button>
      {open && (
        <div className="border-t border-card-border px-4 py-3 bg-muted/5 space-y-0.5 animate-slide-down">
          <PlainField label="Owner" value={`${acc.username} (${acc.user_email})`} />
          <PlainField label="Category" value={acc.category} />
          <PlainField label="Label" value={acc.label} />
          <PlainField label="Username" value={acc.username} />
          <PlainField label="Email" value={acc.email} />
          <RevealField label="Password" value={acc.password} defaultShown />
          <PlainField label="Recovery" value={acc.recovery_email} />
          <RevealField label="Rec. Pass" value={acc.recovery_email_password} defaultShown />
          <RevealField label="2FA" value={acc.twofa} defaultShown />
          <PlainField label="Backup" value={acc.backup_codes} />
          <PlainField label="Followers" value={acc.followers?.toString()} />
          {acc.notes && <p className="text-[10px] font-mono text-muted-foreground/60 pt-2 border-t border-border/20">{acc.notes}</p>}
          <div className="text-[9px] font-mono text-muted-foreground/30 pt-1">Created {new Date(acc.created_at).toLocaleString()}</div>
        </div>
      )}
    </div>
  );
}

// ─── By-User Drilldown ────────────────────────────────────────────────────────
function UserDrilldown() {
  const [selectedUser, setSelectedUser] = useState<any>(null);
  const [search, setSearch] = useState("");

  const { data: users = [], isLoading: usersLoading } = useQuery<any[]>({
    queryKey: ["admin-vault-users"],
    queryFn: () => apiFetch("/api/admin/vault/users"),
  });

  const { data: userData, isLoading: userLoading } = useQuery<any>({
    queryKey: ["admin-vault-user", selectedUser?.id],
    queryFn: () => apiFetch(`/api/admin/vault/users/${selectedUser.id}`),
    enabled: !!selectedUser,
  });

  const filtered = users.filter(u => {
    if (!search) return true;
    const s = search.toLowerCase();
    return u.username?.toLowerCase().includes(s) || u.email?.toLowerCase().includes(s);
  });

  if (selectedUser) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <button onClick={() => setSelectedUser(null)} className="text-xs font-mono text-muted-foreground hover:text-primary transition-colors">← All Users</button>
          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40" />
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-xs text-primary">
              {(selectedUser.username || "?")[0].toUpperCase()}
            </div>
            <div>
              <p className="text-sm font-bold font-mono">{selectedUser.username}</p>
              <p className="text-[10px] text-muted-foreground font-mono">{selectedUser.email}</p>
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <Badge variant="outline" className="font-mono text-[10px]">{selectedUser.entity_count} entities</Badge>
            <Badge variant="outline" className="font-mono text-[10px]">{selectedUser.local_account_count} local</Badge>
          </div>
        </div>

        {userLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : (
          <>
            {userData?.entities?.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60">Vault Entities ({userData.entities.length})</p>
                {userData.entities.map((e: any) => <FullEntityRow key={e.id} entry={e} />)}
              </div>
            )}
            {userData?.localAccounts?.length > 0 && (
              <div className="space-y-2 mt-4">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60">Local Accounts ({userData.localAccounts.length})</p>
                {userData.localAccounts.map((a: any) => <LocalAccountRow key={a.id} acc={a} />)}
              </div>
            )}
            {!userData?.entities?.length && !userData?.localAccounts?.length && (
              <div className="text-center py-16 font-mono text-muted-foreground">No vault data for this user.</div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input placeholder="Search users..." className="pl-8 font-mono text-sm bg-card border-card-border h-9" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      {usersLoading ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (
        <div className="space-y-1.5">
          {filtered.map(u => (
            <button key={u.id} onClick={() => setSelectedUser(u)}
              className="w-full flex items-center gap-3 px-4 py-3 bg-card border border-card-border rounded-lg hover:border-primary/30 hover:bg-primary/5 transition-all text-left animate-pop-in">
              <div className="w-9 h-9 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-bold text-sm text-primary font-mono flex-shrink-0">
                {(u.username || "?")[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm font-bold text-foreground">{u.username}</p>
                <p className="font-mono text-xs text-muted-foreground truncate">{u.email}</p>
              </div>
              <div className="flex gap-2">
                <Badge variant="outline" className="font-mono text-[9px] border-primary/20">{u.entity_count}E</Badge>
                <Badge variant="outline" className="font-mono text-[9px] border-secondary/20">{u.local_account_count}L</Badge>
              </div>
              <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/40" />
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="py-16 text-center font-mono text-muted-foreground text-sm">No users found.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Admin Vault ─────────────────────────────────────────────────────────
type VaultTab = "all" | "local" | "users";

export default function AdminVault() {
  const [tab, setTab] = useState<VaultTab>("all");
  const [search, setSearch] = useState("");

  const { data: entities = [], isLoading: entitiesLoading, refetch: refetchEntities } = useQuery<any[]>({
    queryKey: ["admin-vault-full"],
    queryFn: () => apiFetch("/api/admin/vault/full"),
    staleTime: 30_000,
  });

  const { data: localAccounts = [], isLoading: localLoading, refetch: refetchLocal } = useQuery<any[]>({
    queryKey: ["admin-vault-local"],
    queryFn: () => apiFetch("/api/admin/vault/local-accounts"),
    staleTime: 30_000,
    enabled: tab === "local",
  });

  const refetch = useCallback(() => {
    refetchEntities();
    if (tab === "local") refetchLocal();
  }, [tab, refetchEntities, refetchLocal]);

  const filteredEntities = entities.filter(e => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      e.entitySerial?.toLowerCase().includes(s) ||
      e.projectName?.toLowerCase().includes(s) ||
      e.username?.toLowerCase().includes(s) ||
      e.userEmail?.toLowerCase().includes(s) ||
      e.email?.toLowerCase().includes(s)
    );
  });

  const filteredLocal = localAccounts.filter(a => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      a.label?.toLowerCase().includes(s) ||
      a.username?.toLowerCase().includes(s) ||
      a.email?.toLowerCase().includes(s) ||
      a.category?.toLowerCase().includes(s) ||
      a.user_email?.toLowerCase().includes(s)
    );
  });

  const TABS: { id: VaultTab; label: string; icon: React.ElementType; count?: number }[] = [
    { id: "all",   label: "All Entities",    icon: Database,   count: entities.length },
    { id: "local", label: "Local Accounts",  icon: Smartphone, count: tab === "local" ? localAccounts.length : undefined },
    { id: "users", label: "By User",         icon: Users },
  ];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <Lock className="w-6 h-6 text-primary" /> Admin Vault
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            Full unencrypted access — all operators, all data
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refetch} className="gap-2 font-mono text-xs border-border h-8">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0.5 border-b border-border/40">
        {TABS.map(t => (
          <button key={t.id} onClick={() => { setTab(t.id); setSearch(""); }}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 text-xs font-mono font-medium border-b-2 -mb-px transition-all",
              tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            )}>
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
            {t.count !== undefined && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-mono", tab === t.id ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground")}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Search (for all / local tabs) */}
      {tab !== "users" && (
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={tab === "all" ? "Search by serial, name, user, email…" : "Search by label, username, email…"}
            className="pl-9 font-mono bg-card border-card-border text-sm h-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      )}

      {/* Content */}
      {tab === "all" && (
        <>
          {!entitiesLoading && filteredEntities.length > 0 && (
            <div className="grid grid-cols-4 gap-2 px-4 text-[9px] font-mono uppercase text-muted-foreground/50 tracking-widest">
              <div>Serial</div><div>Entity Name</div><div>Operator</div><div>Category</div>
            </div>
          )}
          <div className="space-y-2">
            {entitiesLoading
              ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)
              : filteredEntities.length === 0
              ? <div className="py-16 text-center font-mono text-muted-foreground bg-card border border-card-border border-dashed rounded-md">{search ? "No matches." : "No vault entities found."}</div>
              : filteredEntities.map(e => <FullEntityRow key={e.id} entry={e} />)
            }
          </div>
        </>
      )}

      {tab === "local" && (
        <>
          {!localLoading && filteredLocal.length > 0 && (
            <div className="grid grid-cols-4 gap-2 px-4 text-[9px] font-mono uppercase text-muted-foreground/50 tracking-widest">
              <div>Label</div><div>Category</div><div>Owner</div><div>Username</div>
            </div>
          )}
          <div className="space-y-2">
            {localLoading
              ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)
              : filteredLocal.length === 0
              ? <div className="py-16 text-center font-mono text-muted-foreground bg-card border border-card-border border-dashed rounded-md">{search ? "No matches." : "No local accounts found."}</div>
              : filteredLocal.map(a => <LocalAccountRow key={a.id} acc={a} />)
            }
          </div>
        </>
      )}

      {tab === "users" && <UserDrilldown />}
    </div>
  );
}
