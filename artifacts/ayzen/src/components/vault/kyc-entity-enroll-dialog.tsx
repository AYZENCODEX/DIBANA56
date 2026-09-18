/**
 * kyc-entity-enroll-dialog.tsx
 * ─────────────────────────────────────────────
 * "No form" enroll path for Exchange-platform projects (Binance/Bitget/
 * Kucoin/Bybit) — see project-detail.tsx. Instead of filling the Main/
 * Info/Recovery account form (EnrollDialog in project-entities.tsx), the
 * user picks a Vault Entity to enroll AND an existing KYC Entity of the
 * matching platform (category='Exchange', platform=<platform>, unused).
 * The server (POST /projects/:id/enroll with kycEntryId) auto-builds the
 * enrollment's account_data snapshot straight from that KYC Entity's own
 * fields — nothing to type here.
 */
import { useState, useEffect, useCallback } from "react";
import { useListVaultEntries, customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { IdCard, Loader2, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface KycEntry {
  id: number;
  username: string | null;
  platform: string | null;
  name: string | null;
}

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

function useAuthedFetch() {
  const token = typeof window !== "undefined" ? localStorage.getItem("ayzen_token") ?? "" : "";
  return useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "Request failed");
    return data;
  }, [token]);
}

export function KycEntityEnrollDialog({
  open, onOpenChange, projectId, platform, alreadyEnrolledIds, onEnrolled,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectId: number;
  /** Exchange platform this project belongs to — Binance/Bitget/Kucoin/Bybit. */
  platform: string;
  alreadyEnrolledIds: Set<number>;
  onEnrolled: () => void;
}) {
  const authedFetch = useAuthedFetch();
  const { toast } = useToast();
  const { data: vaultEntries } = useListVaultEntries();
  const [kycEntries, setKycEntries] = useState<KycEntry[]>([]);
  const [loadingKyc, setLoadingKyc] = useState(true);
  const [vaultEntryId, setVaultEntryId] = useState<number | null>(null);
  const [kycEntryId, setKycEntryId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadKyc = useCallback(async () => {
    setLoadingKyc(true);
    try {
      const rows = await customFetch<KycEntry[]>(
        `/api/kyc-entries?category=Exchange&platform=${encodeURIComponent(platform)}&unused=true`
      );
      setKycEntries(Array.isArray(rows) ? rows : []);
    } catch {
      setKycEntries([]);
    } finally {
      setLoadingKyc(false);
    }
  }, [platform]);

  useEffect(() => {
    if (open) { loadKyc(); } else { setVaultEntryId(null); setKycEntryId(null); }
  }, [open, loadKyc]);

  const entities = ((vaultEntries as any[]) ?? []).filter(e => !alreadyEnrolledIds.has(e.id));

  const handleSubmit = async () => {
    if (!vaultEntryId) { toast({ variant: "destructive", title: "Pick an entity to enroll" }); return; }
    if (!kycEntryId) { toast({ variant: "destructive", title: `Pick a ${platform} KYC entity` }); return; }
    setSubmitting(true);
    try {
      await authedFetch(`/projects/${projectId}/enroll`, {
        method: "POST",
        body: JSON.stringify({ vaultEntryId, kycEntryId }),
      });
      toast({ title: "Entity enrolled via KYC entity" });
      onEnrolled();
      onOpenChange(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Enroll failed", description: err?.message });
    } finally { setSubmitting(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-hidden flex flex-col p-0">
        <DialogHeader className="px-5 pt-5 pb-3 flex-shrink-0 border-b border-card-border">
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <IdCard className="w-4 h-4 text-primary" /> Pick {platform} KYC Entity
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5">
              <Users className="w-3 h-3" /> Entity to enroll
            </p>
            <div className="max-h-32 overflow-y-auto border border-border/30 rounded-lg divide-y divide-border/20">
              {entities.length === 0 && (
                <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-4">No unenrolled entities</p>
              )}
              {entities.map(e => (
                <button
                  key={e.id}
                  onClick={() => setVaultEntryId(e.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/10 transition-colors",
                    vaultEntryId === e.id && "bg-primary/10"
                  )}
                >
                  <span className="font-mono text-xs flex-1 truncate">{e.projectName}</span>
                  {vaultEntryId === e.id && <Badge variant="outline" className="font-mono text-[9px] border-primary/40 text-primary">selected</Badge>}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/50 flex items-center gap-1.5">
              <IdCard className="w-3 h-3" /> {platform} KYC entity
            </p>
            {loadingKyc ? (
              <div className="flex items-center justify-center py-6"><Loader2 className="w-4 h-4 text-primary animate-spin" /></div>
            ) : (
              <div className="max-h-40 overflow-y-auto border border-border/30 rounded-lg divide-y divide-border/20">
                {kycEntries.length === 0 && (
                  <p className="font-mono text-[10px] text-muted-foreground/50 text-center py-4">
                    No unused {platform} KYC entities — add one, or use Manual Enroll instead.
                  </p>
                )}
                {kycEntries.map(k => (
                  <button
                    key={k.id}
                    onClick={() => setKycEntryId(k.id)}
                    className={cn(
                      "w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/10 transition-colors",
                      kycEntryId === k.id && "bg-primary/10"
                    )}
                  >
                    <span className="font-mono text-xs flex-1 truncate">{k.username || k.name || `#${k.id}`}</span>
                    {kycEntryId === k.id && <Badge variant="outline" className="font-mono text-[9px] border-primary/40 text-primary">selected</Badge>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="font-mono text-[9px] text-muted-foreground/40">
            The enrollment's account snapshot is auto-filled from this KYC entity — no form to fill.
          </p>
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
