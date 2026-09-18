/**
 * vault-trash.tsx
 * ─────────────────────────────────────────────
 * Vault → Other → Trash.
 *
 * DELETE /vault/:id soft-deletes (sets deleted_at) instead of removing the
 * row — see routes/vault.ts. This page lists everything currently in that
 * state, lets the owner restore an entry, permanently purge a single entry,
 * or empty the whole bin. Anything left untouched is hard-deleted
 * automatically after VAULT_TRASH_RETENTION_DAYS (default 30) by the
 * lib/vault-trash-cron.ts sweep — the countdown shown here (purgeAt) is
 * exactly when that happens.
 */
import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { Trash2, Loader2, RotateCcw, X, AlertTriangle, Clock } from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

interface TrashedEntry {
  id: number;
  projectName: string;
  username: string | null;
  category: string | null;
  entitySerial: string | null;
  deletedAt: string;
  purgeAt: string | null;
}

// ── Countdown helper — "12d left" / "3h left" / "Purging soon" ────────────
function daysLeft(purgeAt: string | null): { label: string; urgent: boolean } {
  if (!purgeAt) return { label: "", urgent: false };
  const ms = new Date(purgeAt).getTime() - Date.now();
  if (ms <= 0) return { label: "Purging soon", urgent: true };
  const days = Math.floor(ms / 86400000);
  if (days >= 1) return { label: `${days}d left`, urgent: days <= 3 };
  const hours = Math.max(1, Math.floor(ms / 3600000));
  return { label: `${hours}h left`, urgent: true };
}

