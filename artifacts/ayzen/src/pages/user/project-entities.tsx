// Phase 3 — Project ↔ Entity Enrollment Bridge
//
// This page is the new top-level "Project" sidebar item (separate from the
// Protocols/Projects browsing sidebar and from Vault's own Account>Entity
// list — see app-sidebar.tsx). It lists projects the user has enrolled
// entities into, and for each project shows the enrolled entities along
// with the Main/Info/Recovery account snapshot captured *at enroll time*
// (project_enrollments.account_data) — independent of the entity's own
// vault_entries row, since the same entity can run a different account
// per project.
import { useState, useEffect, useCallback } from "react";
import { useSearch, useLocation } from "wouter";
import { useListVaultEntries } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  ClipboardList, FolderGit2, Plus, Search, Loader2, ArrowLeft, Users,
  Eye, EyeOff, Trash2, ListChecks, ClipboardPaste, Shield,
  History, ChevronDown, ChevronUp, Gift, LogIn, LogOut, Ban, XCircle,
  ShieldAlert, RotateCcw, MoreVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { SchemaForm } from "@/components/schema/SchemaForm";
import { ENTITY_FIELDS, ACCOUNT_SUBTABS } from "@/config/fields/entity-create";
import { DataEntityPicker } from "@/components/vault/data-entity-picker";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

// Same field set Phase 1 grouped into Account · Main/Info/Recovery — Wallet
// is excluded here on purpose, wallet data stays entity-level and is set on
// the entity itself (pages/user/vault.tsx's Wallet tab), not per-enrollment.
const ENROLL_EMPTY_FORM: Record<string, string> = {
  username: "", accountPassword: "",
  email: "", emailPassword: "", email2fa: "", emailBackupCode: "", notes: "",
  lastLoginAt: "", buyDate: "", createDate: "",
  currentBuyValue: "", currentValue: "", followers: "",
  emailRecovery: "", emailRecoveryPassword: "", recovery2fa: "", recoveryBackupCode: "",
};

interface EnrolledProjectSummary {
  projectId: number;
  projectName: string;
  thumbnailUrl?: string | null;
  category?: string | null;
  enrolledCount: number;
}

interface Enrollment {
  id: number;
  vaultEntryId: number;
  status: string;
  enrolledAt: string;
  accountData: Record<string, string> | null;
  entity: {
    id: number; entitySerial: string | null; projectName: string; category: string;
    twitterUsername: string | null; discordUsername: string | null; email: string | null;
  } | null;
}

function useAuthedFetch() {
  const { token } = useAuth();
  return useCallback(async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
    return data;
  }, [token]);
}

