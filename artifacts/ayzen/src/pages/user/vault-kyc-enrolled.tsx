/**
 * vault-kyc-enrolled.tsx
 * ─────────────────────────────────────────────
 * Vault → KYC → Enrolled — now Overview/Active tabs (same hierarchy
 * pattern as the top-level Enroll sidebar's Projects/Entities pages —
 * components/layout/enroll-sidebar.tsx):
 *
 *   Overview — every KYC entity in the vault (GET /kyc-entries), each
 *              flagged Enrolled/Not enrolled against the enrollment list
 *              below, plus a small dashboard of enrollment stats.
 *   Active   — Exchange-platform (Binance/Bitget/Kucoin/Bybit) project
 *              enrollments created via the KYC-entity shortcut (pick a KYC
 *              Entity, no manual form — see kyc-entity-enroll-dialog.tsx).
 *              This is the original single-list view this page used to be.
 *              Backed by GET /kyc-entries/enrollments.
 */
import { useEffect, useState, useCallback } from "react";
import { Link } from "wouter";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeftRight, IdCard, FolderGit2, Loader2,
  CheckCircle2, ShieldAlert, Ban, XCircle, Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface EnrolledRow {
  enrollment_id: number;
  status: string;
  enrolled_at: string;
  project_id: number;
  project_name: string;
  project_type: string | null;
  thumbnail_url: string | null;
  kyc_entry_id: number;
  kyc_platform: string | null;
  kyc_username: string | null;
  vault_entry_id: number;
  vault_entry_name: string | null;
}

interface KycEntryRow {
  id: number;
  category: string;
  platform: string | null;
  username: string | null;
  name: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  active: "border-emerald-400/30 text-emerald-400",
  completed: "border-primary/30 text-primary",
  disqualified: "border-amber-400/30 text-amber-400",
  banned: "border-red-400/30 text-red-400",
  cancelled: "border-border text-muted-foreground",
};

const STATUS_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  active: { label: "Active", icon: CheckCircle2, color: "text-emerald-400" },
  completed: { label: "Completed", icon: CheckCircle2, color: "text-primary" },
  disqualified: { label: "Disqualified", icon: ShieldAlert, color: "text-amber-400" },
  banned: { label: "Banned", icon: Ban, color: "text-red-400" },
  cancelled: { label: "Cancelled", icon: XCircle, color: "text-muted-foreground" },
};

function useEnrollmentData() {
  const [rows, setRows] = useState<EnrolledRow[]>([]);
  const [kycEntries, setKycEntries] = useState<KycEntryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [enrollments, entries] = await Promise.all([
        customFetch<EnrolledRow[]>("/api/kyc-entries/enrollments").catch(() => []),
        customFetch<KycEntryRow[]>("/api/kyc-entries").catch(() => []),
      ]);
      setRows(Array.isArray(enrollments) ? enrollments : []);
      setKycEntries(Array.isArray(entries) ? entries : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { rows, kycEntries, loading };
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: React.ElementType; color: string }) {
  return (
    <div className="bg-card border border-card-border rounded-xl p-3.5 flex items-start gap-3">
      <Icon className={cn("w-5 h-5 mt-0.5 flex-shrink-0", color)} />
      <div className="min-w-0">
        <p className={cn("text-lg font-bold font-mono truncate", color)}>{value}</p>
        <p className="text-[10px] text-muted-foreground/60 font-mono">{label}</p>
      </div>
    </div>
  );
}

