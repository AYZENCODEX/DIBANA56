import { useState, useEffect, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Users, Plus, Send, MessageCircle, Settings, Crown,
  UserPlus, Trash2, ChevronRight, RefreshCw,
  BarChart2, FolderGit2, Loader2, Trophy, TrendingUp,
  Activity, Star, Zap, Shield, Medal, Target, CheckCircle2,
  KeyRound, Clock, Check, X, Lock, Wallet, Swords, ListTodo,
  Bell, ChevronDown, ChevronUp, ArrowLeft, LayoutDashboard,
  Smartphone, Mail, Search, Link2, Copy, Globe, AtSign,
  Boxes, MoreHorizontal, LogOut, Wifi,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { ImapSmtpForm, detectProviderFromEmail, type EmailAccount } from "@/components/mail/imap-smtp-form";

type Team = { id: number; name: string; description?: string; owner_id: number; member_count: number; member_role: string; status: string; created_at: string };
type Member = { id: number; user_id: number; team_id: number; role: string; status: string; username: string; email: string; joined_at: string; total_roi?: number; streak?: number };
type Message = { id: number; team_id: number; user_id: number; message: string; created_at: string; username?: string };
type TeamDetail = Team & { members: Member[]; myRole: string };
type TeamStats = { memberCount: number; messageCount: number; projectCount: number; totalRoi: number; recentActivity: any[] };
type LeaderboardEntry = { user_id: number; role: string; username: string; total_roi: number; streak: number; tasks_completed: number; messages_sent: number; azn_balance: number; rank: number };
type TeamProject = { id: number; name: string; status: string; task_count: number; participant_count: number; created_at: string; category?: string };
type Mission = { id: number; team_id: number; title: string; description?: string; status: string; target_value: number; current_value: number; reward_amount: number; deadline?: string; created_by: number; created_by_username?: string; created_at: string };
type VaultEntry = { id: number; project_name: string; category: string; email?: string; twitter_username?: string; discord_username?: string; telegram_username?: string; entity_serial?: string; user_id: number; username?: string; created_at: string };
type PendingInvite = { id: number; team_id: number; team_name: string; invited_by_username?: string; invited_at: string };

type Tab = "dashboard" | "members" | "vault" | "missions" | "tasks" | "leaderboard" | "projects" | "chat" | "panel" | "browse" | "invite" | "mail" | "activity";

// ─── Phase 11A/11B — Team sidebar shell + old-tab mapping ─────────────────────
// Hierarchical 4-section nav. Phase 16C removed the old flat-tab render branch
// and the ?nav=new opt-in gate — this is now the only codepath. Old flat-tab
// deep links (e.g. `/teams?tab=missions`) still work: `tab` is resolved from
// the URL as before and mapped to its section via TAB_TO_SECTION below, so a
// bare `?tab=` link (no `?section=`) lands on the right section/sub-view.
type Section = "overview" | "task" | "app" | "other";

const SECTION_META: { id: Section; label: string; icon: React.ElementType }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "task",     label: "Task",     icon: ListTodo },
  { id: "app",      label: "App",      icon: Boxes },
  { id: "other",    label: "Other",    icon: MoreHorizontal },
];

// Phase 11B — old tabs nested into their new section, reusing the exact same
// tab components. `browse` is deliberately left out here — it's a standalone
// full-page view rendered before section branching (works with or without a
// selected team). `leaderboard` is also left out — Phase 12B surfaces it as a
// dialog from the Overview section instead of its own nav entry; a legacy
// `?tab=leaderboard` deep link still opens that dialog (see TeamsPage).
const SECTION_SUBTABS: Record<Section, { id: Tab; label: string; icon: React.ElementType; leaderOnly?: boolean }[]> = {
  overview: [
    { id: "dashboard", label: "Overview", icon: LayoutDashboard },
  ],
  task: [
    { id: "tasks",    label: "Tasks",    icon: ListTodo },
    { id: "missions", label: "Missions", icon: Swords },
  ],
  app: [
    { id: "vault",    label: "Vault",    icon: Wallet },
    { id: "projects", label: "Projects", icon: FolderGit2 },
    { id: "mail",     label: "Mail",     icon: Mail },
  ],
  other: [
    { id: "members",  label: "Members",     icon: Users },
    { id: "activity", label: "Activity Log", icon: Activity },
    { id: "chat",     label: "Chat",        icon: MessageCircle },
    { id: "invite",   label: "Invite Link", icon: Link2,     leaderOnly: true },
    { id: "panel",    label: "Panel",       icon: Settings,  leaderOnly: true },
  ],
};
const TAB_TO_SECTION: Partial<Record<Tab, Section>> = {
  dashboard: "overview",
  missions: "task", tasks: "task",
  vault: "app", projects: "app", mail: "app",
  members: "other", activity: "other", chat: "other", invite: "other", panel: "other",
};

function Avatar({ name, size = "md", role }: { name: string; size?: "sm" | "md" | "lg"; role?: string }) {
  const sizes = { sm: "w-6 h-6 text-[9px]", md: "w-8 h-8 text-xs", lg: "w-10 h-10 text-sm" };
  return (
    <div className={cn("rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-mono font-bold text-primary relative flex-shrink-0", sizes[size])}>
      {(name || "?")[0].toUpperCase()}
      {role === "leader" && (
        <span className="absolute -top-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full flex items-center justify-center">
          <Crown className="w-1.5 h-1.5 text-background" />
        </span>
      )}
    </div>
  );
}

