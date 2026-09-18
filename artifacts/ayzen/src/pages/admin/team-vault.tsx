import { useState, useEffect, useMemo } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Vault, Search, RefreshCw, Loader2, Users, Mail, Twitter, MessageCircle,
  Send, ChevronDown, ChevronRight, Copy, Check, KeyRound, Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TeamVaultEntry = {
  id: number;
  user_id: number;
  username: string;
  owner_email: string;
  team_id: number;
  team_name: string;
  project_name: string;
  category: string;
  email?: string;
  email_recovery?: string;
  email_recovery_password?: string;
  twitter_email?: string;
  twitter_email_password?: string;
  twitter_followers?: string;
  twitter_2fa?: string;
  discord_email?: string;
  discord_email_password?: string;
  discord_2fa?: string;
  telegram_phone?: string;
  telegram_2fa?: string;
  telegram_linked_email?: string;
  telegram_linked_email_password?: string;
  entity_serial?: string;
  created_at: string;
};

function Field({ label, value, icon: Icon }: { label: string; value?: string | null; icon?: React.ElementType }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  return (
    <div className="flex items-center gap-2 py-1 group/f">
      {Icon && <Icon className="w-3 h-3 text-muted-foreground/40 flex-shrink-0" />}
      <span className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-wider w-24 flex-shrink-0">{label}</span>
      <span className="flex-1 font-mono text-[11px] text-foreground/90 truncate select-all">{value}</span>
      <button onClick={copy} className={cn("opacity-0 group-hover/f:opacity-100 transition-all", copied ? "text-emerald-400" : "text-muted-foreground/40 hover:text-primary")}>
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      </button>
    </div>
  );
}

function EntryCard({ entry }: { entry: TeamVaultEntry }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="border border-border/40 rounded-xl overflow-hidden bg-card/40">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-3 p-3 hover:bg-muted/10 transition-colors text-left">
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
        <div className="w-8 h-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-xs shrink-0">
          {entry.project_name?.[0]?.toUpperCase() || "?"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">{entry.project_name || "Untitled Entity"}</p>
          <p className="text-[10px] text-muted-foreground font-mono truncate">
            {entry.team_name} · owned by {entry.username}
          </p>
        </div>
      </button>
      {open && (
        <div className="border-t border-border/40 p-3 space-y-0.5 bg-background/30">
          <Field label="Email" value={entry.email} icon={Mail} />
          <Field label="Recovery Email" value={entry.email_recovery} icon={Mail} />
          <Field label="Recovery Pass" value={entry.email_recovery_password} icon={KeyRound} />
          <Field label="Twitter Email" value={entry.twitter_email} icon={Twitter} />
          <Field label="Twitter Pass" value={entry.twitter_email_password} icon={KeyRound} />
          <Field label="Twitter 2FA" value={entry.twitter_2fa} icon={Shield} />
          <Field label="Discord Email" value={entry.discord_email} icon={MessageCircle} />
          <Field label="Discord Pass" value={entry.discord_email_password} icon={KeyRound} />
          <Field label="Discord 2FA" value={entry.discord_2fa} icon={Shield} />
          <Field label="Telegram Phone" value={entry.telegram_phone} icon={Send} />
          <Field label="Telegram 2FA" value={entry.telegram_2fa} icon={Shield} />
          <Field label="TG Linked Email" value={entry.telegram_linked_email} icon={Mail} />
          <Field label="TG Linked Pass" value={entry.telegram_linked_email_password} icon={KeyRound} />
          <Field label="Serial" value={entry.entity_serial} icon={KeyRound} />
        </div>
      )}
    </div>
  );
}

export default function AdminTeamVaultPage() {
  const [entries, setEntries] = useState<TeamVaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [teamFilter, setTeamFilter] = useState<number | "all">("all");

  const load = async () => {
    setLoading(true);
    try {
      const data = await customFetch<TeamVaultEntry[]>("/api/admin/team-vault");
      setEntries(Array.isArray(data) ? data : []);
    } catch { setEntries([]); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const teams = useMemo(() => {
    const map = new Map<number, string>();
    entries.forEach(e => map.set(e.team_id, e.team_name));
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [entries]);

  const filtered = entries.filter(e => {
    if (teamFilter !== "all" && e.team_id !== teamFilter) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      e.project_name?.toLowerCase().includes(q) ||
      e.username?.toLowerCase().includes(q) ||
      e.team_name?.toLowerCase().includes(q) ||
      e.email?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <Vault className="h-6 w-6 text-primary" /> Team Vault
        </h1>
        <p className="text-muted-foreground font-mono text-sm">
          Full visibility into every entity credential stored by team members — passwords shown in plaintext for audit access.
        </p>
      </div>

      <div className="bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2 flex items-start gap-2">
        <Shield className="w-3.5 h-3.5 text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-[10px] font-mono text-amber-300 leading-relaxed">
          This page reveals sensitive account credentials belonging to team members. Access is admin-only and should be limited to support/audit purposes.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {[
          { label: "Entities", value: entries.length, icon: Vault, color: "text-cyan-400", bg: "bg-cyan-400/10" },
          { label: "Teams", value: teams.length, icon: Users, color: "text-violet-400", bg: "bg-violet-400/10" },
          { label: "Owners", value: new Set(entries.map(e => e.user_id)).size, icon: Users, color: "text-emerald-400", bg: "bg-emerald-400/10" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-border/40 rounded-xl p-4 flex items-start gap-3">
            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", s.bg)}>
              <s.icon className={cn("w-4 h-4", s.color)} />
            </div>
            <div>
              <p className={cn("text-xl font-mono font-bold", s.color)}>{s.value}</p>
              <p className="text-[10px] text-muted-foreground font-mono">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="flex gap-1 bg-card border border-border/40 rounded-lg p-1 overflow-x-auto max-w-full">
          <button onClick={() => setTeamFilter("all")}
            className={cn("px-3 py-1.5 text-xs font-mono rounded transition-all shrink-0",
              teamFilter === "all" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
            All Teams
          </button>
          {teams.map(t => (
            <button key={t.id} onClick={() => setTeamFilter(t.id)}
              className={cn("px-3 py-1.5 text-xs font-mono rounded transition-all shrink-0",
                teamFilter === t.id ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-foreground")}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="relative flex-1 max-w-xs">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search entity, owner, team..." className="h-8 text-xs pl-8 bg-background/50" />
        </div>
        <Button size="sm" variant="ghost" onClick={load} className="h-8 text-xs gap-1 ml-auto">
          <RefreshCw className="w-3 h-3" /> Refresh
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 font-mono text-muted-foreground text-sm">No team vault entries found</div>
      ) : (
        <div className="space-y-2">
          {filtered.map(e => <EntryCard key={e.id} entry={e} />)}
        </div>
      )}
    </div>
  );
}
