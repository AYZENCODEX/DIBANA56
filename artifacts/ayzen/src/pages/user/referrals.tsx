import { useState, useEffect } from "react";
import { Copy, Check, Users, DollarSign, Clock, Share2, Gift, Link2, ChevronRight, Trophy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface ReferralMe {
  code: string; link: string; totalReferrals: number;
  paidReferrals: number; pendingReferrals: number;
  totalRewards: number; pendingRewards: number; rewardPerReferral: number;
}
interface ReferralItem {
  referralId: number; username: string; email: string; status: string;
  rewardAmount: number; rewardPaid: boolean; createdAt: string; joinedAt: string;
}

function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return { copied, copy };
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy();
  return (
    <button onClick={() => copy(text)}
      className={cn("flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono transition-all",
        copied ? "border-emerald-400/50 text-emerald-400 bg-emerald-400/10" : "border-border text-muted-foreground hover:border-primary/40 hover:text-primary")}>
      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
      {copied ? "Copied!" : label}
    </button>
  );
}

export default function UserReferrals() {
  const [me, setMe] = useState<ReferralMe | null>(null);
  const [list, setList] = useState<ReferralItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [applyCode, setApplyCode] = useState("");
  const [applyStatus, setApplyStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [applyMsg, setApplyMsg] = useState("");

  const token = localStorage.getItem("ayzen_token") ?? "";

  useEffect(() => {
    Promise.all([
      fetch("/api/referrals/me", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch("/api/referrals/list", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]).then(([meData, listData]) => {
      setMe(meData);
      setList(Array.isArray(listData) ? listData : []);
    }).finally(() => setLoading(false));
  }, []);

  const handleApply = async () => {
    if (!applyCode.trim()) return;
    setApplyStatus("loading");
    const res = await fetch("/api/referrals/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: applyCode.trim().toUpperCase() }),
    });
    const data = await res.json();
    if (res.ok) {
      setApplyStatus("ok");
      setApplyMsg(`Applied! You were referred by ${data.referrerUsername}`);
    } else {
      setApplyStatus("error");
      setApplyMsg(data.error ?? "Failed to apply code");
    }
  };

  const stats = [
    { label: "Total Referred", value: me?.totalReferrals ?? 0, icon: Users, color: "text-primary", bg: "bg-primary/5 border-primary/20" },
    { label: "Rewards Earned", value: `$${(me?.totalRewards ?? 0).toFixed(2)}`, icon: DollarSign, color: "text-emerald-400", bg: "bg-emerald-400/5 border-emerald-400/20" },
    { label: "Pending Payout", value: `$${(me?.pendingRewards ?? 0).toFixed(2)}`, icon: Clock, color: "text-amber-400", bg: "bg-amber-400/5 border-amber-400/20" },
    { label: "Per Referral", value: `$${me?.rewardPerReferral ?? 10}`, icon: Gift, color: "text-violet-400", bg: "bg-violet-400/5 border-violet-400/20" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
          <Share2 className="h-6 w-6 text-primary" /> Referral Program
        </h1>
        <p className="text-muted-foreground font-mono text-sm">Earn $10 for every operator you bring to AYZEN</p>
      </div>

      {/* Hero referral card */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/5 via-card to-secondary/5 p-6">
        <div className="absolute top-0 right-0 w-48 h-48 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
        <div className="relative">
          <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest mb-3">Your Referral Code</p>
          {loading ? <Skeleton className="h-12 w-48 mb-3" /> : (
            <div className="flex items-center gap-4 mb-4">
              <span className="text-4xl font-mono font-black tracking-widest text-primary glow-text">
                {me?.code ?? "——"}
              </span>
              <CopyBtn text={me?.code ?? ""} label="Copy Code" />
            </div>
          )}
          <p className="text-xs font-mono text-muted-foreground mb-2 uppercase tracking-wider">Referral Link</p>
          {loading ? <Skeleton className="h-8 w-full max-w-md" /> : (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 font-mono text-xs text-muted-foreground flex-1 min-w-0">
                <Link2 className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="truncate">{me?.link}</span>
              </div>
              <CopyBtn text={me?.link ?? ""} label="Copy Link" />
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {stats.map(s => (
          <div key={s.label} className={cn("rounded-xl border p-4 animate-fade-up", s.bg)}>
            <div className="flex items-center gap-1.5 mb-2">
              <s.icon className={cn("w-3.5 h-3.5", s.color)} />
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">{s.label}</span>
            </div>
            {loading ? <Skeleton className="h-7 w-16" /> : (
              <p className={cn("text-2xl font-mono font-bold", s.color)}>{s.value}</p>
            )}
          </div>
        ))}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Apply a referral code */}
        <div className="border border-card-border rounded-xl bg-card p-5">
          <p className="font-mono text-sm font-bold text-foreground mb-1">Have a Code?</p>
          <p className="text-xs font-mono text-muted-foreground mb-4">Enter a referral code from a friend to link your account</p>
          <div className="flex gap-2">
            <input
              value={applyCode}
              onChange={e => setApplyCode(e.target.value.toUpperCase())}
              placeholder="AYZNXXXXXX"
              className="flex-1 bg-input border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary/60 transition-colors uppercase placeholder:normal-case placeholder:text-muted-foreground"
              disabled={applyStatus === "ok"}
            />
            <button
              onClick={handleApply}
              disabled={applyStatus === "loading" || applyStatus === "ok" || !applyCode.trim()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-xs font-mono hover:bg-primary/80 disabled:opacity-40 transition-colors"
            >
              {applyStatus === "loading" ? "…" : "Apply"}
            </button>
          </div>
          {applyMsg && (
            <p className={cn("text-xs font-mono mt-2", applyStatus === "ok" ? "text-emerald-400" : "text-destructive")}>
              {applyMsg}
            </p>
          )}
        </div>

        {/* How it works */}
        <div className="border border-card-border rounded-xl bg-card p-5">
          <p className="font-mono text-sm font-bold text-foreground mb-3">How It Works</p>
          <div className="space-y-3">
            {[
              { n: "1", t: "Share your code or link", d: "Send to friends or post in crypto communities" },
              { n: "2", t: "They sign up", d: "New operator registers using your referral code" },
              { n: "3", t: "You earn $10", d: "Reward is credited when admin processes the payout" },
            ].map(s => (
              <div key={s.n} className="flex items-start gap-3">
                <div className="w-5 h-5 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-[9px] font-mono text-primary font-bold">{s.n}</span>
                </div>
                <div>
                  <p className="text-xs font-mono font-bold text-foreground">{s.t}</p>
                  <p className="text-[10px] font-mono text-muted-foreground">{s.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Referred users table */}
      <div className="border border-card-border rounded-xl bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-card-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-primary" />
            <span className="font-mono text-sm font-bold">Referred Operators</span>
          </div>
          <Badge variant="outline" className="font-mono text-[10px]">{list.length} total</Badge>
        </div>
        {loading ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : list.length === 0 ? (
          <div className="py-12 text-center">
            <Users className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="font-mono text-sm text-muted-foreground">No referrals yet</p>
            <p className="font-mono text-xs text-muted-foreground/60 mt-1">Share your code to start earning</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="border-card-border hover:bg-transparent">
                <TableHead className="font-mono uppercase text-[10px]">Operator</TableHead>
                <TableHead className="font-mono uppercase text-[10px]">Status</TableHead>
                <TableHead className="font-mono uppercase text-[10px]">Joined</TableHead>
                <TableHead className="font-mono uppercase text-[10px] text-right">Reward</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map(r => (
                <TableRow key={r.referralId} className="border-card-border hover:bg-muted/30">
                  <TableCell>
                    <div>
                      <p className="font-mono text-sm font-bold text-foreground">{r.username}</p>
                      <p className="font-mono text-[10px] text-muted-foreground/60">{r.email}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn("font-mono text-[10px] uppercase rounded-sm border",
                      r.rewardPaid ? "border-emerald-400/40 text-emerald-400" : "border-amber-400/40 text-amber-400")}>
                      {r.rewardPaid ? "Paid" : "Pending"}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {format(new Date(r.joinedAt), "MMM dd, yyyy")}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={cn("font-mono text-sm font-bold", r.rewardPaid ? "text-emerald-400" : "text-amber-400")}>
                      ${r.rewardAmount.toFixed(2)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