// ─── Pending Invites Banner ───────────────────────────────────────────────────
function PendingInvitesBanner({ onAccepted }: { onAccepted: () => void }) {
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    customFetch<PendingInvite[]>("/api/teams/my-invites")
      .then(d => setInvites(Array.isArray(d) ? d : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const respond = async (teamId: number, action: "accept" | "reject") => {
    try {
      await customFetch(`/api/teams/${teamId}/invites/respond`, { method: "PATCH", body: JSON.stringify({ action }) });
      setInvites(prev => prev.filter(i => i.team_id !== teamId));
      toast({ title: action === "accept" ? "Joined team!" : "Invite declined" });
      if (action === "accept") onAccepted();
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  if (loading || invites.length === 0) return null;

  return (
    <div className="space-y-2 mb-1">
      {invites.map(inv => (
        <div key={inv.id} className="flex items-center gap-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl animate-pop-in">
          <Bell className="w-4 h-4 text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-foreground">{inv.team_name}</p>
            <p className="text-xs text-muted-foreground font-mono">Pending team invite{inv.invited_by_username ? ` from ${inv.invited_by_username}` : ""}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" className="h-7 text-xs gap-1" onClick={() => respond(inv.team_id, "accept")}><Check className="w-3 h-3" /> Accept</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-muted-foreground hover:text-red-400" onClick={() => respond(inv.team_id, "reject")}><X className="w-3 h-3" /> Decline</Button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Team Dashboard ───────────────────────────────────────────────────────────
function TeamDashboard({ team }: { team: TeamDetail }) {
  const [stats, setStats] = useState<TeamStats | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      customFetch<TeamStats>(`/api/teams/${team.id}/stats`).catch(() => null),
      customFetch<LeaderboardEntry[]>(`/api/teams/${team.id}/leaderboard`).catch(() => []),
      customFetch<Mission[]>(`/api/teams/${team.id}/missions`).catch(() => []),
    ]).then(([s, b, m]) => {
      setStats(s as TeamStats | null);
      setBoard(Array.isArray(b) ? b : []);
      setMissions(Array.isArray(m) ? m : []);
    }).finally(() => setLoading(false));
  }, [team.id]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  const topStreak = board.length ? Math.max(...board.map(m => m.streak || 0)) : 0;
  const totalTasks = board.reduce((a, m) => a + (m.tasks_completed || 0), 0);
  const activeMissions = missions.filter(m => m.status === "active");
  const avgProgress = activeMissions.length
    ? Math.round(activeMissions.reduce((a, m) => a + (m.current_value / m.target_value) * 100, 0) / activeMissions.length)
    : 0;
  const highEffortUsers = [...board].sort((a, b) => (b.tasks_completed || 0) - (a.tasks_completed || 0)).slice(0, 3);

  const statCards = [
    { label: "Members",     value: stats?.memberCount ?? team.member_count,        icon: Users,        color: "text-cyan-400",    bg: "bg-cyan-400/10" },
    { label: "Team ROI",    value: `$${(stats?.totalRoi ?? 0).toFixed(2)}`,        icon: TrendingUp,   color: "text-amber-400",   bg: "bg-amber-400/10" },
    { label: "Top Streak",  value: topStreak > 0 ? `${topStreak}d 🔥` : "—",      icon: Zap,          color: "text-orange-400",  bg: "bg-orange-400/10" },
    { label: "Total Tasks", value: totalTasks,                                      icon: CheckCircle2, color: "text-emerald-400", bg: "bg-emerald-400/10" },
    { label: "Projects",    value: stats?.projectCount ?? 0,                        icon: FolderGit2,   color: "text-violet-400",  bg: "bg-violet-400/10" },
    { label: "Avg Progress", value: activeMissions.length ? `${avgProgress}%` : "—", icon: Target,    color: "text-primary",     bg: "bg-primary/10" },
  ];

  return (
    <div className="space-y-5 animate-fade-up">
      {team.status === "pending" && (
        <div className="flex items-center gap-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl">
          <Clock className="w-4 h-4 text-amber-400 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-400">Pending Admin Approval</p>
            <p className="text-xs text-muted-foreground font-mono">Features unlock once approved.</p>
          </div>
        </div>
      )}

      {/* Stat Grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {statCards.map((s, i) => (
          <div key={s.label} className="bg-card/60 border border-border/40 rounded-xl p-4 flex items-start gap-3 animate-pop-in" style={{ animationDelay: `${i * 60}ms` }}>
            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", s.bg)}>
              <s.icon className={cn("w-4 h-4", s.color)} />
            </div>
            <div>
              <div className={cn("text-xl font-mono font-bold", s.color)}>{s.value}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Team Info + High Effort Users */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Team Info + Mission Progress */}
        <div className="bg-card/60 border border-border/40 rounded-xl p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-lg flex-shrink-0">
              {team.name[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-foreground truncate">{team.name}</h3>
              {team.description && <p className="text-xs text-muted-foreground font-mono truncate">{team.description}</p>}
              <p className="text-xs text-muted-foreground/60 font-mono">Created {new Date(team.created_at).toLocaleDateString()}</p>
            </div>
            <Badge variant="outline" className="text-[10px] capitalize flex-shrink-0">{team.myRole}</Badge>
          </div>
          {activeMissions.length > 0 ? (
            <div className="space-y-2.5 mt-2">
              <p className="text-[10px] text-muted-foreground/60 font-mono uppercase tracking-widest">Active Mission Progress</p>
              {activeMissions.slice(0, 2).map(m => {
                const pct = Math.round((m.current_value / m.target_value) * 100);
                return (
                  <div key={m.id} className="space-y-1">
                    <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                      <span className="truncate pr-2">{m.title}</span>
                      <span className="shrink-0 font-bold">{pct}%</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <p className="text-[10px] text-muted-foreground/60 font-mono uppercase tracking-widest">Top Members</p>
              {team.members.filter(m => m.status === "active").slice(0, 4).map(m => (
                <div key={m.id} className="flex items-center gap-2">
                  <Avatar name={m.username || m.email || "?"} size="sm" role={m.role} />
                  <span className="text-xs font-mono text-foreground truncate flex-1">{m.username || m.email}</span>
                  <Badge variant="outline" className={cn("text-[9px] capitalize", m.role === "leader" ? "border-yellow-500/30 text-yellow-400" : "")}>{m.role}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* High Effort Operators */}
        <div className="bg-card/60 border border-border/40 rounded-xl p-5">
          <p className="text-[10px] text-muted-foreground/60 font-mono uppercase tracking-widest mb-3 flex items-center gap-1.5">
            <Star className="w-3 h-3 text-amber-400" /> High Effort Operators
          </p>
          {highEffortUsers.length === 0 ? (
            <p className="text-xs text-muted-foreground/40 font-mono">No activity recorded yet.</p>
          ) : (
            <div className="space-y-3">
              {highEffortUsers.map((u, i) => (
                <div key={u.user_id} className="flex items-center gap-3">
                  <div className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center font-mono text-[10px] font-bold flex-shrink-0",
                    i === 0 ? "bg-yellow-500/20 text-yellow-400" : i === 1 ? "bg-slate-400/20 text-slate-300" : "bg-amber-700/20 text-amber-600"
                  )}>
                    {i + 1}
                  </div>
                  <Avatar name={u.username || "?"} size="sm" role={u.role} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-foreground truncate">{u.username}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[9px] font-mono text-muted-foreground">{u.tasks_completed} tasks</span>
                      {u.streak > 0 && <span className="text-[9px] font-mono text-orange-400">{u.streak}d 🔥</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-mono font-bold text-amber-400">${u.total_roi.toFixed(2)}</p>
                    <p className="text-[9px] text-muted-foreground font-mono">{u.azn_balance.toFixed(1)} AZN</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Recent Activity */}
          {(stats?.recentActivity ?? []).length > 0 && (
            <div className="mt-4 pt-3 border-t border-border/30 space-y-1.5">
              <p className="text-[9px] text-muted-foreground/50 font-mono uppercase tracking-widest mb-2">Recent Activity</p>
              {(stats?.recentActivity ?? []).slice(0, 3).map((a: any, i: number) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Activity className="w-2.5 h-2.5 text-primary/40 flex-shrink-0" />
                  <span className="text-[10px] font-mono text-muted-foreground/60 truncate">{a.username} sent a message</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Team Members ─────────────────────────────────────────────────────────────
type MemberProgress = { userId: number; tasksCompleted: number; missionContribution: number; vaultActivityCount: number };

function TeamMembers({ team, onRefresh }: { team: TeamDetail; onRefresh: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const active = team.members.filter(m => m.status !== "pending");
  const pending = team.members.filter(m => m.status === "pending");

  // Phase 15A — live progress per member (task completions, mission
  // contribution, vault-activity) instead of a static roster. Best-effort:
  // if it fails to load, the roster still renders without the extra badges.
  const [progress, setProgress] = useState<Record<number, MemberProgress>>({});
  useEffect(() => {
    customFetch<MemberProgress[]>(`/api/teams/${team.id}/member-progress`)
      .then(d => setProgress(Object.fromEntries((Array.isArray(d) ? d : []).map(p => [p.userId, p]))))
      .catch(() => {});
  }, [team.id]);

  const removeMember = async (userId: number) => {
    try {
      await customFetch(`/api/teams/${team.id}/members/${userId}`, { method: "DELETE" });
      toast({ title: "Member removed" }); onRefresh();
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const promoteOrDemote = async (userId: number, currentRole: string) => {
    const newRole = currentRole === "leader" ? "member" : "leader";
    try {
      await customFetch(`/api/teams/${team.id}/members/${userId}/role`, { method: "PATCH", body: JSON.stringify({ role: newRole }) });
      toast({ title: `Role updated to ${newRole}` }); onRefresh();
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground">{active.length} Active Members</p>
        {pending.length > 0 && <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400">{pending.length} pending</Badge>}
      </div>
      {pending.length > 0 && team.myRole === "leader" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-mono uppercase tracking-widest">Awaiting Acceptance</p>
          {pending.map(m => (
            <div key={m.id} className="flex items-center gap-3 p-3 bg-amber-500/5 border border-amber-500/20 rounded-xl animate-pop-in">
              <Avatar name={m.username || m.email || "?"} size="sm" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground">{m.username || m.email}</p>
                <p className="text-[10px] text-muted-foreground font-mono">Invited · Pending</p>
              </div>
              <button onClick={() => removeMember(m.user_id)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {active.map((m, i) => (
          <div key={m.id} className="bg-card/60 border border-border/40 rounded-xl p-4 flex items-center gap-3 group hover:border-primary/30 transition-colors animate-pop-in" style={{ animationDelay: `${i * 40}ms` }}>
            <Avatar name={m.username || m.email || "?"} size="lg" role={m.role} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground truncate">{m.username || m.email}</span>
                {m.user_id === team.owner_id && <Badge variant="outline" className="text-[9px] border-yellow-500/30 text-yellow-400 gap-0.5"><Crown className="w-2 h-2" /> Owner</Badge>}
              </div>
              {m.email && <p className="text-[10px] text-muted-foreground font-mono truncate">{m.email}</p>}
              <div className="flex items-center gap-3 mt-1">
                <span className="text-[10px] text-muted-foreground font-mono">Joined {new Date(m.joined_at).toLocaleDateString()}</span>
                {m.streak != null && m.streak > 0 && <span className="text-[10px] text-orange-400 font-mono">{m.streak}d 🔥</span>}
              </div>
              {progress[m.user_id] && (
                <div className="flex items-center gap-2.5 mt-1.5 flex-wrap">
                  <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground" title="Tasks completed">
                    <ListTodo className="w-3 h-3 text-primary/70" /> {progress[m.user_id].tasksCompleted}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground" title="Mission progress contributed">
                    <Swords className="w-3 h-3 text-primary/70" /> {progress[m.user_id].missionContribution}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground" title="Vault activity">
                    <KeyRound className="w-3 h-3 text-primary/70" /> {progress[m.user_id].vaultActivityCount}
                  </span>
                </div>
              )}
            </div>
            {team.myRole === "leader" && m.user_id !== user?.id && (
              <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => promoteOrDemote(m.user_id, m.role)} className="p-1.5 rounded hover:bg-yellow-500/10 text-muted-foreground hover:text-yellow-400 transition-colors">
                  <Crown className="w-3.5 h-3.5" />
                </button>
                {m.user_id !== team.owner_id && (
                  <button onClick={() => removeMember(m.user_id)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Team Activity Log ─────────────────────────────────────────────────────────
// Phase 15B, fixed in Phase 17 — chronological feed of team-level actions,
// sourced from GET /teams/:id/activity, which merges the shared Phase 4
// activity_log table (subject_type="team") with any pre-fix
// team_activity_log rows server-side. Both sources are normalized into the
// same ActivityEntry shape before reaching this component, so member/role/
// mailbox/ownership events (previously a separate, never-shown log) render
// through the exact same list as vault-usage and mission-progress events —
// no special-casing which table an event came from.
type ActivityEntry = {
  id: number; action: string; actorUserId: number | null; actorUsername?: string | null;
  amount: number | null; meta: Record<string, any> | null; createdAt: string;
};

function activityDescription(e: ActivityEntry): { icon: React.ElementType; text: string } {
  const who = e.actorUsername || (e.actorUserId ? `User #${e.actorUserId}` : "Someone");
  if (e.action === "vault_used") {
    const entity = e.meta?.entityName || `entity #${e.meta?.vaultEntryId ?? "?"}`;
    const vaultAction = e.meta?.vaultAction ? String(e.meta.vaultAction).replace(/_/g, " ") : "used";
    return { icon: KeyRound, text: `${who} ${vaultAction} vault entity "${entity}"` };
  }
  if (e.action === "mission_progress") {
    const mission = e.meta?.missionTitle || "a mission";
    const sign = (e.amount ?? 0) >= 0 ? "+" : "";
    return { icon: Swords, text: `${who} contributed ${sign}${e.amount ?? 0} to mission "${mission}"` };
  }
  if (e.action === "member_removed") {
    return { icon: Users, text: `${who} removed a member (#${e.meta?.memberId ?? "?"})` };
  }
  if (e.action === "role_changed") {
    return { icon: Shield, text: `${who} changed a member's role to ${e.meta?.newRole ?? "?"}` };
  }
  if (e.action === "mailbox_added") {
    return { icon: Mail, text: `${who} added mailbox "${e.meta?.emailAddress ?? "?"}"` };
  }
  if (e.action === "ownership_transferred") {
    return { icon: Star, text: `${who} transferred ownership to user #${e.meta?.newOwnerId ?? "?"}` };
  }
  if (e.action === "member_left") {
    return { icon: Users, text: `${who} left the team` };
  }
  if (e.action === "team_join_request_approve" || e.action === "team_join_request_reject") {
    const verb = e.action.endsWith("approve") ? "approved" : "rejected";
    return { icon: Users, text: `${who} ${verb} a join request` };
  }
  return { icon: Activity, text: `${who} — ${e.action.replace(/_/g, " ")}` };
}

function TeamActivity({ team }: { team: TeamDetail }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    customFetch<ActivityEntry[]>(`/api/teams/${team.id}/activity`)
      .then(d => setEntries(Array.isArray(d) ? d : []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [team.id]);

  if (loading) {
    return <div className="flex items-center justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>;
  }

  if (entries.length === 0) {
    return (
      <div className="text-center py-10 space-y-2">
        <Activity className="w-6 h-6 text-muted-foreground/40 mx-auto" />
        <p className="text-sm text-muted-foreground font-mono">No team activity yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-fade-up">
      <p className="text-sm font-semibold text-foreground">Activity Log</p>
      <div className="space-y-1.5">
        {entries.map((e, i) => {
          const { icon: Icon, text } = activityDescription(e);
          return (
            <div key={e.id} className="flex items-start gap-3 p-3 bg-card/60 border border-border/40 rounded-xl animate-pop-in" style={{ animationDelay: `${Math.min(i, 20) * 20}ms` }}>
              <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Icon className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground">{text}</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-0.5">{new Date(e.createdAt).toLocaleString()}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Team Vault (Tabbed) ──────────────────────────────────────────────────────
type VaultTab2 = "entity" | "local" | "2fa" | "wallet" | "mail";
const SPECIAL_VAULT_CATS = ["local_account", "2fa", "wallet_address", "mail"];

function TeamVault({ team }: { team: TeamDetail }) {
  const [vaultTab, setVaultTab] = useState<VaultTab2>("entity");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({
    category: "defi", projectName: "", email: "", twitterUsername: "",
    discordUsername: "", telegramUsername: "", notes: "",
  });
  const { toast } = useToast();

  const loadEntries = () => {
    setLoading(true);
    customFetch<VaultEntry[]>(`/api/teams/${team.id}/vault`)
      .then(d => setEntries(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadEntries(); }, [team.id]);

  const filterForTab = (all: VaultEntry[], t: VaultTab2) => {
    if (t === "entity") return all.filter(e => !SPECIAL_VAULT_CATS.includes(e.category));
    if (t === "local")  return all.filter(e => e.category === "local_account");
    if (t === "2fa")    return all.filter(e => e.category === "2fa");
    if (t === "wallet") return all.filter(e => e.category === "wallet_address");
    if (t === "mail")   return all.filter(e => e.category === "mail");
    return all;
  };

  const defaultCatForTab = (t: VaultTab2) =>
    t === "local" ? "local_account" : t === "2fa" ? "2fa" : t === "wallet" ? "wallet_address" : t === "mail" ? "mail" : "defi";

  const openCreate = () => {
    setForm({ category: defaultCatForTab(vaultTab), projectName: "", email: "", twitterUsername: "", discordUsername: "", telegramUsername: "", notes: "" });
    setCreateOpen(true);
  };

  const createEntry = async () => {
    if (!form.projectName.trim()) return;
    setSaving(true);
    try {
      await customFetch(`/api/teams/${team.id}/vault`, { method: "POST", body: JSON.stringify(form) });
      toast({ title: "Entry created!" });
      setCreateOpen(false);
      loadEntries();
    } catch { toast({ title: "Failed", variant: "destructive" }); } finally { setSaving(false); }
  };

  const VAULT_TABS: { id: VaultTab2; label: string; icon: React.ElementType }[] = [
    { id: "entity", label: "Entity",  icon: Shield },
    { id: "local",  label: "Local",   icon: Smartphone },
    { id: "2fa",    label: "2FA",     icon: KeyRound },
    { id: "wallet", label: "Wallet",  icon: Wallet },
    { id: "mail",   label: "Mail",    icon: Mail },
  ];

  const getFormFields = () => {
    if (vaultTab === "entity") return [
      { label: "Project Name", key: "projectName", ph: "e.g. Blast" },
      { label: "Email", key: "email", ph: "shared@team.com" },
      { label: "Twitter", key: "twitterUsername", ph: "@handle" },
      { label: "Discord", key: "discordUsername", ph: "handle" },
      { label: "Telegram", key: "telegramUsername", ph: "@handle" },
      { label: "Notes", key: "notes", ph: "Optional" },
    ];
    if (vaultTab === "local") return [
      { label: "Account Name", key: "projectName", ph: "e.g. Local Account #1" },
      { label: "Username / Email", key: "email", ph: "user@example.com" },
      { label: "Password / Hint", key: "notes", ph: "Password or hint" },
    ];
    if (vaultTab === "2fa") return [
      { label: "Service Name", key: "projectName", ph: "e.g. Binance" },
      { label: "Account Email", key: "email", ph: "account@email.com" },
      { label: "Secret / Backup Code", key: "notes", ph: "TOTP secret or backup code" },
    ];
    if (vaultTab === "wallet") return [
      { label: "Chain / Protocol", key: "projectName", ph: "e.g. Ethereum" },
      { label: "Wallet Address", key: "notes", ph: "0x..." },
      { label: "Label", key: "email", ph: "Hot wallet, Cold wallet..." },
    ];
    if (vaultTab === "mail") return [
      { label: "Email Address", key: "projectName", ph: "team@example.com" },
      { label: "Password / Hint", key: "notes", ph: "Password or hint" },
      { label: "Recovery", key: "email", ph: "Recovery email or phone" },
    ];
    return [];
  };

  const CAT_COLORS: Record<string, string> = {
    defi: "text-violet-400 border-violet-500/30", nft: "text-pink-400 border-pink-500/30",
    gaming: "text-emerald-400 border-emerald-500/30", layer2: "text-blue-400 border-blue-500/30",
    dao: "text-amber-400 border-amber-500/30", exchange: "text-cyan-400 border-cyan-500/30",
    local_account: "text-violet-400 border-violet-500/30",
    "2fa": "text-amber-400 border-amber-500/30",
    wallet_address: "text-cyan-400 border-cyan-500/30",
    mail: "text-rose-400 border-rose-500/30",
  };

  const visible = filterForTab(entries, vaultTab);
  const currentTabInfo = VAULT_TABS.find(t => t.id === vaultTab)!;

  return (
    <div className="space-y-4 animate-fade-up">
      {/* Vault Tab Bar */}
      <div className="flex gap-1 bg-muted/30 rounded-lg p-1 overflow-x-auto">
        {VAULT_TABS.map(t => {
          const count = filterForTab(entries, t.id).length;
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setVaultTab(t.id)}
              className={cn("flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-mono font-bold transition-all whitespace-nowrap flex-shrink-0",
                vaultTab === t.id ? "bg-card text-primary shadow-sm border border-primary/20" : "text-muted-foreground hover:text-foreground")}>
              <Icon className="w-3 h-3" />
              {t.label}
              {count > 0 && <span className="text-[9px] bg-primary/10 text-primary rounded-full px-1.5 py-0.5">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Tab Header */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-primary" />
          Team {currentTabInfo.label}
          <span className="text-xs text-muted-foreground font-mono">({visible.length})</span>
        </p>
        {team.myRole === "leader" && (
          <Button size="sm" onClick={openCreate} className="h-8 text-xs gap-1">
            <Plus className="w-3.5 h-3.5" /> Add
          </Button>
        )}
      </div>

      {/* Entries */}
      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <KeyRound className="w-10 h-10 text-muted-foreground/20 mx-auto" />
          <p className="text-sm text-muted-foreground font-mono">No {currentTabInfo.label.toLowerCase()} entries yet</p>
          {team.myRole === "leader" && (
            <Button size="sm" variant="outline" onClick={openCreate} className="text-xs gap-1 mt-1">
              <Plus className="w-3.5 h-3.5" /> Add First Entry
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map((e, i) => (
            <div key={e.id} className="bg-card/60 border border-border/40 rounded-xl p-4 flex items-start gap-3 hover:border-primary/30 transition-colors animate-pop-in" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-xs flex-shrink-0">
                {(e.project_name || "?")[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold text-sm text-foreground">{e.project_name}</p>
                  {e.category && (
                    <Badge variant="outline" className={cn("text-[9px] capitalize", CAT_COLORS[e.category] ?? "")}>
                      {e.category.replace(/_/g, " ")}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-1 flex-wrap">
                  {e.twitter_username && <span className="text-[10px] text-muted-foreground font-mono">🐦 @{e.twitter_username}</span>}
                  {e.discord_username && <span className="text-[10px] text-muted-foreground font-mono">💬 {e.discord_username}</span>}
                  {e.email && <span className="text-[10px] text-muted-foreground font-mono">✉ {e.email}</span>}
                  {e.entity_serial && <span className="text-[10px] text-primary/60 font-mono">#{e.entity_serial}</span>}
                </div>
              </div>
              <div className="shrink-0">
                <div className="flex items-center gap-1">
                  <Avatar name={e.username || "?"} size="sm" />
                  <p className="text-[10px] text-muted-foreground font-mono">{e.username}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-4 h-4 text-primary" /> Add {currentTabInfo.label} Entry
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2 max-h-[60vh] overflow-y-auto">
            {vaultTab === "entity" && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground font-mono">Category</label>
                <select value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                  className="w-full h-9 text-sm bg-background/50 border border-border rounded-md px-2">
                  {["defi", "nft", "gaming", "layer2", "dao", "exchange"].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            )}
            {getFormFields().map(f => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs text-muted-foreground font-mono">{f.label}</label>
                <Input value={form[f.key] ?? ""} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.ph} className="h-9 text-sm bg-background/50" />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={createEntry} disabled={saving || !form.projectName.trim()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Add Entry
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Team Missions ────────────────────────────────────────────────────────────
function TeamMissions({ team }: { team: TeamDetail }) {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ title: "", description: "", target_value: "100", reward_amount: "0", deadline: "" });
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const loadMissions = () => {
    customFetch<Mission[]>(`/api/teams/${team.id}/missions`)
      .then(d => setMissions(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadMissions(); }, [team.id]);

  const createMission = async () => {
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await customFetch(`/api/teams/${team.id}/missions`, { method: "POST", body: JSON.stringify(form) });
      toast({ title: "Mission created!" });
      setCreateOpen(false);
      setForm({ title: "", description: "", target_value: "100", reward_amount: "0", deadline: "" });
      loadMissions();
    } catch { toast({ title: "Failed", variant: "destructive" }); } finally { setSaving(false); }
  };

  const updateProgress = async (mission: Mission, delta: number) => {
    const newVal = Math.min(mission.target_value, Math.max(0, mission.current_value + delta));
    try {
      await customFetch(`/api/teams/${team.id}/missions/${mission.id}`, { method: "PATCH", body: JSON.stringify({ current_value: newVal }) });
      setMissions(prev => prev.map(m => m.id === mission.id ? { ...m, current_value: newVal } : m));
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  const STATUS_COLOR: Record<string, string> = {
    active: "text-emerald-400 border-emerald-500/30",
    completed: "text-blue-400 border-blue-500/30",
    cancelled: "text-red-400 border-red-500/30",
  };

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2"><Swords className="w-3.5 h-3.5 text-primary" /> Missions ({missions.length})</p>
        {team.myRole === "leader" && (
          <Button size="sm" onClick={() => setCreateOpen(true)} className="h-8 text-xs gap-1"><Plus className="w-3.5 h-3.5" /> Create</Button>
        )}
      </div>
      {missions.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <Swords className="w-10 h-10 text-muted-foreground/20 mx-auto" />
          <p className="text-sm text-muted-foreground font-mono">No missions yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {missions.map((m, i) => {
            const pct = Math.round((m.current_value / m.target_value) * 100);
            return (
              <div key={m.id} className="bg-card/60 border border-border/40 rounded-xl p-4 space-y-3 animate-pop-in" style={{ animationDelay: `${i * 50}ms` }}>
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-sm text-foreground">{m.title}</p>
                      <Badge variant="outline" className={cn("text-[9px] capitalize", STATUS_COLOR[m.status] ?? "")}>{m.status}</Badge>
                    </div>
                    {m.description && <p className="text-xs text-muted-foreground font-mono mt-0.5">{m.description}</p>}
                  </div>
                  {m.reward_amount > 0 && (
                    <div className="flex items-center gap-1 text-amber-400 font-mono text-xs shrink-0">
                      <Zap className="w-3 h-3" />{m.reward_amount} AZN
                    </div>
                  )}
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs font-mono text-muted-foreground">
                    <span>{m.current_value} / {m.target_value}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                {team.myRole === "leader" && m.status === "active" && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateProgress(m, -10)}>-10</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateProgress(m, 10)}>+10</Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => updateProgress(m, 25)}>+25</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Swords className="w-4 h-4 text-primary" /> New Mission</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            {[
              { label: "Title", key: "title", ph: "e.g. Complete 50 tasks" },
              { label: "Description", key: "description", ph: "Optional details" },
              { label: "Target Value", key: "target_value", ph: "100" },
              { label: "Reward (AZN)", key: "reward_amount", ph: "0" },
              { label: "Deadline", key: "deadline", ph: "", type: "date" },
            ].map(f => (
              <div key={f.key} className="space-y-1">
                <label className="text-xs text-muted-foreground font-mono">{f.label}</label>
                <Input type={f.type ?? "text"} value={(form as any)[f.key]} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.ph} className="h-9 text-sm bg-background/50" />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={createMission} disabled={saving || !form.title.trim()}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Team Leaderboard ─────────────────────────────────────────────────────────
function TeamLeaderboard({ team }: { team: TeamDetail }) {
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    customFetch<LeaderboardEntry[]>(`/api/teams/${team.id}/leaderboard`)
      .then(d => setBoard(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  }, [team.id]);

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  const MEDAL_COLORS = ["text-yellow-400", "text-slate-300", "text-amber-600"];

  return (
    <div className="space-y-3 animate-fade-up">
      <p className="text-sm font-semibold text-foreground flex items-center gap-2"><Trophy className="w-3.5 h-3.5 text-primary" /> Leaderboard</p>
      {board.length === 0 ? (
        <div className="text-center py-12 font-mono text-muted-foreground text-sm">No data yet.</div>
      ) : (
        <div className="space-y-2">
          {board.map((e, i) => (
            <div key={e.user_id} className="flex items-center gap-3 p-3 bg-card/60 border border-border/40 rounded-xl animate-pop-in" style={{ animationDelay: `${i * 40}ms` }}>
              <div className={cn("w-7 h-7 rounded-full flex items-center justify-center font-bold font-mono text-sm flex-shrink-0", i < 3 ? MEDAL_COLORS[i] : "text-muted-foreground/60")}>
                {i < 3 ? <Medal className="w-4 h-4" /> : `#${e.rank}`}
              </div>
              <Avatar name={e.username || "?"} size="sm" role={e.role} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-foreground truncate">{e.username}</p>
                <div className="flex items-center gap-3 mt-0.5">
                  <span className="text-[10px] font-mono text-muted-foreground">{e.tasks_completed} tasks</span>
                  {e.streak > 0 && <span className="text-[10px] font-mono text-orange-400">{e.streak}d 🔥</span>}
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold font-mono text-amber-400">${e.total_roi.toFixed(2)}</p>
                <p className="text-[10px] text-muted-foreground font-mono">{e.azn_balance.toFixed(1)} AZN</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Team Projects ────────────────────────────────────────────────────────────
function TeamProjects({ team }: { team: TeamDetail }) {
  const [projects, setProjects] = useState<TeamProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [allProjects, setAllProjects] = useState<{ id: number; name: string }[]>([]);
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const [selProjectId, setSelProjectId] = useState<string>("");
  const [selVaultId, setSelVaultId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const loadProjects = () => {
    customFetch<TeamProject[]>(`/api/teams/${team.id}/projects`)
      .then(d => setProjects(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadProjects(); }, [team.id]);

  const openEnroll = async () => {
    setEnrollOpen(true);
    try {
      const [pRes, vRes] = await Promise.all([
        customFetch<any>("/api/projects?limit=50"),
        customFetch<VaultEntry[]>(`/api/teams/${team.id}/vault`),
      ]);
      setAllProjects(Array.isArray(pRes) ? pRes : (pRes?.projects ?? []));
      setVaultEntries(Array.isArray(vRes) ? vRes : []);
    } catch { /* ignore */ }
  };

  const enrollTeam = async () => {
    if (!selProjectId) return;
    setSaving(true);
    try {
      await customFetch(`/api/teams/${team.id}/enroll-project`, {
        method: "POST",
        body: JSON.stringify({ projectId: Number(selProjectId), vaultEntryId: selVaultId ? Number(selVaultId) : undefined }),
      });
      toast({ title: "Team enrolled in project!" });
      setEnrollOpen(false);
      setSelProjectId(""); setSelVaultId("");
      setLoading(true);
      loadProjects();
    } catch { toast({ title: "Failed to enroll team", variant: "destructive" }); } finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-3 animate-fade-up">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-foreground flex items-center gap-2"><FolderGit2 className="w-3.5 h-3.5 text-primary" /> Projects ({projects.length})</p>
        {team.myRole === "leader" && (
          <Button size="sm" onClick={openEnroll} className="h-8 text-xs gap-1"><Plus className="w-3.5 h-3.5" /> Enroll Team</Button>
        )}
      </div>
      {projects.length === 0 ? (
        <div className="text-center py-12 font-mono text-muted-foreground text-sm">No active projects.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {projects.map((p, i) => (
            <div key={p.id} className="bg-card/60 border border-border/40 rounded-xl p-4 animate-pop-in" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-xs">{p.name[0]}</div>
                <p className="font-semibold text-sm text-foreground flex-1 truncate">{p.name}</p>
              </div>
              <div className="flex gap-3 text-[10px] font-mono text-muted-foreground">
                <span>{p.task_count} tasks</span>
                <span>{p.participant_count} members</span>
                {p.category && <Badge variant="outline" className="text-[9px]">{p.category}</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><FolderGit2 className="w-4 h-4 text-primary" /> Enroll Team in Project</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground font-mono">Project</label>
              <select value={selProjectId} onChange={e => setSelProjectId(e.target.value)}
                className="w-full h-9 text-sm bg-background/50 border border-border rounded-md px-2">
                <option value="">Select a project…</option>
                {allProjects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground font-mono">Team Vault Entity (optional)</label>
              <select value={selVaultId} onChange={e => setSelVaultId(e.target.value)}
                className="w-full h-9 text-sm bg-background/50 border border-border rounded-md px-2">
                <option value="">None</option>
                {vaultEntries.map(v => <option key={v.id} value={v.id}>{v.project_name} (#{v.entity_serial})</option>)}
              </select>
            </div>
            <p className="text-[10px] text-muted-foreground font-mono">All active team members will be joined into this project.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEnrollOpen(false)}>Cancel</Button>
            <Button size="sm" onClick={enrollTeam} disabled={saving || !selProjectId}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Enroll Team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Team Mail (Phase 13B — AYZEN-provided team mailbox) ──────────────────────
// Same IMAP config + inbox-reading UX as personal Vault Mail, scoped to the
// team's shared mailbox(es) instead of one user's addresses. Leader manages
// which mailbox(es) are configured (ImapSmtpForm, same component vault-mail
// uses); every active member can open one and read/refresh it. Deliberately
// its own list — never merges with the per-entity Vault Mail hub at /vault.
function extractTeamVerificationCodes(text: string): string[] {
  return [...new Set(text.match(/\b\d{4,8}\b/g) ?? [])].slice(0, 6);
}

function TeamMailInbox({ team, account, onBack }: { team: TeamDetail; account: EmailAccount; onBack: () => void }) {
  const { token } = useAuth();
  const [messages, setMessages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [openMsg, setOpenMsg] = useState<any | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const { toast } = useToast();

  const loadStored = () => {
    setLoading(true);
    customFetch<{ messages: any[] }>(`/api/teams/${team.id}/email-accounts/${account.id}/stored-messages`)
      .then(d => setMessages(d?.messages ?? [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadStored(); }, [team.id, account.id]);

  const sync = async () => {
    setSyncing(true);
    try {
      await customFetch(`/api/teams/${team.id}/email-accounts/${account.id}/fetch-inbox`, { method: "POST", body: JSON.stringify({ limit: 30 }) });
      loadStored();
    } catch (err: any) {
      toast({ title: "Sync failed", description: err?.data?.detail ?? undefined, variant: "destructive" });
    } finally { setSyncing(false); }
  };

  const openMessage = async (m: any) => {
    setOpenMsg(m);
    setCodes([]);
    if (m.hasBody) return;
    setBodyLoading(true);
    try {
      const full = await customFetch<any>(`/api/teams/${team.id}/email-accounts/${account.id}/fetch-body`, {
        method: "POST", body: JSON.stringify({ seqno: m.seqno }),
      });
      setOpenMsg((prev: any) => prev && prev.id === m.id ? { ...prev, body: full.body } : prev);
      setCodes(extractTeamVerificationCodes(full.body ?? ""));
    } catch (err: any) {
      toast({ title: "Couldn't load message", variant: "destructive" });
    } finally { setBodyLoading(false); }
  };

  return (
    <div className="space-y-3 animate-fade-up">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-primary transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> {account.emailAddress}
        </button>
        <Button size="sm" variant="outline" onClick={sync} disabled={syncing} className="h-7 gap-1.5 text-xs">
          {syncing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Sync
        </Button>
      </div>
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : messages.length === 0 ? (
        <div className="text-center py-16 space-y-2">
          <Mail className="w-8 h-8 text-muted-foreground/20 mx-auto" />
          <p className="text-xs text-muted-foreground font-mono">No synced messages yet</p>
          <Button size="sm" variant="outline" onClick={sync} disabled={syncing} className="text-xs gap-1 mt-1">
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync Now
          </Button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {messages.map(m => (
            <button key={m.id} onClick={() => openMessage(m)}
              className="w-full text-left flex items-start gap-3 px-3 py-2.5 bg-card border border-card-border rounded-lg hover:border-primary/30 transition-colors">
              <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Mail className="w-3.5 h-3.5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-mono text-xs font-bold text-foreground truncate">{m.subject || "(no subject)"}</p>
                <p className="font-mono text-[10px] text-muted-foreground/50 truncate">{m.from}</p>
              </div>
              <span className="font-mono text-[9px] text-muted-foreground/40 flex-shrink-0">{m.date ? new Date(m.date).toLocaleDateString() : ""}</span>
            </button>
          ))}
        </div>
      )}

      <Dialog open={!!openMsg} onOpenChange={o => !o && setOpenMsg(null)}>
        <DialogContent className="sm:max-w-lg bg-card border-border max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle className="font-mono text-sm">{openMsg?.subject || "(no subject)"}</DialogTitle></DialogHeader>
          <p className="font-mono text-[10px] text-muted-foreground/50">{openMsg?.from}</p>
          {codes.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {codes.map(code => (
                <button key={code} onClick={() => navigator.clipboard.writeText(code)}
                  className="font-mono text-[10px] font-bold px-2 py-1 rounded bg-amber-400/10 text-amber-300 border border-amber-400/25 hover:bg-amber-400/20">
                  {code}
                </button>
              ))}
            </div>
          )}
          {bodyLoading ? (
            <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 animate-spin text-primary" /></div>
          ) : (
            <pre className="font-mono text-[11px] text-foreground/80 whitespace-pre-wrap break-words">{openMsg?.body ?? ""}</pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TeamMail({ team }: { team: TeamDetail }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<EmailAccount | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [newEmail, setNewEmail] = useState("");

  const loadAccounts = () => {
    setLoading(true);
    customFetch<EmailAccount[]>(`/api/teams/${team.id}/email-accounts`)
      .then(d => setAccounts(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadAccounts(); }, [team.id]);

  const removeAccount = async (id: number) => {
    try {
      await customFetch(`/api/teams/${team.id}/email-accounts/${id}`, { method: "DELETE" });
      toast({ title: "Mailbox removed" });
      loadAccounts();
    } catch { toast({ title: "Delete failed", variant: "destructive" }); }
  };

  if (selected) {
    return <TeamMailInbox team={team} account={selected} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Mail className="w-3.5 h-3.5 text-primary" /> Team Mailbox
            <span className="text-xs text-muted-foreground font-mono">({accounts.length})</span>
          </p>
          <p className="font-mono text-[10px] text-muted-foreground/50 mt-0.5">
            AYZEN-provided inbox{accounts.length !== 1 ? "es" : ""} shared with every active member — separate from personal Vault Mail.
          </p>
        </div>
        {team.myRole === "leader" && !adding && (
          <Button size="sm" onClick={() => { setAdding(true); setNewEmail(""); }} className="h-8 text-xs gap-1">
            <Plus className="w-3.5 h-3.5" /> Add Mailbox
          </Button>
        )}
      </div>

      {adding && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border/20 flex items-center justify-between">
            <span className="font-mono text-xs font-bold text-primary">New Team Mailbox</span>
            <button onClick={() => setAdding(false)} className="text-muted-foreground/40 hover:text-foreground"><X className="w-4 h-4" /></button>
          </div>
          <div className="p-4 space-y-2">
            <Label className="font-mono text-[9px] uppercase text-muted-foreground/50">Email Address</Label>
            <Input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="team@yourdomain.com" className="font-mono text-xs h-8 bg-input max-w-xs" />
            {(() => {
              const detected = newEmail.includes("@") ? detectProviderFromEmail(newEmail) : null;
              return detected ? <p className="font-mono text-[9px] text-emerald-400/80">Detected {detected.label} — IMAP/SMTP prefilled below</p> : null;
            })()}
          </div>
          {newEmail.includes("@") && (
            <ImapSmtpForm
              emailAddress={newEmail}
              existingAccount={null}
              token={token}
              apiBase={`/api/teams/${team.id}/email-accounts`}
              onSaved={() => { setAdding(false); loadAccounts(); }}
            />
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : accounts.length === 0 && !adding ? (
        <div className="text-center py-16 space-y-2">
          <Mail className="w-8 h-8 text-muted-foreground/20 mx-auto" />
          <p className="text-xs text-muted-foreground font-mono">No team mailbox configured yet</p>
          {team.myRole === "leader" ? (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)} className="text-xs gap-1 mt-1">
              <Plus className="w-3.5 h-3.5" /> Add Mailbox
            </Button>
          ) : (
            <p className="font-mono text-[10px] text-muted-foreground/30">Ask your team leader to set one up</p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {accounts.map(acct => (
            <div key={acct.id} className="rounded-xl border border-card-border bg-card overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3">
                <button onClick={() => setSelected(acct)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  <div className="w-8 h-8 rounded-lg bg-muted/20 border border-border/30 flex items-center justify-center flex-shrink-0">
                    <Mail className="w-4 h-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-mono text-xs font-bold truncate">{acct.emailAddress}</p>
                      {acct.imapHost && (
                        <span className="flex items-center gap-0.5 font-mono text-[8px] px-1 py-0.5 rounded bg-emerald-400/10 text-emerald-400 border border-emerald-400/20 flex-shrink-0">
                          <Wifi className="w-2 h-2" /> Connected
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[9px] text-muted-foreground/40">{acct.imapHost ? `${acct.provider ?? "custom"} · ${acct.imapHost}` : "Not configured"}</p>
                  </div>
                </button>
                {team.myRole === "leader" && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button onClick={() => setEditingId(editingId === acct.id ? null : acct.id)} title="Edit"
                      className={cn("p-1.5 rounded transition-colors", editingId === acct.id ? "text-primary bg-primary/10" : "text-muted-foreground/30 hover:text-primary")}>
                      <Settings className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => removeAccount(acct.id)} title="Delete" className="p-1.5 text-muted-foreground/30 hover:text-red-400 transition-colors rounded">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
              {editingId === acct.id && (
                <div className="border-t border-border/20 bg-muted/5">
                  <ImapSmtpForm
                    emailAddress={acct.emailAddress}
                    existingAccount={acct}
                    token={token}
                    apiBase={`/api/teams/${team.id}/email-accounts`}
                    onSaved={() => { setEditingId(null); loadAccounts(); }}
                    onDeleted={() => { setEditingId(null); loadAccounts(); }}
                    compact
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Team Tasks ─────────────────────────────────────────────────────────────
function TeamTasks({ team }: { team: TeamDetail }) {
  const [tasks, setTasks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [vaultEntries, setVaultEntries] = useState<VaultEntry[]>([]);
  const [enrollTask, setEnrollTask] = useState<any | null>(null);
  const [selVaultId, setSelVaultId] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const loadTasks = () => {
    setLoading(true);
    customFetch<TeamProject[]>(`/api/teams/${team.id}/projects`)
      .then(async (projects) => {
        const list = Array.isArray(projects) ? projects : [];
        const results = await Promise.all(list.map(p =>
          customFetch<any[]>(`/api/tasks?projectId=${p.id}`).then(d => (Array.isArray(d) ? d : []).map(t => ({ ...t, project_name: p.name }))).catch(() => [])
        ));
        setTasks(results.flat());
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => { loadTasks(); }, [team.id]);

  const openEnroll = async (task: any) => {
    setEnrollTask(task);
    setSelVaultId("");
    try {
      const v = await customFetch<VaultEntry[]>(`/api/teams/${team.id}/vault`);
      setVaultEntries(Array.isArray(v) ? v : []);
    } catch { /* ignore */ }
  };

  const enrollTeamInTask = async () => {
    if (!enrollTask) return;
    setSaving(true);
    try {
      await customFetch(`/api/teams/${team.id}/tasks/${enrollTask.id}/enroll`, {
        method: "POST",
        body: JSON.stringify({ vaultEntryId: selVaultId ? Number(selVaultId) : undefined }),
      });
      toast({ title: "Team enrolled in task!" });
      setEnrollTask(null);
    } catch { toast({ title: "Failed to enroll team", variant: "destructive" }); } finally { setSaving(false); }
  };

  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>;

  return (
    <div className="space-y-3 animate-fade-up">
      <p className="text-sm font-semibold text-foreground flex items-center gap-2"><ListTodo className="w-3.5 h-3.5 text-primary" /> Team Tasks ({tasks.length})</p>
      {tasks.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <ListTodo className="w-10 h-10 text-muted-foreground/20 mx-auto" />
          <p className="text-sm text-muted-foreground font-mono">No tasks yet — enroll the team in a project first.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((t, i) => (
            <div key={t.id} className="bg-card/60 border border-border/40 rounded-xl p-4 flex items-center gap-3 animate-pop-in" style={{ animationDelay: `${i * 30}ms` }}>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-foreground truncate">{t.name}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-[10px] text-muted-foreground font-mono">{t.project_name}</span>
                  <Badge variant="outline" className="text-[9px]">{t.verificationType || t.verification_type}</Badge>
                </div>
              </div>
              {team.myRole === "leader" && (
                <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => openEnroll(t)}>
                  Enroll Team
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <Dialog open={!!enrollTask} onOpenChange={(o) => !o && setEnrollTask(null)}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><ListTodo className="w-4 h-4 text-primary" /> Enroll Team in Task</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-foreground font-semibold">{enrollTask?.name}</p>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground font-mono">Team Vault Entity (optional)</label>
              <select value={selVaultId} onChange={e => setSelVaultId(e.target.value)}
                className="w-full h-9 text-sm bg-background/50 border border-border rounded-md px-2">
                <option value="">None</option>
                {vaultEntries.map(v => <option key={v.id} value={v.id}>{v.project_name} (#{v.entity_serial})</option>)}
              </select>
            </div>
            <p className="text-[10px] text-muted-foreground font-mono">Each active team member will get a pending submission to complete.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEnrollTask(null)}>Cancel</Button>
            <Button size="sm" onClick={enrollTeamInTask} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Enroll Team
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Team Chat ────────────────────────────────────────────────────────────────
function TeamChat({ team, currentUserId }: { team: TeamDetail; currentUserId: number }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const loadMessages = () => {
    customFetch<Message[]>(`/api/teams/${team.id}/messages`)
      .then(d => setMessages(Array.isArray(d) ? d : [])).catch(() => {}).finally(() => setLoading(false));
  };
  useEffect(() => { loadMessages(); }, [team.id]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    try {
      const msg = await customFetch<Message>(`/api/teams/${team.id}/messages`, { method: "POST", body: JSON.stringify({ message: text }) });
      setMessages(prev => [...prev, msg]);
    } catch { toast({ title: "Failed to send", variant: "destructive" }); setSending(false); }
    setSending(false);
  };

  return (
    <div className="flex flex-col h-[500px] bg-card/40 border border-border/40 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 flex items-center gap-2">
        <MessageCircle className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold font-mono">Team Chat</span>
        <button onClick={loadMessages} className="ml-auto text-muted-foreground hover:text-primary transition-colors"><RefreshCw className="w-3.5 h-3.5" /></button>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground font-mono text-sm">No messages yet. Say hi!</div>
        ) : (
          messages.map((m, i) => {
            const isMine = m.user_id === currentUserId;
            return (
              <div key={m.id} className={cn("flex gap-2 animate-fade-up", isMine ? "flex-row-reverse" : "flex-row")} style={{ animationDelay: `${Math.min(i * 20, 400)}ms` }}>
                <div className="w-6 h-6 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-bold font-mono text-[9px] text-primary flex-shrink-0 mt-0.5">
                  {(m.username || "?"[0]).charAt(0).toUpperCase()}
                </div>
                <div className={cn("max-w-[75%] space-y-0.5", isMine ? "items-end" : "items-start")}>
                  {!isMine && <p className="text-[9px] font-mono text-muted-foreground/60 px-1">{m.username}</p>}
                  <div className={cn("px-3 py-2 rounded-2xl text-sm font-mono", isMine ? "bg-primary/20 text-foreground rounded-tr-sm border border-primary/20" : "bg-muted/60 text-foreground rounded-tl-sm border border-border")}>
                    {m.message}
                  </div>
                  <p className="text-[8px] font-mono text-muted-foreground/40 px-1">{new Date(m.created_at).toLocaleTimeString()}</p>
                </div>
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
      <div className="px-3 py-3 border-t border-border/40 flex gap-2">
        <Input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
          placeholder="Type a message…" disabled={sending} className="flex-1 h-9 text-sm bg-background/50 font-mono" />
        <Button size="sm" onClick={sendMessage} disabled={sending || !input.trim()} className="h-9 w-9 p-0">
          {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

// ─── Team Panel (Leader only) ─────────────────────────────────────────────────
function TeamPanel({ team, onRefresh, onDelete }: { team: TeamDetail; onRefresh: () => void; onDelete: () => void }) {
  const [newName, setNewName] = useState(team.name);
  const [newDesc, setNewDesc] = useState(team.description || "");
  const [inviteEmail, setInviteEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const { toast } = useToast();

  const saveTeam = async () => {
    setSaving(true);
    try {
      await customFetch(`/api/teams/${team.id}`, { method: "PATCH", body: JSON.stringify({ name: newName, description: newDesc }) });
      toast({ title: "Team updated!" }); onRefresh();
    } catch { toast({ title: "Failed", variant: "destructive" }); } finally { setSaving(false); }
  };

  const inviteMember = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      await customFetch(`/api/teams/${team.id}/invite`, { method: "POST", body: JSON.stringify({ username: inviteEmail.trim() }) });
      toast({ title: "Invite sent!" }); setInviteEmail(""); onRefresh();
    } catch { toast({ title: "Failed to invite", variant: "destructive" }); } finally { setInviting(false); }
  };

  const deleteTeam = async () => {
    if (!confirm("Disband this team? This cannot be undone.")) return;
    try {
      await customFetch(`/api/teams/${team.id}`, { method: "DELETE" });
      toast({ title: "Team disbanded" }); onDelete();
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="bg-card/60 border border-border/40 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Settings className="w-3.5 h-3.5 text-primary" /> Team Info</h3>
        <div className="space-y-2">
          <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Team name" className="h-9 text-sm bg-background/50" />
          <Input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Description (optional)" className="h-9 text-sm bg-background/50" />
          <Button size="sm" onClick={saveTeam} disabled={saving} className="h-9 w-full">{saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Save Changes</Button>
        </div>
      </div>
      <div className="bg-card/60 border border-border/40 rounded-xl p-4 space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><UserPlus className="w-3.5 h-3.5 text-primary" /> Invite Member</h3>
        <p className="text-xs text-muted-foreground font-mono">Invites are pending until the user accepts.</p>
        <div className="flex gap-2">
          <Input value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} placeholder="Username or email"
            onKeyDown={e => e.key === "Enter" && inviteMember()} className="h-9 text-sm bg-background/50 flex-1" />
          <Button size="sm" onClick={inviteMember} disabled={inviting} className="h-9">
            {inviting ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
          </Button>
        </div>
      </div>
      <div className="bg-card/60 border border-border/40 rounded-xl p-4 space-y-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Users className="w-3.5 h-3.5 text-primary" /> Members ({team.members.filter(m => m.status === "active").length})</h3>
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {team.members.map(m => (
            <div key={m.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-muted/20">
              <Avatar name={m.username || m.email || "?"} size="sm" role={m.role} />
              <span className="text-xs text-foreground flex-1 truncate font-mono">{m.username || m.email}</span>
              <Badge variant="outline" className={cn("text-[9px] capitalize", m.status === "pending" ? "border-amber-500/30 text-amber-400" : m.role === "leader" ? "border-yellow-500/30 text-yellow-400" : "")}>
                {m.status === "pending" ? "pending" : m.role}
              </Badge>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-card/60 border border-red-500/20 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-red-400 mb-2 flex items-center gap-2"><Shield className="w-3.5 h-3.5" /> Danger Zone</h3>
        <p className="text-xs text-muted-foreground font-mono mb-3">Disbanding removes all members and messages permanently.</p>
        <Button variant="destructive" size="sm" onClick={deleteTeam} className="h-8 text-xs">Disband Team</Button>
      </div>
    </div>
  );
}

// ─── Team Browse ─────────────────────────────────────────────────────────────
type PublicTeam = { id: number; name: string; description?: string; member_count: number; owner_username?: string; slug?: string };
function TeamBrowse({ onJoin }: { onJoin: () => void }) {
  const [teams, setTeams] = useState<PublicTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [requested, setRequested] = useState<Set<number>>(new Set());
  const [joining, setJoining] = useState<number | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    customFetch<PublicTeam[]>("/api/teams/browse").then(d => {
      setTeams(Array.isArray(d) ? d : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Phase 12A — search by team name/@handle (teams.slug already exists on the
  // backend; /api/teams/browse already returns it), not just name/description.
  const filtered = teams.filter(t => {
    if (!query) return true;
    const q = query.toLowerCase().replace(/^@/, "");
    return t.name.toLowerCase().includes(q) || t.slug?.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q);
  });

  const requestJoin = async (teamId: number) => {
    setJoining(teamId);
    try {
      await customFetch(`/api/teams/${teamId}/join-request`, { method: "POST" });
      setRequested(prev => new Set(prev).add(teamId));
      toast({ title: "Join request sent", description: "The team leader needs to approve it." });
      onJoin();
    } catch (err: any) {
      if (err?.status === 409) {
        setRequested(prev => new Set(prev).add(teamId));
        toast({ title: "Already requested", description: "You're already a member or have a pending request." });
      } else {
        toast({ title: "Couldn't send join request", variant: "destructive" });
      }
    }
    setJoining(null);
  };

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search by name or @handle…" className="w-full h-9 pl-9 pr-3 rounded-lg border border-border bg-background/50 text-sm font-mono focus:outline-none focus:border-primary/60" />
        </div>
        <button onClick={() => customFetch<PublicTeam[]>("/api/teams/browse").then(d => { setTeams(Array.isArray(d) ? d : []); }).catch(() => {})} className="p-2 rounded-lg border border-border hover:border-primary/40 text-muted-foreground hover:text-primary transition-colors">
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground font-mono text-sm">No public teams found</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((t, i) => (
            <div key={t.id} className="flex items-center gap-4 p-4 bg-card/60 border border-border/40 rounded-xl animate-pop-in" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-base flex-shrink-0">
                {t.name[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-mono font-bold text-sm text-foreground">{t.name}</p>
                  {t.slug && <span className="text-[10px] font-mono text-muted-foreground/50">@{t.slug}</span>}
                </div>
                {t.description && <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">{t.description}</p>}
                <div className="flex items-center gap-3 mt-1">
                  <span className="text-[10px] font-mono text-muted-foreground/60 flex items-center gap-1"><Users className="w-3 h-3" /> {t.member_count} members</span>
                  {t.owner_username && <span className="text-[10px] font-mono text-muted-foreground/60 flex items-center gap-1"><Crown className="w-3 h-3" /> {t.owner_username}</span>}
                </div>
              </div>
              <Button
                size="sm"
                variant={requested.has(t.id) ? "outline" : "default"}
                disabled={requested.has(t.id) || joining === t.id}
                onClick={() => requestJoin(t.id)}
                className="h-8 flex-shrink-0 gap-1.5"
              >
                {joining === t.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : requested.has(t.id) ? <Check className="w-3.5 h-3.5" /> : <UserPlus className="w-3.5 h-3.5" />}
                {requested.has(t.id) ? "Requested" : "Join"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Phase 12A — factored out so the classic no-team list and the new nav's
// non-member Overview can share one create-team dialog instead of two copies.
function CreateTeamDialog({ open, onOpenChange, name, setName, desc, setDesc, creating, onSubmit }: {
  open: boolean; onOpenChange: (v: boolean) => void;
  name: string; setName: (v: string) => void;
  desc: string; setDesc: (v: string) => void;
  creating: boolean; onSubmit: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-card border-border">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><Users className="w-4 h-4 text-primary" /> Request a Team</DialogTitle></DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground font-mono">Your request will be reviewed by an admin. Once approved, you can invite members.</p>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-mono">Team Name</label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Alpha Squad" className="h-9 text-sm bg-background/50" autoFocus />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-mono">Description (optional)</label>
            <Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="What will your team focus on?" className="h-9 text-sm bg-background/50" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} disabled={creating || !name.trim()}>
            {creating ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Submit Request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Team Invite Link ─────────────────────────────────────────────────────────
function TeamInviteLink({ team }: { team: TeamDetail }) {
  const [link, setLink] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const generateLink = async () => {
    setLoading(true);
    try {
      const data = await customFetch<{ invite_link: string; code: string }>(`/api/teams/${team.id}/invite-link`, { method: "POST" });
      setLink(data.invite_link);
    } catch { toast({ title: "Failed to generate link", variant: "destructive" }); }
    setLoading(false);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(link).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => { generateLink(); }, [team.id]);

  return (
    <div className="space-y-4 animate-fade-up max-w-lg">
      <div className="bg-card/60 border border-border/40 rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><Link2 className="w-3.5 h-3.5 text-primary" /> Deep Invite Link</h3>
        <p className="text-xs text-muted-foreground font-mono">Share this link to invite someone directly to <strong>{team.name}</strong>. Anyone with the link can request to join.</p>
        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : link ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border font-mono text-[11px] text-muted-foreground break-all">
              <Globe className="w-3.5 h-3.5 flex-shrink-0 text-primary" />
              <span className="flex-1 min-w-0 break-all">{link}</span>
            </div>
            <Button size="sm" className="w-full h-9 gap-2 font-mono text-xs" onClick={copyLink} variant={copied ? "outline" : "default"}>
              {copied ? <><Check className="w-4 h-4 text-emerald-400" /> Copied!</> : <><Copy className="w-4 h-4" /> Copy Link</>}
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={generateLink} disabled={loading} className="w-full h-9 font-mono text-xs gap-2">
            <Link2 className="w-4 h-4" /> Generate Invite Link
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={generateLink} disabled={loading} className="w-full h-9 font-mono text-xs gap-2">
          <RefreshCw className="w-3.5 h-3.5" /> Regenerate Link
        </Button>
      </div>
      {/* Team username / slug */}
      <div className="bg-card/60 border border-border/40 rounded-xl p-5 space-y-3">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><AtSign className="w-3.5 h-3.5 text-primary" /> Team Username</h3>
        <p className="text-xs text-muted-foreground font-mono">Your team's public @handle for discovery in Browse Teams.</p>
        <div className="flex items-center gap-1.5 p-2.5 rounded-lg bg-muted/30 border border-border font-mono text-sm">
          <AtSign className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-foreground">{(team as any).slug ?? team.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Teams Page ──────────────────────────────────────────────────────────
export default function TeamsPage() {
  const { user } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<TeamDetail | null>(null);
  const search = useSearch();
  const [, navigate] = useLocation();
  const VALID_TABS: Tab[] = ["dashboard", "members", "vault", "missions", "tasks", "leaderboard", "projects", "chat", "panel", "browse", "invite"];
  const urlTab = new URLSearchParams(search).get("tab") as Tab | null;
  const [tab, setTabState] = useState<Tab>(urlTab && VALID_TABS.includes(urlTab) ? urlTab : "dashboard");
  const setTab = (t: Tab) => {
    setTabState(t);
    navigate(t === "dashboard" ? "/teams" : `/teams?tab=${t}`, { replace: true });
  };
  useEffect(() => {
    if (urlTab && VALID_TABS.includes(urlTab) && urlTab !== tab) setTabState(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  // Phase 11A/11B — hierarchical sidebar. `tab` (declared above) doubles as
  // the active leaf inside a section — no second piece of state duplicating
  // which old-tab content is showing.
  // Phase 16C: the ?nav=new gate is gone, this is the only render path now.
  // Section defaults to whatever `tab` belongs to (via TAB_TO_SECTION) so a
  // legacy `?tab=` deep link with no `?section=` still opens the right
  // section instead of silently falling back to Overview.
  const searchParams = new URLSearchParams(search);
  const urlSection = searchParams.get("section") as Section | null;
  const initialSection = (): Section => {
    if (urlSection && SECTION_META.some(s => s.id === urlSection)) return urlSection;
    const mapped = urlTab ? TAB_TO_SECTION[urlTab] : undefined;
    return mapped ?? "overview";
  };
  const [section, setSectionState] = useState<Section>(initialSection);
  useEffect(() => {
    if (urlSection && SECTION_META.some(s => s.id === urlSection) && urlSection !== section) setSectionState(urlSection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlSection]);
  // Navigate within the sidebar: pick a section, and either the requested
  // sub-tab (if it belongs to that section) or that section's first sub-tab.
  const goToNewNav = (s: Section, t?: Tab) => {
    const subtabs = SECTION_SUBTABS[s].filter(st => !st.leaderOnly || selectedTeam?.myRole === "leader");
    const nextTab = t && TAB_TO_SECTION[t] === s ? t : subtabs[0]?.id ?? "dashboard";
    setSectionState(s);
    setTabState(nextTab);
    navigate(`/teams?section=${s}&tab=${nextTab}`, { replace: true });
  };
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamDesc, setTeamDesc] = useState("");
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();

  const loadTeams = async () => {
    try {
      const data = await customFetch<Team[]>("/api/teams");
      setTeams(Array.isArray(data) ? data : []);
    } catch { setTeams([]); } finally { setLoading(false); }
  };

  const loadTeamDetail = async (id: number) => {
    try {
      const data = await customFetch<TeamDetail>(`/api/teams/${id}`);
      setSelectedTeam(data);
    } catch { toast({ title: "Failed to load team", variant: "destructive" }); }
  };

  useEffect(() => { loadTeams(); }, []);

  const createTeam = async () => {
    if (!teamName.trim()) return;
    setCreating(true);
    try {
      await customFetch("/api/teams", { method: "POST", body: JSON.stringify({ name: teamName.trim(), description: teamDesc.trim() }) });
      toast({ title: "Team request submitted!", description: "Awaiting admin approval." });
      setCreateOpen(false); setTeamName(""); setTeamDesc("");
      await loadTeams();
    } catch { toast({ title: "Failed to create team", variant: "destructive" }); } finally { setCreating(false); }
  };

  // ── Phase 12B — new nav, member-state Overview: Leave + Leaderboard ────────
  // `leaderboard` has no section/sub-view of its own (Phase 12B), so a legacy
  // `?tab=leaderboard` deep link opens straight into this dialog instead of
  // silently landing on the Overview section with nothing shown.
  const [leaderboardOpen, setLeaderboardOpen] = useState(urlTab === "leaderboard");
  const [leaving, setLeaving] = useState(false);
  const leaveTeam = async () => {
    if (!selectedTeam) return;
    setLeaving(true);
    try {
      await customFetch(`/api/teams/${selectedTeam.id}/leave`, { method: "POST" });
      toast({ title: "Left team" });
      setSelectedTeam(null);
      await loadTeams();
    } catch (err: any) {
      toast({ title: "Couldn't leave team", description: err?.data?.error ?? undefined, variant: "destructive" });
    } finally { setLeaving(false); }
  };

  // ── Browse tab works without a team selection ─────────────────────────────
  if (tab === "browse") {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Globe className="w-5 h-5 text-primary" /> Browse Teams</h1>
            <p className="text-sm text-muted-foreground mt-0.5 font-mono">Discover active teams and request to join.</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => setTab("dashboard")} className="h-9 gap-2"><Users className="w-4 h-4" /> My Teams</Button>
        </div>
        <TeamBrowse onJoin={loadTeams} />
      </div>
    );
  }

  // ── No team selected ───────────────────────────────────────────────────────
  // Phase 12A/16C: a member with existing teams sees their team list (pick one
  // to enter its sidebar); a non-member sees TeamBrowse (search/join/create)
  // inline instead of an empty state, so there's always a working next step.
  if (!selectedTeam) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Users className="w-5 h-5 text-primary" /> Teams</h1>
            <p className="text-sm text-muted-foreground mt-0.5 font-mono">Collaborate — shared vault, missions, projects & chat.</p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)} className="h-9 gap-2"><Plus className="w-4 h-4" /> Request Team</Button>
        </div>

        <PendingInvitesBanner onAccepted={loadTeams} />

        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : teams.length === 0 ? (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground font-mono">Not in a team yet — search by name or @handle, request to join, or start your own.</p>
            <TeamBrowse onJoin={loadTeams} />
          </div>
        ) : (
          <div className="space-y-2">
            {teams.map((t, i) => (
              <button key={t.id} onClick={async () => { await loadTeamDetail(t.id); setTab("dashboard"); }}
                disabled={t.status === "pending"}
                className={cn("w-full flex items-center gap-4 p-4 bg-card/60 border border-border/40 rounded-xl text-left group transition-all animate-pop-in",
                  t.status !== "pending" ? "hover:border-primary/30 hover:bg-primary/5" : "opacity-60 cursor-default"
                )}
                style={{ animationDelay: `${i * 60}ms` }}>
                <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-base">
                  {t.name[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-semibold text-foreground">{t.name}</div>
                    {t.status === "pending" && <Badge variant="outline" className="text-[9px] border-amber-500/30 text-amber-400 gap-1"><Clock className="w-2.5 h-2.5" /> Pending</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 font-mono">
                    <Users className="w-3 h-3" />{t.member_count} members
                    <Badge variant="outline" className={cn("text-[9px] capitalize ml-1", t.member_role === "leader" ? "border-yellow-500/30 text-yellow-400" : "")}>{t.member_role}</Badge>
                  </div>
                </div>
                {t.status !== "pending" && <ChevronRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-primary/60 transition-colors" />}
              </button>
            ))}
          </div>
        )}

        <CreateTeamDialog open={createOpen} onOpenChange={setCreateOpen} name={teamName} setName={setTeamName} desc={teamDesc} setDesc={setTeamDesc} creating={creating} onSubmit={createTeam} />
      </div>
    );
  }

  // ── Team selected — sidebar layout ────────────────────────────────────────
  // Phase 11A-15B built out the hierarchical sidebar section by section:
  // Overview (12A/12B), App's Vault/Project (13A, pure relocation), App's
  // Mail (13B, new TeamMail sub-view backed by /teams/:id/email-accounts),
  // Task's Task sub-view (14A, pure relocation of the `tasks` tab — TeamTasks
  // is reused unchanged; Task's Mission sub-view was already nested here as
  // part of 11B's temporary mapping, so Task section was fully finalized as
  // of 14A). Other's Members+Invite (15A): Invite reuses TeamInviteLink
  // unchanged (11B's mapping already covered it); Members surfaces
  // per-member progress (tasks completed, mission contribution,
  // vault-activity count) via GET /teams/:id/member-progress, computed at
  // read time from task_submissions, the shared Phase 4 activity_log
  // (subject_type="team"), and vault_activity_log — nothing stored/duplicated.
  // Other's Activity Log (15B): TeamActivity sub-view reads
  // GET /teams/:id/activity, which sources its feed from the same
  // activity_log table (subject_type="team"). logVaultActivity
  // (routes/vault.ts) mirrors a "vault_used" row into activity_log whenever a
  // team-owned vault entry is touched, so vault-usage events show up here
  // attributed and timestamped.
  // Phase 16C removed the old flat-tab render branch and its ?nav=new gate —
  // this sidebar is now the only codepath; old tabs stay nested into their
  // SECTION_SUBTABS section exactly as before.
  // `tab` is now the single source of truth for which leaf view is shown —
  // the sidebar/mobile nav above set it directly, so no more falling back to
  // a section's first sub-tab just to keep a pill row in sync.
  const activeTab: Tab = tab;

  return (
    <div className="flex -m-4 md:-m-6 lg:-m-8 min-h-[calc(100vh-50px)]">
      {/* ── Left sub-sidebar (desktop only) ── */}
      <div className="hidden md:flex w-52 flex-shrink-0 border-r border-border/40 bg-sidebar/50 flex-col animate-slide-in-left">
        <div className="p-3 border-b border-border/40">
          <button onClick={() => setSelectedTeam(null)} className="flex items-center gap-1.5 text-xs font-mono text-muted-foreground hover:text-primary transition-colors mb-3">
            <ArrowLeft className="w-3.5 h-3.5" /> All Teams
          </button>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-base flex-shrink-0">
              {selectedTeam.name[0].toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="font-bold font-mono text-sm text-foreground truncate">{selectedTeam.name}</p>
              <Badge variant="outline" className={cn("text-[9px] capitalize mt-0.5",
                selectedTeam.status === "pending" ? "border-amber-500/30 text-amber-400" : selectedTeam.myRole === "leader" ? "border-yellow-500/30 text-yellow-400" : "")}>
                {selectedTeam.status === "pending" ? "pending" : selectedTeam.myRole}
              </Badge>
            </div>
          </div>
        </div>

        <nav className="flex-1 px-2 py-2 space-y-3 overflow-y-auto">
          {SECTION_META.map(s => {
            const subtabs = SECTION_SUBTABS[s.id].filter(st => !st.leaderOnly || selectedTeam.myRole === "leader");
            const SectionIcon = s.icon;
            return (
              <div key={s.id} className="space-y-0.5">
                <p className="px-3 pb-1 flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-widest text-muted-foreground/40">
                  <SectionIcon className="w-3 h-3" /> {s.label}
                </p>
                {subtabs.map(st => {
                  const Icon = st.icon;
                  const active = tab === st.id;
                  return (
                    <button key={st.id} onClick={() => goToNewNav(s.id, st.id)}
                      className={cn("w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-mono transition-all text-left",
                        active ? "bg-primary/10 text-primary border border-primary/20" : "text-muted-foreground/60 hover:bg-muted/30 hover:text-foreground border border-transparent")}>
                      <Icon className="w-4 h-4 flex-shrink-0" />
                      {st.label}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>
      </div>

      {/* ── Main content area ── */}
      <div className="flex-1 overflow-y-auto flex flex-col min-w-0">
        {/* Mobile top bar */}
        <div className="md:hidden flex items-center gap-2 px-3 py-2.5 border-b border-border/40 bg-sidebar/50 sticky top-0 z-10 flex-shrink-0">
          <button onClick={() => setSelectedTeam(null)} className="p-1.5 rounded-md hover:bg-muted/30 text-muted-foreground hover:text-primary flex-shrink-0">
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary font-bold font-mono text-xs flex-shrink-0">
              {selectedTeam.name[0].toUpperCase()}
            </div>
            <span className="font-mono font-bold text-sm text-foreground truncate">{selectedTeam.name}</span>
          </div>
        </div>

        {/* Mobile nav — flattened leaf list (same hierarchy as the desktop
            sidebar, just collapsed to one scrollable row since there's no
            room for a two-level split on small screens). */}
        <div className="md:hidden flex gap-1.5 overflow-x-auto border-b border-border/40 bg-background/50 sticky top-[52px] z-10 flex-shrink-0 scrollbar-hide px-2 py-2">
          {SECTION_META.flatMap(s =>
            SECTION_SUBTABS[s.id]
              .filter(st => !st.leaderOnly || selectedTeam.myRole === "leader")
              .map(st => ({ ...st, sectionId: s.id }))
          ).map(st => {
            const Icon = st.icon;
            const active = tab === st.id;
            return (
              <button key={st.id} onClick={() => goToNewNav(st.sectionId, st.id)}
                className={cn("flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg font-mono text-[10px] uppercase tracking-wider border flex-shrink-0 transition-all",
                  active
                    ? "bg-primary/10 text-primary border-primary/30 font-bold"
                    : "text-muted-foreground/60 border-border/20 hover:bg-muted/20 hover:text-foreground bg-card")}>
                <Icon className="w-3.5 h-3.5" />
                {st.label}
              </button>
            );
          })}
        </div>

        {/* Content — leaf view driven directly by `tab` (Phase 11B/18A).
            The old in-content pill row (nested sub-tabs) is gone: the
            hierarchy now lives entirely in the sidebar/mobile nav above. */}
        <div className="flex-1 p-4 md:p-6 space-y-4">
          {/* Phase 12B — Overview replaces itself with the scoped team
              dashboard once the user has membership; Leave/Leaderboard
              surfaced here (top corner) instead of as their own top-level
              tab, reusing TeamDashboard/TeamLeaderboard unchanged. */}
          {activeTab === "dashboard" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><LayoutDashboard className="w-5 h-5 text-primary" /> Overview</h1>
                  <p className="text-sm text-muted-foreground mt-0.5 font-mono">{selectedTeam.name}'s dashboard.</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Button size="sm" variant="outline" onClick={() => setLeaderboardOpen(true)} className="h-8 gap-1.5 text-xs">
                    <Trophy className="w-3.5 h-3.5" /> Leaderboard
                  </Button>
                  <Button size="sm" variant="outline" onClick={leaveTeam} disabled={leaving}
                    className="h-8 gap-1.5 text-xs text-muted-foreground hover:text-red-400 hover:border-red-500/30">
                    {leaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />} Leave
                  </Button>
                </div>
              </div>
              <TeamDashboard team={selectedTeam} />
              <Dialog open={leaderboardOpen} onOpenChange={setLeaderboardOpen}>
                <DialogContent className="sm:max-w-lg bg-card border-border max-h-[80vh] overflow-y-auto">
                  <DialogHeader><DialogTitle className="flex items-center gap-2"><Trophy className="w-4 h-4 text-primary" /> {selectedTeam.name} Leaderboard</DialogTitle></DialogHeader>
                  <TeamLeaderboard team={selectedTeam} />
                </DialogContent>
              </Dialog>
            </div>
          )}
          {activeTab === "members"   && <TeamMembers team={selectedTeam} onRefresh={() => loadTeamDetail(selectedTeam.id)} />}
          {activeTab === "activity"  && <TeamActivity team={selectedTeam} />}
          {activeTab === "chat"      && <TeamChat team={selectedTeam} currentUserId={user?.id ?? 0} />}
          {activeTab === "vault"     && <TeamVault team={selectedTeam} />}
          {activeTab === "tasks"     && <TeamTasks team={selectedTeam} />}
          {activeTab === "missions"  && <TeamMissions team={selectedTeam} />}
          {activeTab === "projects"  && <TeamProjects team={selectedTeam} />}
          {activeTab === "mail"      && <TeamMail team={selectedTeam} />}
          {activeTab === "invite"    && selectedTeam.myRole === "leader" && <TeamInviteLink team={selectedTeam} />}
          {activeTab === "panel"     && selectedTeam.myRole === "leader" && (
            <TeamPanel team={selectedTeam} onRefresh={() => loadTeamDetail(selectedTeam.id)} onDelete={() => { setSelectedTeam(null); loadTeams(); }} />
          )}
        </div>
      </div>
    </div>
  );

}
