import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Share2, Loader2, Trash2, ArrowUpRight, ArrowDownLeft } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { customFetch } from "@workspace/api-client-react";
import type { VaultEntityType } from "./share-entity-dialog";

interface SentShare {
  id: number;
  entityType: string;
  entityId: number;
  entityLabel: string;
  sharedWithUsername: string;
  permission: "view" | "edit";
  fieldPermissions: Record<string, "view" | "edit"> | null;
  isActive: boolean;
  createdAt: string;
}

interface ReceivedShare {
  id: number;
  entityType: string;
  entityId: number;
  entityLabel: string;
  ownerUsername: string;
  permission: "view" | "edit";
  fieldPermissions: Record<string, "view" | "edit"> | null;
  isActive: boolean;
  createdAt: string;
}

/**
 * Lets the owner see everything they've shared out for a given vault type
 * and flip access on/off per recipient — that's the "unshare = turn
 * permission off" action. The Received tab shows what other people have
 * shared with the current user; ownership of any of these items never
 * changes hands either way.
 */
export function ManageSharesDialog({ open, onClose, entityType }: {
  open: boolean; onClose: () => void; entityType: VaultEntityType;
}) {
  const [tab, setTab] = useState<"sent" | "received">("sent");
  const [sent, setSent] = useState<SentShare[]>([]);
  const [received, setReceived] = useState<ReceivedShare[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const { toast } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [sentData, receivedData] = await Promise.all([
        customFetch<SentShare[]>(`/api/vault-shares/sent?entityType=${entityType}`),
        customFetch<ReceivedShare[]>(`/api/vault-shares/received?entityType=${entityType}&activeOnly=false`),
      ]);
      setSent(Array.isArray(sentData) ? sentData : []);
      setReceived(Array.isArray(receivedData) ? receivedData : []);
    } catch {
      toast({ variant: "destructive", title: "Failed to load shares" });
    } finally {
      setLoading(false);
    }
  }, [entityType, toast]);

  useEffect(() => { if (open) load(); }, [open, load]);

  const toggleActive = async (share: SentShare, next: boolean) => {
    setBusyId(share.id);
    setSent(prev => prev.map(s => s.id === share.id ? { ...s, isActive: next } : s));
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ isActive: next }) });
      toast({ title: next ? "Access turned on" : "Access turned off", description: `${share.sharedWithUsername} — ${share.entityLabel}` });
    } catch {
      setSent(prev => prev.map(s => s.id === share.id ? { ...s, isActive: !next } : s)); // revert
      toast({ variant: "destructive", title: "Failed to update" });
    } finally {
      setBusyId(null);
    }
  };

  const removeShare = async (share: SentShare) => {
    setBusyId(share.id);
    try {
      await customFetch(`/api/vault-shares/${share.id}`, { method: "DELETE" });
      setSent(prev => prev.filter(s => s.id !== share.id));
      toast({ title: "Share removed" });
    } catch {
      toast({ variant: "destructive", title: "Failed to remove" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <Share2 className="w-4 h-4 text-primary" /> Shares
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            Manage who has access to your {entityType} items — or see what's been shared with you.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v: any) => setTab(v)} className="flex-1 flex flex-col min-h-0">
          <TabsList className="w-full">
            <TabsTrigger value="sent" className="flex-1 font-mono text-xs gap-1.5">
              <ArrowUpRight className="w-3 h-3" /> Shared by me ({sent.length})
            </TabsTrigger>
            <TabsTrigger value="received" className="flex-1 font-mono text-xs gap-1.5">
              <ArrowDownLeft className="w-3 h-3" /> Shared with me ({received.filter(r => r.isActive).length})
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto mt-3 -mx-1 px-1">
            {loading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 text-primary animate-spin" />
              </div>
            ) : (
              <>
                <TabsContent value="sent" className="space-y-2 mt-0">
                  {sent.length === 0 ? (
                    <p className="font-mono text-xs text-muted-foreground/50 text-center py-8">You haven't shared any {entityType} items yet.</p>
                  ) : sent.map(s => (
                    <div key={s.id} className="flex items-center gap-2.5 rounded-lg border border-card-border bg-card px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs font-semibold truncate">{s.entityLabel}</p>
                        <p className="font-mono text-[10px] text-muted-foreground/60 truncate">
                          with <span className="text-foreground/80">{s.sharedWithUsername}</span>
                        </p>
                      </div>
                      {s.fieldPermissions ? (
                        <Badge variant="outline" className="font-mono text-[9px] uppercase px-1.5 flex-shrink-0" title={Object.keys(s.fieldPermissions).join(", ")}>
                          {Object.keys(s.fieldPermissions).length} field{Object.keys(s.fieldPermissions).length === 1 ? "" : "s"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-mono text-[9px] uppercase px-1.5 flex-shrink-0">{s.permission}</Badge>
                      )}
                      <Switch
                        checked={s.isActive}
                        disabled={busyId === s.id}
                        onCheckedChange={(v) => toggleActive(s, v)}
                      />
                      <button
                        onClick={() => removeShare(s)}
                        disabled={busyId === s.id}
                        className="p-1 rounded text-muted-foreground/40 hover:text-red-400 transition-colors flex-shrink-0"
                        title="Remove share"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </TabsContent>

                <TabsContent value="received" className="space-y-2 mt-0">
                  {received.filter(r => r.isActive).length === 0 ? (
                    <p className="font-mono text-xs text-muted-foreground/50 text-center py-8">No one has shared a {entityType} item with you.</p>
                  ) : received.filter(r => r.isActive).map(r => (
                    <div key={r.id} className={cn("flex items-center gap-2.5 rounded-lg border border-card-border bg-card px-3 py-2.5")}>
                      <div className="min-w-0 flex-1">
                        <p className="font-mono text-xs font-semibold truncate">{r.entityLabel}</p>
                        <p className="font-mono text-[10px] text-muted-foreground/60 truncate">
                          from <span className="text-foreground/80">{r.ownerUsername}</span>
                        </p>
                      </div>
                      {r.fieldPermissions ? (
                        <Badge variant="outline" className="font-mono text-[9px] uppercase px-1.5 flex-shrink-0" title={Object.keys(r.fieldPermissions).join(", ")}>
                          {Object.keys(r.fieldPermissions).length} field{Object.keys(r.fieldPermissions).length === 1 ? "" : "s"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="font-mono text-[9px] uppercase px-1.5 flex-shrink-0">{r.permission}</Badge>
                      )}
                    </div>
                  ))}
                </TabsContent>
              </>
            )}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
