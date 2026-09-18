/**
 * admin/emergency-access.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 * Admin review queue for routes/emergency-access.ts. Every row here is a
 * triggered dead-man-switch event (emergency_access_grants) sitting in
 * "pending_admin_review" — the cron already fired because the owner has
 * been inactive past a contact's wait_days, and the owner hasn't cancelled
 * it themselves. Approve mints a single-use bearer link emailed to the
 * contact; deny just closes the request out. Both notify the owner.
 */
import { useState, useEffect, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  HeartPulse, Check, X, Loader2, RefreshCw, Clock, ShieldAlert,
  Mail, User as UserIcon, Timer, History,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  listAdminEmergencyGrants, approveEmergencyGrant, denyEmergencyGrant,
} from "@/lib/emergency-access-api";

interface AdminGrantRow {
  id: number;
  contact_id: number;
  owner_user_id: number;
  status: string;
  owner_inactive_since_at: string | null;
  triggered_at: string;
  cancelled_at: string | null;
  admin_reviewed_by: number | null;
  admin_reviewed_at: string | null;
  admin_note: string | null;
  access_token_expires_at: string | null;
  accessed_at: string | null;
  contact_name: string;
  contact_email: string;
  owner_username: string;
  owner_email: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending_admin_review: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  denied: "bg-red-500/10 text-red-400 border-red-500/30",
  cancelled: "bg-muted/30 text-muted-foreground border-border",
  expired: "bg-muted/30 text-muted-foreground border-border",
  revoked: "bg-muted/30 text-muted-foreground border-border",
};

const STATUS_LABEL: Record<string, string> = {
  pending_admin_review: "Pending Review",
  approved: "Approved",
  denied: "Denied",
  cancelled: "Cancelled by owner",
  expired: "Expired",
  revoked: "Revoked",
};

const TABS = [
  { key: "pending_admin_review", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "denied", label: "Denied" },
  { key: "cancelled", label: "Cancelled" },
];

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
}