function OverviewTab({ rows, kycEntries, loading }: { rows: EnrolledRow[]; kycEntries: KycEntryRow[]; loading: boolean }) {
  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;

  const enrolledEntryIds = new Set(rows.map(r => r.kyc_entry_id));
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;

  if (kycEntries.length === 0) {
    return (
      <VaultSectionEmptyState
        icon={IdCard}
        title="No KYC entities yet"
        note="Add a KYC entity to Vault and it'll show up here, flagged Enrolled once it's used on a project."
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Dashboard — enrollment stats across every KYC entity */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <StatCard label="KYC Entities" value={String(kycEntries.length)} icon={IdCard} color="text-primary" />
        <StatCard label="Enrolled" value={String(enrolledEntryIds.size)} icon={Users} color="text-cyan-400" />
        <StatCard label="Not Enrolled" value={String(kycEntries.length - enrolledEntryIds.size)} icon={XCircle} color="text-muted-foreground" />
        {Object.entries(statusCounts).map(([status, count]) => {
          const meta = STATUS_META[status] ?? STATUS_META.cancelled;
          return <StatCard key={status} label={meta.label} value={String(count)} icon={meta.icon} color={meta.color} />;
        })}
      </div>

      {/* Every KYC entity, flagged Enrolled/Not enrolled */}
      <div className="space-y-2">
        {kycEntries.map(k => {
          const enrolled = enrolledEntryIds.has(k.id);
          return (
            <Link key={k.id} href={`/vault/kyc/${k.id}`}>
              <div className="bg-card border border-card-border rounded-lg p-3 flex items-center gap-3 hover:border-primary/40 transition-colors cursor-pointer">
                <IdCard className="w-3.5 h-3.5 text-primary/70 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-xs font-bold truncate">{k.name || k.username || `KYC #${k.id}`}</p>
                  <p className="font-mono text-[9px] text-muted-foreground/50 truncate">{k.platform ?? k.category}</p>
                </div>
                <Badge
                  variant="outline"
                  className={cn(
                    "font-mono text-[9px] flex-shrink-0",
                    enrolled ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/5" : "text-muted-foreground/40 border-border/30"
                  )}
                >
                  {enrolled ? "Enrolled" : "Not enrolled"}
                </Badge>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function ActiveTab({ rows, loading }: { rows: EnrolledRow[]; loading: boolean }) {
  if (loading) return <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>;

  if (rows.length === 0) {
    return (
      <VaultSectionEmptyState
        icon={ArrowLeftRight}
        title="No KYC-entity enrollments yet"
        note='Enroll into a Binance/Bitget/Kucoin/Bybit project using "KYC Entity" (not Manual) and it will show up here.'
      />
    );
  }

  return (
    <div className="space-y-2">
      {rows.map(r => (
        <Link key={r.enrollment_id} href={`/vault/projects?project=${r.project_id}`}>
          <div className="bg-card border border-card-border rounded-lg p-3 flex items-center gap-3 hover:border-primary/40 transition-colors cursor-pointer">
            <FolderGit2 className="w-4 h-4 text-primary/70 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="font-mono text-xs font-bold truncate">{r.project_name}</p>
                <Badge variant="outline" className={cn("font-mono text-[9px]", STATUS_COLOR[r.status] ?? STATUS_COLOR.cancelled)}>
                  {r.status}
                </Badge>
              </div>
              <p className="font-mono text-[9px] text-muted-foreground/50 flex items-center gap-1.5 mt-0.5">
                <IdCard className="w-2.5 h-2.5" /> {r.kyc_platform ?? "—"} · {r.kyc_username || `#${r.kyc_entry_id}`}
                <span className="text-muted-foreground/30">·</span>
                entity: {r.vault_entry_name || `#${r.vault_entry_id}`}
              </p>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function VaultKycEnrolled() {
  const { rows, kycEntries, loading } = useEnrollmentData();

  return (
    <VaultSectionPage
      title="Enrolled"
      description="Every KYC entity, plus the exchange projects enrolled straight from one"
      icon={ArrowLeftRight}
    >
      <Tabs defaultValue="overview" className="space-y-3">
        <TabsList className="bg-muted/20">
          <TabsTrigger value="overview" className="font-mono text-xs">Overview</TabsTrigger>
          <TabsTrigger value="active" className="font-mono text-xs">Active</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab rows={rows} kycEntries={kycEntries} loading={loading} />
        </TabsContent>
        <TabsContent value="active">
          <ActiveTab rows={rows} loading={loading} />
        </TabsContent>
      </Tabs>
    </VaultSectionPage>
  );
}
