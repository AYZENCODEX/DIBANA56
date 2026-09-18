import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  ShieldCheck, Check, X, Loader2, RefreshCw, Clock,
  Twitter, MessageCircle, Send, Phone, Facebook, MapPin,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface KycUser {
  id: number;
  username: string;
  email: string;
  avatarUrl: string | null;
  twitterHandle: string | null;
  discordHandle: string | null;
  telegramHandle: string | null;
  telegramChatId: string | null;
  whatsappNumber: string | null;
  facebookUrl: string | null;
  location: string | null;
  kycLevel: number;
  kycStatus: string;
  kycSubmittedAt: string | null;
  kycReviewedAt: string | null;
  kycRejectionReason: string | null;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  rejected: "bg-red-500/10 text-red-400 border-red-500/30",
  none: "bg-muted/30 text-muted-foreground border-border",
};

const TABS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

export default function AdminKycPage() {
  const { token } = useAuth() as any;
  const { toast } = useToast();
  const [tab, setTab] = useState("pending");
  const [users, setUsers] = useState<KycUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<number | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/kyc?status=${tab}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setUsers(await r.json());
    } catch { /* noop */ }
    setLoading(false);
  }, [token, tab]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  const handleApprove = async (id: number) => {
    setProcessing(id);
    try {
      const r = await fetch(`/api/admin/kyc/${id}/approve`, { method: "POST", headers });
      if (r.ok) {
        toast({ title: "✅ KYC approved — user notified" });
        await fetchUsers();
      } else {
        const d = await r.json();
        toast({ variant: "destructive", title: d.error ?? "Failed to approve" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setProcessing(null);
  };

  const handleReject = async (id: number) => {
    setProcessing(id);
    try {
      const r = await fetch(`/api/admin/kyc/${id}/reject`, {
        method: "POST", headers, body: JSON.stringify({ reason: reasons[id] ?? "Not specified" }),
      });
      if (r.ok) {
        toast({ title: "KYC rejected — user notified" });
        await fetchUsers();
      } else {
        const d = await r.json();
        toast({ variant: "destructive", title: d.error ?? "Failed to reject" });
      }
    } catch { toast({ variant: "destructive", title: "Connection error" }); }
    setProcessing(null);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" /> KYC Approvals
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">
            {users.length} {tab === "all" ? "" : tab} submission{users.length !== 1 ? "s" : ""}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchUsers} disabled={loading} className="font-mono text-xs gap-2">
          <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

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
          {[1, 2, 3].map(i => <div key={i} className="bg-card border border-card-border rounded-lg h-32 animate-pulse" />)}
        </div>
      ) : users.length === 0 ? (
        <div className="bg-card border border-card-border rounded-lg px-6 py-12 text-center">
          <Clock className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-mono text-sm text-muted-foreground">No {tab === "all" ? "" : tab} KYC submissions</p>
        </div>
      ) : (
        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="bg-card border border-card-border rounded-lg overflow-hidden">
              <div className="px-5 py-4">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-start gap-3">
                    <div className="w-10 h-10 rounded-full overflow-hidden bg-muted/30 flex-shrink-0 flex items-center justify-center">
                      {u.avatarUrl ? (
                        <img src={u.avatarUrl} alt={u.username} className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-xs font-mono font-bold text-primary">{u.username.slice(0, 2).toUpperCase()}</span>
                      )}
                    </div>
                    <div>
                      <div className="font-mono font-bold text-sm text-foreground flex items-center gap-2">
                        {u.username}
                        <Badge className={cn("font-mono text-[8px] px-1.5 py-0 border", STATUS_STYLES[u.kycStatus] ?? STATUS_STYLES.none)}>
                          {u.kycStatus.toUpperCase()}
                        </Badge>
                      </div>
                      <div className="font-mono text-xs text-muted-foreground mt-0.5">{u.email}</div>

                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] font-mono text-muted-foreground">
                        {u.twitterHandle && <span className="flex items-center gap-1"><Twitter className="w-3 h-3 text-sky-400" /> {u.twitterHandle}</span>}
                        {u.discordHandle && <span className="flex items-center gap-1"><MessageCircle className="w-3 h-3 text-indigo-400" /> {u.discordHandle}</span>}
                        {u.telegramHandle && (
                          <span className="flex items-center gap-1">
                            <Send className="w-3 h-3 text-cyan-400" /> {u.telegramHandle}
                            {u.telegramChatId
                              ? <Check className="w-3 h-3 text-emerald-400" />
                              : <X className="w-3 h-3 text-red-400" />}
                          </span>
                        )}
                        {u.whatsappNumber && <span className="flex items-center gap-1"><Phone className="w-3 h-3 text-green-400" /> {u.whatsappNumber}</span>}
                        {u.facebookUrl && <span className="flex items-center gap-1"><Facebook className="w-3 h-3 text-blue-400" /> {u.facebookUrl}</span>}
                        {u.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3 text-amber-400" /> {u.location}</span>}
                      </div>

                      {u.kycSubmittedAt && (
                        <div className="font-mono text-[9px] text-muted-foreground/40 mt-1.5">
                          Submitted {new Date(u.kycSubmittedAt).toLocaleString()}
                        </div>
                      )}
                      {u.kycStatus === "rejected" && u.kycRejectionReason && (
                        <div className="font-mono text-[10px] text-red-400/80 mt-1">Reason: {u.kycRejectionReason}</div>
                      )}
                    </div>
                  </div>

                  {u.kycStatus === "pending" && (
                    <div className="flex flex-col gap-2 flex-shrink-0">
                      <Button
                        size="sm"
                        onClick={() => handleApprove(u.id)}
                        disabled={processing === u.id}
                        className="font-mono text-[10px] gap-1.5 h-8 px-3 bg-emerald-500 hover:bg-emerald-500/90 text-white"
                      >
                        {processing === u.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleReject(u.id)}
                        disabled={processing === u.id}
                        className="font-mono text-[10px] gap-1.5 h-8 px-3 border-red-500/20 text-red-400 hover:bg-red-500/10"
                      >
                        <X className="w-3 h-3" /> Reject
                      </Button>
                    </div>
                  )}
                </div>

                {u.kycStatus === "pending" && (
                  <div className="mt-3">
                    <Input
                      placeholder="Rejection reason (used only if you click Reject)"
                      value={reasons[u.id] ?? ""}
                      onChange={e => setReasons(r => ({ ...r, [u.id]: e.target.value }))}
                      className="font-mono text-xs h-8 bg-input border-border"
                    />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