export default function AdminEmergencyAccessPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState("pending_admin_review");
  const [rows, setRows] = useState<AdminGrantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<number | null>(null);
  const [notes, setNotes] = useState<Record<number, string>>({});

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listAdminEmergencyGrants(tab);
      setRows(res.items as AdminGrantRow[]);
    } catch {
      toast({ variant: "destructive", title: "Couldn't load emergency access requests" });
    }
    setLoading(false);
  }, [tab, toast]);

  useEffect(() => { fetchGrants(); }, [fetchGrants]);

  async function handleApprove(id: number) {
    setProcessing(id);
    try {
      await approveEmergencyGrant(id, notes[id]);
      toast({ title: "Approved — a single-use view link was emailed to the contact" });
      await fetchGrants();
    } catch (err: any) {
      toast({ variant: "destructive", title: err?.message ?? "Failed to approve" });
    }
    setProcessing(null);
  }

  async function handleDeny(id: number) {
    setProcessing(id);
    try {
      await denyEmergencyGrant(id, notes[id]);
      toast({ title: "Request denied — owner notified" });
      await fetchGrants();
    } catch (err: any) {
      toast({ variant: "destructive", title: err?.message ?? "Failed to deny" });
    }
    setProcessing(null);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <HeartPulse className="w-6 h-6 text-primary" /> Emergency Access Review
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            {rows.length} {tab === "all" ? "" : STATUS_LABEL[tab]?.toLowerCase()} request{rows.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchGrants} disabled={loading} className="font-mono text-xs gap-2">
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {tab === "pending_admin_review" && (
        <Alert className="border-amber-400/25 bg-amber-500/5">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          <AlertTitle className="font-mono text-xs uppercase tracking-wide text-amber-400">Second gate on the dead-man switch</AlertTitle>
          <AlertDescription className="font-mono text-[11px] text-muted-foreground">
            Each row already crossed its inactivity threshold and the owner hasn't cancelled. Approving mints a
            single-use, 30-day link emailed straight to the contact — verify the request looks legitimate before approving.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-3 py-1.5 rounded-lg text-[11px] font-mono uppercase tracking-wider border transition-colors",
              tab === t.key
                ? "bg-primary/10 border-primary/40 text-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => <div key={i} className="bg-card border border-card-border rounded-lg h-36 animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="bg-card border border-card-border rounded-lg px-6 py-12 text-center">
          <Clock className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground">No {STATUS_LABEL[tab]?.toLowerCase() ?? ""} requests</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map(g => {
            const inactiveDays = daysSince(g.owner_inactive_since_at);
            const isPending = g.status === "pending_admin_review";
            return (
              <div key={g.id} className="bg-card border border-card-border rounded-lg overflow-hidden">
                <div className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center flex-shrink-0">
                        <ShieldAlert className="w-5 h-5 text-amber-400" />
                      </div>
                      <div className="min-w-0">
                        <div className="font-mono font-bold text-sm text-foreground flex items-center gap-2 flex-wrap">
                          <span className="flex items-center gap-1"><UserIcon className="w-3.5 h-3.5 text-muted-foreground/60" /> {g.owner_username}</span>
                          <Badge className={cn("font-mono text-[8px] px-1.5 py-0 border", STATUS_STYLES[g.status] ?? STATUS_STYLES.cancelled)}>
                            {STATUS_LABEL[g.status] ?? g.status}
                          </Badge>
                        </div>
                        <div className="font-mono text-xs text-muted-foreground mt-0.5">{g.owner_email}</div>

                        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] font-mono text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Mail className="w-3 h-3 text-cyan-400" /> Contact: {g.contact_name} ({g.contact_email})
                          </span>
                          {inactiveDays !== null && (
                            <span className="flex items-center gap-1">
                              <Timer className="w-3 h-3 text-amber-400" /> Owner inactive {inactiveDays}d as of trigger
                            </span>
                          )}
                          <span className="flex items-center gap-1">
                            <Clock className="w-3 h-3" /> Triggered {new Date(g.triggered_at).toLocaleString()}
                          </span>
                        </div>

                        {g.admin_reviewed_at && (
                          <div className="font-mono text-[10px] text-muted-foreground/50 mt-1.5 flex items-center gap-1">
                            <History className="w-3 h-3" /> Reviewed {new Date(g.admin_reviewed_at).toLocaleString()}
                            {g.admin_note && <span className="text-muted-foreground/70"> — "{g.admin_note}"</span>}
                          </div>
                        )}
                        {g.status === "approved" && (
                          <div className="font-mono text-[10px] mt-1">
                            {g.accessed_at
                              ? <span className="text-emerald-400/80">Viewed {new Date(g.accessed_at).toLocaleString()}</span>
                              : <span className="text-muted-foreground/50">Not yet viewed</span>}
                            {g.access_token_expires_at && (
                              <span className="text-muted-foreground/40"> · link expires {new Date(g.access_token_expires_at).toLocaleDateString()}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {isPending && (
                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <Button
                          size="sm"
                          onClick={() => handleApprove(g.id)}
                          disabled={processing === g.id}
                          className="font-mono text-[10px] gap-1.5 h-8 px-3 bg-emerald-500 hover:bg-emerald-500/90 text-white"
                        >
                          {processing === g.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleDeny(g.id)}
                          disabled={processing === g.id}
                          className="font-mono text-[10px] gap-1.5 h-8 px-3 border-red-500/20 text-red-400 hover:bg-red-500/10"
                        >
                          <X className="w-3 h-3" /> Deny
                        </Button>
                      </div>
                    )}
                  </div>

                  {isPending && (
                    <div className="mt-3">
                      <Textarea
                        placeholder="Review note (optional — stored either way, shown above once reviewed)"
                        value={notes[g.id] ?? ""}
                        onChange={e => setNotes(n => ({ ...n, [g.id]: e.target.value }))}
                        maxLength={500}
                        className="font-mono text-xs min-h-[44px] bg-input border-border"
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