// ── Enroll dialog — pick entities (or paste serials) + Main/Info/Recovery ──
export function EnrollDialog({
  open, onOpenChange, projectId, alreadyEnrolledIds, onEnrolled, showDataEntity = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
  alreadyEnrolledIds: Set<number>;
  onEnrolled: () => void;
  /** Exchange-category projects (including "Other") link a Data Entity
   *  alongside the manual form — see project-detail.tsx's call site. */
  showDataEntity?: boolean;
}) {
  const authedFetch = useAuthedFetch();
  const { toast } = useToast();
  const { data: vaultEntries } = useListVaultEntries();
  const [pickMode, setPickMode] = useState<"pick" | "paste">("pick");
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [serialsText, setSerialsText] = useState("");
  const [accountSubTab, setAccountSubTab] = useState("main");
  const [form, setForm] = useState<Record<string, string>>({ ...ENROLL_EMPTY_FORM });
  const [dataEntityId, setDataEntityId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setPickMode("pick"); setSearch(""); setSelectedIds(new Set()); setSerialsText("");
      setAccountSubTab("main"); setForm({ ...ENROLL_EMPTY_FORM }); setDataEntityId(null);
    }
  }, [open]);

  const entities = ((vaultEntries as any[]) ?? []).filter(e =>
    !alreadyEnrolledIds.has(e.id) &&
    (e.projectName ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const toggleId = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleSubmit = async () => {
    const entityIds = Array.from(selectedIds);
    const entitySerials = serialsText.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
    if (!entityIds.length && !entitySerials.length) {
      toast({ variant: "destructive", title: "Pick at least one entity or paste a serial" });
      return;
    }
    setSubmitting(true);
    try {
      const accountData = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
      const res = await authedFetch("/projects/bulk-enroll", {
        method: "POST",
        body: JSON.stringify({ projectId, entityIds, entitySerials, accountData, dataEntityId }),
      });
      toast({ title: `Enrolled ${res.enrolled} ${res.enrolled === 1 ? "entity" : "entities"}` });
      onEnrolled();
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Enroll failed", description: err?.message });
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-5 pt-5 pb-3 flex-shrink-0 border-b border-card-border">
          <DialogTitle className="font-mono text-sm">Enroll Entities</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Step 1 — pick entities or paste serials */}
          <div className="flex items-center gap-1 bg-muted/20 rounded-lg p-1 w-fit">
            <button
              onClick={() => setPickMode("pick")}
              className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] uppercase transition-all", pickMode === "pick" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
            >
              <ListChecks className="w-3 h-3" /> Pick
            </button>
            <button
              onClick={() => setPickMode("paste")}
              className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-md font-mono text-[10px] uppercase transition-all", pickMode === "paste" ? "bg-card text-primary shadow-sm font-bold" : "text-muted-foreground/60 hover:text-muted-foreground")}
            >
              <ClipboardPaste className="w-3 h-3" /> Paste Serials
            </button>
          </div>

          {pickMode === "pick" ? (
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground/40" />
                <Input value={search} onChange={e => setSearch(e.target.value)} className="pl-8 font-mono text-xs h-8 bg-input" placeholder="Search entities..." />
              </div>
              <div className="max-h-40 overflow-y-auto border border-border/30 rounded-lg divide-y divide-border/20">
                {entities.length === 0 && (
                  <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-4">No unenrolled entities match</p>
                )}
                {entities.map(e => (
                  <label key={e.id} className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-muted/10">
                    <Checkbox checked={selectedIds.has(e.id)} onCheckedChange={() => toggleId(e.id)} />
                    <span className="font-mono text-xs flex-1 truncate">{e.projectName}</span>
                    <Badge variant="outline" className="font-mono text-[9px]">{e.category}</Badge>
                  </label>
                ))}
              </div>
              {selectedIds.size > 0 && (
                <p className="font-mono text-[9px] text-muted-foreground/50">{selectedIds.size} selected</p>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Label className="font-mono text-[10px] uppercase text-muted-foreground/60">Entity Serials</Label>
              <Textarea
                value={serialsText}
                onChange={e => setSerialsText(e.target.value)}
                className="font-mono text-xs bg-input resize-none h-24"
                placeholder={"One per line, or comma-separated\ne.g. AZN-0001\nAZN-0002"}
              />
            </div>
          )}

          {/* Step 2 — Main/Info/Recovery account form, captured at enroll time */}
          <div className="space-y-2 pt-2 border-t border-border/20">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">Account (this project only)</p>
            <div className="flex gap-1 flex-shrink-0 overflow-x-auto">
              {ACCOUNT_SUBTABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setAccountSubTab(t.id)}
                  className={cn(
                    "px-2.5 py-1 rounded font-mono text-[9px] uppercase tracking-wider flex-shrink-0 transition-all border",
                    accountSubTab === t.id ? "border-primary/40 bg-primary/10 text-primary font-bold" : "border-border/30 text-muted-foreground/50 hover:text-muted-foreground"
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <SchemaForm
              fields={ENTITY_FIELDS.filter(fld => fld.tab === "account" && fld.subtab === accountSubTab)}
              form={form}
              onChange={(key, value) => setForm(prev => ({ ...prev, [key]: value }))}
            />
          </div>

          {/* Step 3 — Data Entity link, Exchange-category projects only */}
          {showDataEntity && (
            <div className="space-y-1.5 pt-2 border-t border-border/20">
              <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50">Data Entity</p>
              <DataEntityPicker value={dataEntityId} onChange={setDataEntityId} />
            </div>
          )}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-card-border flex-shrink-0">
          <Button size="sm" onClick={handleSubmit} disabled={submitting} className="font-mono text-xs gap-1.5 w-full">
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Project detail — enrolled entities + their per-project account data ───
const ACTIVITY_ACTION_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  enrolled: { label: "Enrolled", icon: LogIn, color: "text-sky-400" },
  left: { label: "Left project", icon: LogOut, color: "text-muted-foreground" },
  reward: { label: "Reward", icon: Gift, color: "text-emerald-400" },
  disqualified: { label: "Disqualified", icon: XCircle, color: "text-amber-400" },
  banned: { label: "Banned", icon: Ban, color: "text-red-400" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "text-muted-foreground" },
};

// Phase 5 — status badge shown on each enrolled-entity row so disqualified/
// banned/cancelled entities are visually distinguished from active ones at
// a glance (acceptance requirement), without needing to open the activity log.
const ENROLLMENT_STATUS_META: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "text-emerald-400 border-emerald-400/30 bg-emerald-400/5" },
  disqualified: { label: "Disqualified", className: "text-amber-400 border-amber-400/30 bg-amber-400/5" },
  banned: { label: "Banned", className: "text-red-400 border-red-400/30 bg-red-400/5" },
  cancelled: { label: "Cancelled", className: "text-muted-foreground/60 border-border/30 bg-muted/5" },
};
function EnrollmentStatusBadge({ status }: { status: string }) {
  const meta = ENROLLMENT_STATUS_META[status] ?? { label: status, className: "text-muted-foreground/60 border-border/30" };
  return <Badge variant="outline" className={cn("font-mono text-[9px] flex-shrink-0", meta.className)}>{meta.label}</Badge>;
}

// Phase 4 — enrolled/left/reward history + computed totals (days active,
// total reward, reward/day) for a single entity↔project enrollment. Totals
// come straight from the backend's activity_log aggregation, never stored
// client-side, so they can't drift out of sync with the event list.
function EnrollmentActivityPanel({ enrollmentId, authedFetch }: { enrollmentId: number; authedFetch: (path: string, init?: RequestInit) => Promise<any> }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authedFetch(`/projects/enrollments/${enrollmentId}/activity`)
      .then(d => { if (!cancelled) setData(d); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [enrollmentId]);

  if (loading) return <div className="flex items-center justify-center py-4"><Loader2 className="w-4 h-4 text-primary animate-spin" /></div>;
  if (!data || !data.entries?.length) return <p className="font-mono text-[9px] text-muted-foreground/40 py-2 pl-[22px]">No activity recorded yet</p>;

  const { entries, totals } = data;
  return (
    <div className="pl-[22px] space-y-2 pt-1">
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-background/40 rounded-lg p-2 text-center">
          <p className="font-mono text-xs font-bold text-foreground">{totals.daysActive}</p>
          <p className="font-mono text-[8px] text-muted-foreground/50 uppercase">Days active</p>
        </div>
        <div className="bg-background/40 rounded-lg p-2 text-center">
          <p className="font-mono text-xs font-bold text-emerald-400">${totals.totalReward.toFixed(2)}</p>
          <p className="font-mono text-[8px] text-muted-foreground/50 uppercase">Total reward</p>
        </div>
        <div className="bg-background/40 rounded-lg p-2 text-center">
          <p className="font-mono text-xs font-bold text-primary">{totals.rewardPerDay === null ? "—" : `$${totals.rewardPerDay.toFixed(2)}`}</p>
          <p className="font-mono text-[8px] text-muted-foreground/50 uppercase">Reward / day</p>
        </div>
      </div>
      <div className="space-y-1 max-h-48 overflow-y-auto">
        {[...entries].reverse().map((e: any) => {
          const meta = ACTIVITY_ACTION_META[e.action] ?? { label: e.action, icon: History, color: "text-muted-foreground" };
          const Icon = meta.icon;
          return (
            <div key={e.id} className="flex items-center gap-2 font-mono text-[9px]">
              <Icon className={cn("w-3 h-3 flex-shrink-0", meta.color)} />
              <span className="text-foreground/70 flex-1">{meta.label}</span>
              {e.amount !== null && <span className="text-emerald-400">+${Number(e.amount).toFixed(2)}</span>}
              <span className="text-muted-foreground/40">{new Date(e.createdAt).toLocaleDateString()}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProjectEntitiesDetail({ projectId, projectName, onBack }: { projectId: number; projectName: string; onBack: () => void }) {
  const authedFetch = useAuthedFetch();
  const { toast } = useToast();
  const { isAdmin, isModerator } = useAuth();
  const canModerate = isAdmin || isModerator;
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [expandedActivity, setExpandedActivity] = useState<Set<number>>(new Set());

  const toggleActivity = (id: number) => setExpandedActivity(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await authedFetch(`/projects/${projectId}/enrollments`);
      setEnrollments(data);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to load enrollments", description: err?.message });
    } finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const handleUnenroll = async (enrollmentId: number) => {
    try {
      await authedFetch(`/projects/${projectId}/enrollments/${enrollmentId}`, { method: "DELETE" });
      setEnrollments(e => e.filter(x => x.id !== enrollmentId));
      toast({ title: "Removed from project" });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to remove", description: err?.message });
    }
  };

  // Phase 5 — Disqualify / Ban / Cancel enrollment (admin/moderator only).
  // Unlike handleUnenroll (DELETE, voluntary — removes the row), these
  // moderation actions keep the row and its history and only change status.
  const MODERATION_LABELS: Record<string, string> = {
    disqualified: "Disqualified",
    banned: "Banned",
    cancelled: "Cancelled",
    active: "Restored to active",
  };
  const handleModerate = async (enrollmentId: number, status: "disqualified" | "banned" | "cancelled" | "active") => {
    try {
      const updated = await authedFetch(`/projects/${projectId}/enrollments/${enrollmentId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      setEnrollments(e => e.map(x => (x.id === enrollmentId ? { ...x, status: updated.status } : x)));
      toast({ title: MODERATION_LABELS[status] ?? status });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Action failed", description: err?.message });
    }
  };

  const toggleReveal = (id: number) => setRevealed(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack} className="font-mono text-[10px] gap-1.5">
          <ArrowLeft className="w-3.5 h-3.5" /> Back
        </Button>
        <h2 className="font-mono text-sm font-bold flex-1 truncate">{projectName}</h2>
        <Button size="sm" onClick={() => setEnrollOpen(true)} className="font-mono text-xs gap-1.5">
          <Plus className="w-3.5 h-3.5" /> Enroll Entities
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
      ) : enrollments.length === 0 ? (
        <div className="text-center py-16 space-y-2 border border-dashed border-border/40 rounded-lg">
          <Users className="w-6 h-6 text-muted-foreground/20 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">No entities enrolled in this project yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {enrollments.map(enr => {
            const isRevealed = revealed.has(enr.id);
            const acct = enr.accountData;
            return (
              <div key={enr.id} className={cn("bg-card border border-card-border rounded-lg p-3 space-y-2", enr.status !== "active" && "opacity-60")}>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
                  <span className="font-mono text-xs font-bold flex-1 truncate">{enr.entity?.projectName ?? "Unknown entity"}</span>
                  {enr.entity?.entitySerial && (
                    <Badge variant="outline" className="font-mono text-[9px]">{enr.entity.entitySerial}</Badge>
                  )}
                  <EnrollmentStatusBadge status={enr.status} />
                  <button onClick={() => toggleReveal(enr.id)} className="text-muted-foreground/40 hover:text-foreground transition-colors">
                    {isRevealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => toggleActivity(enr.id)} className="text-muted-foreground/40 hover:text-foreground transition-colors flex items-center gap-0.5">
                    <History className="w-3.5 h-3.5" />
                    {expandedActivity.has(enr.id) ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  </button>
                  {canModerate && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="text-muted-foreground/40 hover:text-foreground transition-colors">
                          <MoreVertical className="w-3.5 h-3.5" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="font-mono text-xs">
                        {enr.status !== "active" && (
                          <DropdownMenuItem onClick={() => handleModerate(enr.id, "active")} className="gap-1.5">
                            <RotateCcw className="w-3.5 h-3.5" /> Restore to active
                          </DropdownMenuItem>
                        )}
                        {enr.status !== "disqualified" && (
                          <DropdownMenuItem onClick={() => handleModerate(enr.id, "disqualified")} className="gap-1.5 text-amber-400 focus:text-amber-400">
                            <ShieldAlert className="w-3.5 h-3.5" /> Disqualify
                          </DropdownMenuItem>
                        )}
                        {enr.status !== "banned" && (
                          <DropdownMenuItem onClick={() => handleModerate(enr.id, "banned")} className="gap-1.5 text-red-400 focus:text-red-400">
                            <Ban className="w-3.5 h-3.5" /> Ban
                          </DropdownMenuItem>
                        )}
                        {enr.status !== "cancelled" && (
                          <DropdownMenuItem onClick={() => handleModerate(enr.id, "cancelled")} className="gap-1.5">
                            <XCircle className="w-3.5 h-3.5" /> Cancel enrollment
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                  <button onClick={() => handleUnenroll(enr.id)} className="text-muted-foreground/30 hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {!acct ? (
                  <p className="font-mono text-[9px] text-muted-foreground/40 pl-[22px]">No account data captured for this project</p>
                ) : (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 pl-[22px]">
                    {Object.entries(acct).filter(([, v]) => v).map(([key, value]) => {
                      const isSecret = /password|2fa|backup|recovery/i.test(key);
                      return (
                        <div key={key} className="font-mono text-[10px] truncate">
                          <span className="text-muted-foreground/40 uppercase">{key}: </span>
                          <span className="text-foreground/80">{isSecret && !isRevealed ? "••••••••" : String(value)}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {expandedActivity.has(enr.id) && (
                  <EnrollmentActivityPanel enrollmentId={enr.id} authedFetch={authedFetch} />
                )}
              </div>
            );
          })}
        </div>
      )}

      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        projectId={projectId}
        alreadyEnrolledIds={new Set(enrollments.map(e => e.vaultEntryId))}
        onEnrolled={load}
      />
    </div>
  );
}

// ── Others tab — every vault entity, flagged "Enrolled" once it's enrolled
// into at least one project (mirrors the same "Enrolled" status shown on
// /vault/enroll, both reading the entity-leaderboard rollup so they never
// drift apart). Exported so pages/user/enroll-entities.tsx (Phase 10A) can
// reuse it as the Entities section's Entity list instead of a second
// implementation of this same list. ─────────────────────────────────────
interface EntityEnrollSummary {
  vaultEntryId: number;
  entitySerial: string | null;
  entityName: string | null;
  category: string | null;
  totalProjects: number;
}

// Phase 10B — onSelect is optional so existing callers (the /vault/projects
// "Others" tab) keep their non-interactive rows; only enroll-entities.tsx
// passes it, to open each entity's dedicated dashboard.
export function OthersEntitiesTab({ onSelect }: { onSelect?: (vaultEntryId: number) => void } = {}) {
  const authedFetch = useAuthedFetch();
  const [entities, setEntities] = useState<EntityEnrollSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    authedFetch("/projects/entity-leaderboard")
      .then(data => { if (!cancelled) setEntities(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setEntities([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [authedFetch]);

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;
  }

  if (entities.length === 0) {
    return (
      <div className="text-center py-16 space-y-2 border border-dashed border-border/40 rounded-lg">
        <Users className="w-6 h-6 text-muted-foreground/20 mx-auto" />
        <p className="font-mono text-xs text-muted-foreground/50">No entities in your vault yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {entities.map(e => {
        const enrolled = e.totalProjects > 0;
        const Row = onSelect ? "button" : "div";
        return (
          <Row
            key={e.vaultEntryId}
            {...(onSelect ? { onClick: () => onSelect(e.vaultEntryId), type: "button" as const } : {})}
            className={cn(
              "w-full bg-card border border-card-border rounded-lg p-3 flex items-center gap-3",
              onSelect && "text-left hover:border-primary/40 transition-colors"
            )}
          >
            <Shield className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-mono text-xs font-bold truncate">{e.entityName ?? `#${e.vaultEntryId}`}</p>
              <p className="font-mono text-[9px] text-muted-foreground/50 truncate">
                {e.category ?? "—"}{e.entitySerial ? ` · ${e.entitySerial}` : ""}
              </p>
            </div>
            <Badge
              variant="outline"
              className={cn(
                "font-mono text-[9px] flex-shrink-0",
                enrolled ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/5" : "text-muted-foreground/40 border-border/30"
              )}
            >
              {enrolled ? `Enrolled · ${e.totalProjects}` : "Not enrolled"}
            </Badge>
          </Row>
        );
      })}
    </div>
  );
}

// ── Project list — every project the user has enrolled entities into ──────
export default function ProjectEntitiesPage() {
  const authedFetch = useAuthedFetch();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [projects, setProjects] = useState<EnrolledProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const params = new URLSearchParams(search);
  const selectedId = params.get("project") ? Number(params.get("project")) : null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await authedFetch("/projects/mine/enrolled");
      setProjects(data);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (selectedId) {
    const p = projects.find(x => x.projectId === selectedId);
    return (
      <ProjectEntitiesDetail
        projectId={selectedId}
        projectName={p?.projectName ?? "Project"}
        onBack={() => navigate("/vault/projects")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ClipboardList className="w-4 h-4 text-primary" />
        <h1 className="font-mono text-sm font-bold">Project — Enrolled Entities</h1>
      </div>
      <p className="font-mono text-[10px] text-muted-foreground/50">
        Every project you've enrolled entities into. Each entity's account is captured per-project here — separate from its own Vault record.
      </p>

      <Tabs defaultValue="projects" className="space-y-3">
        <TabsList className="bg-muted/20">
          <TabsTrigger value="projects" className="font-mono text-xs">Projects</TabsTrigger>
          <TabsTrigger value="others" className="font-mono text-xs">Others</TabsTrigger>
        </TabsList>

        <TabsContent value="projects">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
          ) : projects.length === 0 ? (
            <div className="text-center py-16 space-y-2 border border-dashed border-border/40 rounded-lg">
              <FolderGit2 className="w-6 h-6 text-muted-foreground/20 mx-auto" />
              <p className="font-mono text-xs text-muted-foreground/50">No enrollments yet</p>
              <p className="font-mono text-[9px] text-muted-foreground/40">Enroll entities from a project's page — it'll show up here.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {projects.map(p => (
                <button
                  key={p.projectId}
                  onClick={() => navigate(`/vault/projects?project=${p.projectId}`)}
                  className="bg-card border border-card-border rounded-lg p-3 flex items-center gap-3 text-left hover:border-primary/40 transition-colors"
                >
                  <FolderGit2 className="w-4 h-4 text-primary/70 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-xs font-bold truncate">{p.projectName}</p>
                    <p className="font-mono text-[9px] text-muted-foreground/50">{p.enrolledCount} entit{p.enrolledCount !== 1 ? "ies" : "y"} enrolled</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="others">
          <OthersEntitiesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