function TrashRow({
  entry, onRestore, onPurge, restoring, purging,
}: {
  entry: TrashedEntry;
  onRestore: () => void;
  onPurge: () => void;
  restoring: boolean;
  purging: boolean;
}) {
  const countdown = daysLeft(entry.purgeAt);
  return (
    <div className="flex items-center gap-3 bg-card border border-border/40 rounded-lg px-3 py-2.5">
      <div className="w-6 h-6 rounded-md bg-red-400/10 border border-red-400/20 flex items-center justify-center flex-shrink-0">
        <Trash2 className="w-3 h-3 text-red-400" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-mono text-xs font-bold text-foreground truncate">
          {entry.projectName || entry.username || `Entity #${entry.id}`}
        </p>
        <p className="font-mono text-[9px] text-muted-foreground/50 truncate">
          {entry.entitySerial ?? entry.category ?? `#${entry.id}`} · Trashed {new Date(entry.deletedAt).toLocaleDateString()}
        </p>
      </div>
      <Badge
        variant="outline"
        className={cn(
          "font-mono text-[8px] uppercase tracking-wider px-1.5 flex-shrink-0 gap-1",
          countdown.urgent ? "text-red-400 border-red-400/30 bg-red-400/5" : "text-muted-foreground/60 border-border/40"
        )}
      >
        <Clock className="w-2.5 h-2.5" /> {countdown.label}
      </Badge>
      <Button
        variant="outline" size="sm"
        onClick={onRestore} disabled={restoring || purging}
        className="font-mono text-[10px] h-7 gap-1 flex-shrink-0"
      >
        {restoring ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
        Restore
      </Button>
      <Button
        variant="ghost" size="sm"
        onClick={onPurge} disabled={restoring || purging}
        className="font-mono text-[10px] h-7 w-7 p-0 flex-shrink-0 text-red-400/70 hover:text-red-400 hover:bg-red-400/10"
        title="Delete forever"
      >
        {purging ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3.5 h-3.5" />}
      </Button>
    </div>
  );
}

export default function VaultTrash() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [entries, setEntries] = useState<TrashedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingRestoreId, setPendingRestoreId] = useState<number | null>(null);
  const [pendingPurgeId, setPendingPurgeId] = useState<number | null>(null);
  const [confirmPurgeId, setConfirmPurgeId] = useState<number | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await customFetch<TrashedEntry[]>("/api/vault/trash");
      setEntries(Array.isArray(data) ? data : []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRestore = async (id: number) => {
    setPendingRestoreId(id);
    try {
      await customFetch(`/api/vault/${id}/restore`, { method: "POST" });
      toast({ title: "Entity restored", description: "It's back under Vault → Entity." });
      setEntries(prev => prev.filter(e => e.id !== id));
    } catch (err: any) {
      toast({ variant: "destructive", title: "Restore failed", description: err?.message });
    } finally {
      setPendingRestoreId(null);
    }
  };

  const handlePurge = async (id: number) => {
    setConfirmPurgeId(null);
    setPendingPurgeId(id);
    try {
      await customFetch(`/api/vault/trash/${id}`, { method: "DELETE" });
      toast({ title: "Permanently deleted" });
      setEntries(prev => prev.filter(e => e.id !== id));
    } catch (err: any) {
      toast({ variant: "destructive", title: "Delete failed", description: err?.message });
    } finally {
      setPendingPurgeId(null);
    }
  };

  const handleEmptyTrash = async () => {
    setEmptyingTrash(true);
    try {
      const res = await customFetch<{ count: number }>("/api/vault/trash", { method: "DELETE" });
      toast({ title: `Trash emptied`, description: `${res?.count ?? entries.length} entities permanently deleted.` });
      setEntries([]);
      setEmptyTrashOpen(false);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to empty trash", description: err?.message });
    } finally {
      setEmptyingTrash(false);
    }
  };

  const confirmPurgeEntry = entries.find(e => e.id === confirmPurgeId) ?? null;

  return (
    <VaultSectionPage
      title="Trash"
      description="Deleted entities — restore within 30 days or they're purged automatically"
      icon={Trash2}
      headerExtra={entries.length > 0 ? (
        <Button
          variant="outline" size="sm"
          onClick={() => setEmptyTrashOpen(true)}
          className="font-mono text-[10px] gap-1.5 text-red-400 border-red-400/30 hover:bg-red-400/10"
        >
          <Trash2 className="w-3 h-3" /> Empty Trash
        </Button>
      ) : undefined}
    >
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      ) : entries.length === 0 ? (
        <VaultSectionEmptyState
          icon={Trash2}
          title="Trash is empty"
          note="Delete an entity from Vault → Entity and it'll land here, recoverable for 30 days before it's permanently purged."
        />
      ) : (
        <div className="space-y-1.5">
          {entries.map(entry => (
            <TrashRow
              key={entry.id}
              entry={entry}
              restoring={pendingRestoreId === entry.id}
              purging={pendingPurgeId === entry.id}
              onRestore={() => handleRestore(entry.id)}
              onPurge={() => setConfirmPurgeId(entry.id)}
            />
          ))}
        </div>
      )}

      {/* Purge one — confirm */}
      <Dialog open={confirmPurgeId !== null} onOpenChange={(o) => !o && setConfirmPurgeId(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Delete Forever?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">
            <strong>{confirmPurgeEntry?.projectName || confirmPurgeEntry?.username || `Entity #${confirmPurgeId}`}</strong> and
            all its credentials will be permanently deleted right now. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmPurgeId(null)} className="font-mono text-xs">Cancel</Button>
            <Button
              variant="destructive" size="sm"
              onClick={() => confirmPurgeId !== null && handlePurge(confirmPurgeId)}
              disabled={pendingPurgeId !== null}
              className="font-mono text-xs"
            >
              {pendingPurgeId !== null && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Delete Forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Empty whole trash — confirm */}
      <Dialog open={emptyTrashOpen} onOpenChange={(o) => !o && setEmptyTrashOpen(false)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Empty Trash?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">
            All {entries.length} {entries.length === 1 ? "entity" : "entities"} in the trash will be permanently deleted right now. This cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEmptyTrashOpen(false)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={handleEmptyTrash} disabled={emptyingTrash} className="font-mono text-xs">
              {emptyingTrash && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Empty Trash
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </VaultSectionPage>
  );
}
