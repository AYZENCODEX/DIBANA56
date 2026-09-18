/**
 * vault-snapshot.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 15 — Encrypted Full Vault Snapshot Export.
 * Feature 15b — Stored Vault Backups.
 *
 * One-click download of a password-encrypted (.ayzenbak) backup of the
 * entire vault, and a restore flow for a previously-downloaded snapshot.
 * The password is chosen here, never sent anywhere else, and never stored —
 * losing it means the backup can't be recovered, same as every other
 * Vault credential in this app.
 *
 * Every export is now ALSO kept as a row in vault_snapshots (see
 * routes/vault-snapshot.ts) — the "Stored Backups" card below is what makes
 * this an actual backup store instead of just a download button: it lists
 * every backup the vault is holding, and lets you re-download, restore from,
 * rename, or delete any of them without needing the original downloaded file.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DatabaseBackup, Loader2, ShieldAlert, Download, Upload, CheckCircle2,
  HardDrive, Trash2, Pencil, RotateCcw, AlertTriangle, Paperclip, Check, X, Eye, PlusCircle,
  Clock, Send, Mail, Webhook, PlayCircle, XCircle, Cloud, Link2, Unlink, Boxes, Users, Coins, ShieldCheck, Inbox,
} from "lucide-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  exportVaultSnapshot, restoreVaultSnapshot, restoreStoredVaultSnapshot, snapshotFileToText,
  previewVaultSnapshotRestore, previewStoredVaultSnapshotRestore,
  listVaultSnapshots, downloadStoredSnapshot, renameVaultSnapshot, deleteVaultSnapshot,
  getVaultBackupSchedule, saveVaultBackupSchedule, runVaultBackupScheduleNow, listVaultBackupDeliveries,
  listCloudConnections, connectCloudProvider, disconnectCloudProvider,
  type SnapshotRestoreResult, type StoredSnapshot, type RestorePreview,
  type VaultBackupSchedule, type VaultBackupDeliveryRow,
  type CloudProvider, type CloudConnectionStatus,
} from "@/lib/vault-snapshot-api";

const CLOUD_PROVIDER_LABEL: Record<CloudProvider, string> = { google_drive: "Google Drive", dropbox: "Dropbox" };

const MIN_PASSWORD_LENGTH = 10;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Shared: renders a restore-preview diff (per-table add/skip counts) ────
// Used by both restore surfaces below (stored-backup dialog + file upload).
function RestoreDiffSummary({ preview }: { preview: RestorePreview }) {
  const nonEmpty = preview.tables.filter(t => t.totalInSnapshot > 0);
  if (nonEmpty.length === 0) {
    return <p className="font-mono text-xs text-muted-foreground/60 py-1">This backup doesn't contain any entries.</p>;
  }
  return (
    <div className="space-y-1.5">
      {nonEmpty.map(t => (
        <div key={t.table} className="rounded-lg border border-border/30 bg-muted/10 px-2.5 py-2">
          <div className="flex items-center justify-between font-mono text-xs">
            <span className="font-bold">{t.label}</span>
            <span className="flex items-center gap-1.5">
              {t.toAdd > 0 && (
                <Badge variant="outline" className="text-[9px] py-0 h-4 gap-1 border-emerald-500/30 text-emerald-400">
                  <PlusCircle className="w-2.5 h-2.5" /> {t.toAdd} new
                </Badge>
              )}
              {t.alreadyPresent > 0 && (
                <Badge variant="outline" className="text-[9px] py-0 h-4 text-muted-foreground/60">
                  {t.alreadyPresent} already have
                </Badge>
              )}
            </span>
          </div>
          {t.sample.length > 0 && (
            <p className="font-mono text-[10px] text-muted-foreground/60 mt-1 truncate">
              {t.sample.join(", ")}{t.toAdd > t.sample.length ? `, +${t.toAdd - t.sample.length} more` : ""}
            </p>
          )}
        </div>
      ))}
      <p className="font-mono text-[10px] text-muted-foreground/50 pt-0.5">
        {preview.totalToAdd === 0
          ? "Nothing new to add — everything in this backup already exists in your vault."
          : `${preview.totalToAdd} row(s) total will be added. Nothing existing is ever changed or removed.`}
      </p>
    </div>
  );
}

// ─── One row in the Stored Backups list ─────────────────────────────────────
function StoredSnapshotRow({
  snapshot, onChanged, onRequestDelete,
}: {
  snapshot: StoredSnapshot;
  onChanged: () => void;
  onRequestDelete: (id: number) => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(snapshot.label ?? "");
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restorePassword, setRestorePassword] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<RestorePreview | null>(null);

  function closeRestoreDialog() {
    setRestoreOpen(false);
    setRestorePassword("");
    setPreview(null);
  }

  const isAutomatic = snapshot.encryptionMode === "envelope";

  async function handlePreview() {
    if (!isAutomatic && !restorePassword) { toast({ title: "Enter the backup's password", variant: "destructive" }); return; }
    setPreviewing(true);
    try {
      setPreview(await previewStoredVaultSnapshotRestore(restorePassword, snapshot.id));
    } catch (err: any) {
      toast({ title: "Couldn't read backup", description: err?.message, variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  }

  async function saveLabel() {
    setSaving(true);
    try {
      await renameVaultSnapshot(snapshot.id, labelDraft);
      setEditing(false);
      onChanged();
    } catch (err: any) {
      toast({ title: "Couldn't rename backup", description: err?.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDownload() {
    setDownloading(true);
    try {
      await downloadStoredSnapshot(snapshot.id, snapshot.createdAt);
    } catch (err: any) {
      toast({ title: "Download failed", description: err?.message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  }

  async function handleRestore() {
    if (!isAutomatic && !restorePassword) { toast({ title: "Enter the backup's password", variant: "destructive" }); return; }
    setRestoring(true);
    try {
      const res = await restoreStoredVaultSnapshot(restorePassword, snapshot.id);
      toast({
        title: `Restored ${res.restored} ${res.restored === 1 ? "entry" : "entries"}`,
        description: res.skipped ? `${res.skipped} row(s) skipped.` : "Added as new entries — nothing existing was overwritten.",
      });
      closeRestoreDialog();
    } catch (err: any) {
      toast({ title: "Couldn't restore backup", description: err?.message, variant: "destructive" });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 border border-border/30 rounded-lg bg-card">
      <HardDrive className="w-4 h-4 text-primary/70 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={labelDraft}
              onChange={e => setLabelDraft(e.target.value)}
              placeholder="Backup name"
              className="font-mono text-xs h-7"
              autoFocus
              onKeyDown={e => { if (e.key === "Enter") saveLabel(); if (e.key === "Escape") setEditing(false); }}
            />
            <button onClick={saveLabel} disabled={saving} className="text-emerald-400 flex-shrink-0">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => { setEditing(false); setLabelDraft(snapshot.label ?? ""); }} className="text-muted-foreground/60 flex-shrink-0">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : (
          <button onClick={() => setEditing(true)} className="flex items-center gap-1.5 group min-w-0">
            <p className="font-mono text-xs font-bold truncate">
              {snapshot.label || `Backup — ${new Date(snapshot.createdAt).toLocaleString()}`}
            </p>
            <Pencil className="w-3 h-3 text-muted-foreground/0 group-hover:text-muted-foreground/50 transition-colors flex-shrink-0" />
          </button>
        )}
        <p className="font-mono text-[9px] text-muted-foreground/50 flex items-center gap-1.5 flex-wrap mt-0.5">
          <span>{new Date(snapshot.createdAt).toLocaleString()}</span>
          <span>·</span>
          <span>{formatBytes(snapshot.sizeBytes)}</span>
          <span>·</span>
          <span>{snapshot.entriesCount} entities, {snapshot.walletsCount} wallets</span>
          {!!snapshot.accountExtrasCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Notifications, referrals, subscription, support, API keys, passkeys, Polymarket trades">
              <Boxes className="w-2.5 h-2.5" /> +{snapshot.accountExtrasCount} account
            </Badge>
          )}
          {!!snapshot.teamCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Teams owned, memberships, join requests, favorites, messages, announcements, missions, team activity">
              <Users className="w-2.5 h-2.5" /> +{snapshot.teamCount} team
            </Badge>
          )}
          {!!snapshot.earningCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Pay-per-click earn links">
              <Coins className="w-2.5 h-2.5" /> +{snapshot.earningCount} earning
            </Badge>
          )}
          {!!snapshot.backupSystemCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Backup schedule config, connected cloud accounts, delivery/audit history, Vault security posture, project templates">
              <DatabaseBackup className="w-2.5 h-2.5" /> +{snapshot.backupSystemCount} backup config
            </Badge>
          )}
          {!!snapshot.emailAccountsCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Connected external IMAP/SMTP mail accounts">
              <Mail className="w-2.5 h-2.5" /> +{snapshot.emailAccountsCount} mail account
            </Badge>
          )}
          {!!snapshot.mailboxReputationCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Sender Block/Allow list, flagged/blocked outbound recipients, account sending-health status">
              <ShieldCheck className="w-2.5 h-2.5" /> +{snapshot.mailboxReputationCount} mail reputation
            </Badge>
          )}
          {!!snapshot.externalMailCount && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5" title="Synced header/body cache for connected external IMAP/SMTP mailboxes">
              <Inbox className="w-2.5 h-2.5" /> +{snapshot.externalMailCount} synced mail
            </Badge>
          )}
          {snapshot.includesAttachments && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5">
              <Paperclip className="w-2.5 h-2.5" /> attachments
            </Badge>
          )}
          {isAutomatic && (
            <Badge variant="outline" className="font-mono text-[8px] py-0 h-4 gap-0.5 text-primary/70 border-primary/30">
              <Clock className="w-2.5 h-2.5" /> automatic
            </Badge>
          )}
        </p>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Restore" onClick={() => setRestoreOpen(true)}>
          <RotateCcw className="w-3.5 h-3.5" />
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Download" disabled={downloading} onClick={handleDownload}>
          {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        </Button>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-400" title="Delete" onClick={() => onRequestDelete(snapshot.id)}>
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </div>

      <Dialog open={restoreOpen} onOpenChange={(o) => { if (!o) closeRestoreDialog(); else setRestoreOpen(true); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm flex items-center gap-2">
              <RotateCcw className="w-4 h-4 text-primary/70" /> Restore This Backup
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground/70">
            Restoring is a merge — rows already in your vault are left untouched; only what's genuinely missing gets added.
          </p>
          {!isAutomatic && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Backup password</Label>
              <Input
                type="password" value={restorePassword} autoFocus
                onChange={e => { setRestorePassword(e.target.value); setPreview(null); }}
                className="font-mono text-sm"
              />
            </div>
          )}

          {preview && <RestoreDiffSummary preview={preview} />}

          <DialogFooter>
            <Button variant="outline" size="sm" className="font-mono text-xs" onClick={closeRestoreDialog}>Cancel</Button>
            {!preview ? (
              <Button size="sm" className="font-mono text-xs gap-1.5" disabled={previewing || (!isAutomatic && !restorePassword)} onClick={handlePreview}>
                {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                Preview
              </Button>
            ) : (
              <Button size="sm" className="font-mono text-xs gap-1.5" disabled={restoring || preview.totalToAdd === 0} onClick={handleRestore}>
                {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                {preview.totalToAdd === 0 ? "Nothing to restore" : `Confirm — Add ${preview.totalToAdd}`}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function VaultSnapshot() {
  const { toast } = useToast();

  // Stored backups list
  const [snapshots, setSnapshots] = useState<StoredSnapshot[]>([]);
  const [snapshotsLoading, setSnapshotsLoading] = useState(true);
  const [maxSnapshots, setMaxSnapshots] = useState(20);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await listVaultSnapshots();
      setSnapshots(res.snapshots);
      setMaxSnapshots(res.max);
    } catch {
      // Leave existing list in place — a transient list failure shouldn't
      // block export/restore, which have their own error handling.
    } finally {
      setSnapshotsLoading(false);
    }
  }, []);

  useEffect(() => { loadSnapshots(); }, [loadSnapshots]);

  async function handleConfirmDelete() {
    if (confirmDeleteId === null) return;
    setDeleting(true);
    try {
      await deleteVaultSnapshot(confirmDeleteId);
      setConfirmDeleteId(null);
      await loadSnapshots();
    } catch (err: any) {
      toast({ title: "Couldn't delete backup", description: err?.message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  // Export
  const [exportLabel, setExportLabel] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState("");
  const [includeAttachments, setIncludeAttachments] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Restore from an uploaded file
  const [restorePassword, setRestorePassword] = useState("");
  const [restoreFileText, setRestoreFileText] = useState<string | null>(null);
  const [restoreFileName, setRestoreFileName] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [restoreResult, setRestoreResult] = useState<SnapshotRestoreResult | null>(null);
  const [restorePreviewing, setRestorePreviewing] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    if (exportPassword.length < MIN_PASSWORD_LENGTH) {
      toast({ title: "Password too short", description: `Use at least ${MIN_PASSWORD_LENGTH} characters.`, variant: "destructive" });
      return;
    }
    if (exportPassword !== exportPasswordConfirm) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      await exportVaultSnapshot(exportPassword, includeAttachments, exportLabel);
      toast({ title: "Backup stored & downloaded", description: "Kept in the vault's backup store, plus downloaded — store the password somewhere safe, AYZEN never keeps a copy of it." });
      setExportPassword("");
      setExportPasswordConfirm("");
      setExportLabel("");
      await loadSnapshots();
    } catch {
      toast({ title: "Backup failed", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  // Automatic Backups (Feature 15c)
  const DEFAULT_SCHEDULE: VaultBackupSchedule = {
    enabled: false, frequency: "weekly", dayOfWeek: 0, dayOfMonth: 1, hourOfDay: 3,
    includeAttachments: false, destination: "store", destinationEmail: null, webhookUrl: null,
    lastRunAt: null, lastRunStatus: null, lastRunError: null, nextRunAt: null,
  };
  const [schedule, setSchedule] = useState<VaultBackupSchedule>(DEFAULT_SCHEDULE);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleRunning, setScheduleRunning] = useState(false);
  const [deliveries, setDeliveries] = useState<VaultBackupDeliveryRow[]>([]);

  // Feature 15l — Google Drive / Dropbox connections.
  const [cloudConnections, setCloudConnections] = useState<CloudConnectionStatus[]>([]);
  const [cloudLoading, setCloudLoading] = useState(true);
  const [connectingProvider, setConnectingProvider] = useState<CloudProvider | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<CloudProvider | null>(null);

  const loadSchedule = useCallback(async () => {
    try {
      setSchedule(await getVaultBackupSchedule());
    } catch {
      // Leave defaults in place — the form is still usable either way.
    } finally {
      setScheduleLoading(false);
    }
  }, []);
  const loadDeliveries = useCallback(async () => {
    try {
      setDeliveries((await listVaultBackupDeliveries()).deliveries);
    } catch {
      // Non-critical — history list just stays empty.
    }
  }, []);
  const loadCloudConnections = useCallback(async () => {
    try {
      setCloudConnections((await listCloudConnections()).connections);
    } catch {
      // Non-critical — Connect buttons just render as "not connected".
    } finally {
      setCloudLoading(false);
    }
  }, []);

  useEffect(() => { loadSchedule(); loadDeliveries(); loadCloudConnections(); }, [loadSchedule, loadDeliveries, loadCloudConnections]);

  // Lands here after the Google Drive / Dropbox OAuth callback redirects
  // back into the app (routes/vault-backup-cloud.ts) — show the outcome as
  // a toast, refresh the connection list, then strip the query params so
  // a page refresh doesn't re-show the same toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("cloudConnected");
    const error = params.get("cloudError");
    if (!connected && !error) return;
    if (connected) {
      toast({ title: `${CLOUD_PROVIDER_LABEL[connected as CloudProvider] ?? connected} connected` });
      loadCloudConnections();
    } else if (error) {
      toast({ title: "Couldn't connect", description: error, variant: "destructive" });
    }
    params.delete("cloudConnected");
    params.delete("cloudError");
    const rest = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleConnectCloud(provider: CloudProvider) {
    setConnectingProvider(provider);
    try {
      await connectCloudProvider(provider); // navigates away on success
    } catch (err: any) {
      toast({ title: "Couldn't start connection", description: err?.message, variant: "destructive" });
      setConnectingProvider(null);
    }
  }

  async function handleDisconnectCloud(provider: CloudProvider) {
    setDisconnectingProvider(provider);
    try {
      await disconnectCloudProvider(provider);
      await loadCloudConnections();
      toast({ title: `${CLOUD_PROVIDER_LABEL[provider]} disconnected` });
    } catch (err: any) {
      toast({ title: "Couldn't disconnect", description: err?.message, variant: "destructive" });
    } finally {
      setDisconnectingProvider(null);
    }
  }

  function patchSchedule(patch: Partial<VaultBackupSchedule>) {
    setSchedule(s => ({ ...s, ...patch }));
  }

  async function handleSaveSchedule(patch: Partial<VaultBackupSchedule> = {}) {
    const next = { ...schedule, ...patch };
    setSchedule(next);
    setScheduleSaving(true);
    try {
      const res = await saveVaultBackupSchedule(next);
      setSchedule(s => ({ ...s, nextRunAt: res.nextRunAt }));
      toast({ title: next.enabled ? "Automatic backups enabled" : "Automatic backups saved" });
    } catch (err: any) {
      toast({ title: "Couldn't save schedule", description: err?.message, variant: "destructive" });
    } finally {
      setScheduleSaving(false);
    }
  }

  async function handleRunScheduleNow() {
    setScheduleRunning(true);
    try {
      const res = await runVaultBackupScheduleNow();
      if (res.ok) {
        toast({ title: "Automatic backup ran successfully" });
        await Promise.all([loadSnapshots(), loadSchedule(), loadDeliveries()]);
      } else {
        toast({ title: "Run failed", description: res.error, variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "Run failed", description: err?.message, variant: "destructive" });
    } finally {
      setScheduleRunning(false);
    }
  }


  async function handleFilePicked(file: File) {
    setRestoreFileText(await snapshotFileToText(file));
    setRestoreFileName(file.name);
    setRestoreResult(null);
    setRestorePreview(null);
  }

  async function handlePreviewFileRestore() {
    if (!restoreFileText) { toast({ title: "Choose a .ayzenbak file first", variant: "destructive" }); return; }
    if (!restorePassword) { toast({ title: "Enter the backup's password", variant: "destructive" }); return; }
    setRestorePreviewing(true);
    try {
      setRestorePreview(await previewVaultSnapshotRestore(restorePassword, restoreFileText));
    } catch (err: any) {
      toast({ title: "Couldn't read backup", description: err?.message, variant: "destructive" });
    } finally {
      setRestorePreviewing(false);
    }
  }

  async function handleRestore() {
    if (!restoreFileText) { toast({ title: "Choose a .ayzenbak file first", variant: "destructive" }); return; }
    if (!restorePassword) { toast({ title: "Enter the backup's password", variant: "destructive" }); return; }
    setRestoring(true);
    try {
      const res = await restoreVaultSnapshot(restorePassword, restoreFileText);
      setRestoreResult(res);
      setRestorePreview(null);
      toast({ title: `Restored ${res.restored} ${res.restored === 1 ? "entry" : "entries"}`, description: res.skipped ? `${res.skipped} row(s) skipped.` : "Added as new entries — nothing existing was overwritten." });
    } catch (err: any) {
      toast({ title: "Couldn't restore backup", description: err?.message, variant: "destructive" });
    } finally {
      setRestoring(false);
    }
  }

  return (
    <VaultSectionPage
      title="Snapshot Backup"
      description="Encrypted, full-vault backups — stored in the vault, downloadable, and restorable any time"
      icon={DatabaseBackup}
    >
      <div className="space-y-4">
        {/* ── Automatic Backups ───────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary/70" /> Automatic Backups
              {schedule.enabled && <Badge variant="outline" className="font-mono text-[9px] ml-1 text-emerald-400 border-emerald-500/30">On</Badge>}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Run a full-vault backup on a timer, without anyone present to type a password — encrypted
              server-side, stored the same way as a manual export.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center gap-2.5 font-mono text-xs cursor-pointer">
              <Switch checked={schedule.enabled} disabled={scheduleLoading || scheduleSaving} onCheckedChange={(v) => handleSaveSchedule({ enabled: v })} />
              {schedule.enabled ? "Enabled" : "Disabled"}
            </label>

            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Frequency</Label>
                <Select value={schedule.frequency} onValueChange={(v) => patchSchedule({ frequency: v as VaultBackupSchedule["frequency"] })}>
                  <SelectTrigger className="font-mono text-xs h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="daily" className="font-mono text-xs">Daily</SelectItem>
                    <SelectItem value="weekly" className="font-mono text-xs">Weekly</SelectItem>
                    <SelectItem value="monthly" className="font-mono text-xs">Monthly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {schedule.frequency === "weekly" && (
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Day of week</Label>
                  <Select value={String(schedule.dayOfWeek)} onValueChange={(v) => patchSchedule({ dayOfWeek: Number(v) })}>
                    <SelectTrigger className="font-mono text-xs h-9"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map((d, i) => (
                        <SelectItem key={i} value={String(i)} className="font-mono text-xs">{d}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {schedule.frequency === "monthly" && (
                <div className="space-y-1.5">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Day of month</Label>
                  <Input type="number" min={1} max={28} value={schedule.dayOfMonth} className="font-mono text-sm h-9"
                    onChange={(e) => patchSchedule({ dayOfMonth: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} />
                </div>
              )}
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Hour (server time)</Label>
                <Input type="number" min={0} max={23} value={schedule.hourOfDay} className="font-mono text-sm h-9"
                  onChange={(e) => patchSchedule({ hourOfDay: Math.min(23, Math.max(0, Number(e.target.value) || 0)) })} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Also deliver a copy to</Label>
              <Select value={schedule.destination} onValueChange={(v) => patchSchedule({ destination: v as VaultBackupSchedule["destination"] })}>
                <SelectTrigger className="font-mono text-xs h-9 max-w-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="store" className="font-mono text-xs">Just store it in the vault</SelectItem>
                  <SelectItem value="email" className="font-mono text-xs">Email</SelectItem>
                  <SelectItem value="webhook" className="font-mono text-xs">Webhook</SelectItem>
                  <SelectItem value="google_drive" className="font-mono text-xs">Google Drive</SelectItem>
                  <SelectItem value="dropbox" className="font-mono text-xs">Dropbox</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(schedule.destination === "google_drive" || schedule.destination === "dropbox") && (() => {
              const provider = schedule.destination as CloudProvider;
              const conn = cloudConnections.find(c => c.provider === provider);
              const label = CLOUD_PROVIDER_LABEL[provider];
              return (
                <div className="space-y-1.5 max-w-sm">
                  <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1.5">
                    <Cloud className="w-3 h-3" /> {label} connection
                  </Label>
                  {cloudLoading ? (
                    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground/60 py-1">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking connection…
                    </div>
                  ) : conn?.connected ? (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                      <span className="font-mono text-xs text-emerald-400 flex items-center gap-1.5 min-w-0">
                        <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">Connected{conn.accountLabel ? ` as ${conn.accountLabel}` : ""}</span>
                      </span>
                      <Button
                        variant="ghost" size="sm" className="h-7 font-mono text-[10px] gap-1 text-red-400 hover:text-red-400 flex-shrink-0"
                        disabled={disconnectingProvider === provider} onClick={() => handleDisconnectCloud(provider)}
                      >
                        {disconnectingProvider === provider ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink className="w-3 h-3" />}
                        Disconnect
                      </Button>
                    </div>
                  ) : conn && !conn.configured ? (
                    <p className="font-mono text-[10px] text-amber-400 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                      {label} isn't set up on this server yet — the OAuth client credentials for it haven't been configured.
                    </p>
                  ) : (
                    <Button
                      variant="outline" size="sm" className="font-mono text-xs gap-1.5"
                      disabled={connectingProvider === provider} onClick={() => handleConnectCloud(provider)}
                    >
                      {connectingProvider === provider ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                      Connect {label}
                    </Button>
                  )}
                  <p className="font-mono text-[10px] text-muted-foreground/50">
                    Uploads the encrypted backup into your own {label} account — AYZEN never sees its contents unencrypted.
                  </p>
                </div>
              );
            })()}

            {schedule.destination === "email" && (
              <div className="space-y-1.5 max-w-xs">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1.5">
                  <Mail className="w-3 h-3" /> Destination email (blank = account email)
                </Label>
                <Input type="email" value={schedule.destinationEmail ?? ""} className="font-mono text-sm"
                  onChange={(e) => patchSchedule({ destinationEmail: e.target.value || null })} />
              </div>
            )}
            {schedule.destination === "webhook" && (
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1.5">
                  <Webhook className="w-3 h-3" /> Webhook URL
                </Label>
                <Input type="url" value={schedule.webhookUrl ?? ""} className="font-mono text-sm max-w-md" placeholder="https://..."
                  onChange={(e) => patchSchedule({ webhookUrl: e.target.value || null })} />
                <p className="font-mono text-[10px] text-muted-foreground/60">
                  {schedule.hasWebhookSecret
                    ? "A signing secret was generated on first save — payloads are HMAC-SHA256 signed via X-Ayzen-Signature."
                    : "A signing secret will be generated the first time this is saved."}
                </p>
              </div>
            )}

            <label className="flex items-center gap-2 font-mono text-xs text-muted-foreground/70 cursor-pointer">
              <Checkbox checked={schedule.includeAttachments} onCheckedChange={(v) => patchSchedule({ includeAttachments: !!v })} />
              Include file attachments (can make the backup large)
            </label>

            {(schedule.lastRunAt || schedule.nextRunAt || schedule.lastRunStatus === "missed") && (
              <div className="rounded-lg border border-border/30 bg-muted/10 p-3 space-y-1 font-mono text-[11px] text-muted-foreground">
                {schedule.lastRunStatus === "missed" ? (
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    Last scheduled run was missed
                    {schedule.lastRunError && <span> — {schedule.lastRunError}</span>}
                  </div>
                ) : schedule.lastRunAt && (
                  <div className="flex items-center gap-1.5">
                    {schedule.lastRunStatus === "failed" ? <XCircle className="w-3.5 h-3.5 text-red-400" /> : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                    Last run {new Date(schedule.lastRunAt).toLocaleString()}
                    {schedule.lastRunStatus === "failed" && schedule.lastRunError && <span className="text-red-400"> — {schedule.lastRunError}</span>}
                  </div>
                )}
                {schedule.nextRunAt && <div>Next run {new Date(schedule.nextRunAt).toLocaleString()}</div>}
              </div>
            )}

            {deliveries.length > 0 && (
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Recent deliveries</Label>
                <div className="space-y-1">
                  {deliveries.slice(0, 5).map(d => (
                    <div key={d.id} className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                      {d.status === "success" ? <CheckCircle2 className="w-3 h-3 text-emerald-400 flex-shrink-0" /> : <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />}
                      {d.destination === "email" ? <Mail className="w-3 h-3 flex-shrink-0" />
                        : d.destination === "webhook" ? <Webhook className="w-3 h-3 flex-shrink-0" />
                        : <Cloud className="w-3 h-3 flex-shrink-0" />}
                      <span className="truncate">{d.target ?? d.destination}</span>
                      <span className="text-muted-foreground/50">{new Date(d.createdAt).toLocaleString()}</span>
                      {d.status === "failed" && d.error && <span className="text-red-400 truncate">— {d.error}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm" className="font-mono text-xs gap-1.5" disabled={scheduleSaving} onClick={() => handleSaveSchedule()}>
              {scheduleSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              Save
            </Button>
            <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" disabled={scheduleRunning} onClick={handleRunScheduleNow}>
              {scheduleRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlayCircle className="w-3.5 h-3.5" />}
              Run Now
            </Button>
          </CardFooter>
        </Card>

        {/* ── Stored Backups ──────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-primary/70" /> Stored Backups
              {snapshots.length > 0 && (
                <Badge variant="outline" className="font-mono text-[9px] ml-1">{snapshots.length}/{maxSnapshots}</Badge>
              )}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Every backup you create below is kept here too — the oldest is dropped automatically once you pass {maxSnapshots}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {snapshotsLoading ? (
              <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground/60 py-4">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading backups…
              </div>
            ) : snapshots.length === 0 ? (
              <VaultSectionEmptyState
                icon={HardDrive}
                title="No backups stored yet"
                note="Create one below — it'll show up here, ready to re-download or restore any time."
              />
            ) : (
              <div className="space-y-2">
                {snapshots.map(s => (
                  <StoredSnapshotRow key={s.id} snapshot={s} onChanged={loadSnapshots} onRequestDelete={setConfirmDeleteId} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── Create a backup ────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
              <Download className="w-4 h-4 text-primary/70" /> Create a Backup
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Covers Vault entities and Wallets (Local/KYC/Game are included for reference).
              Choose a password below — AES-256-GCM encrypted, never stored by AYZEN.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Name (optional)</Label>
              <Input value={exportLabel} onChange={e => setExportLabel(e.target.value)} className="font-mono text-sm" placeholder="e.g. Before wallet migration" />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Backup password</Label>
                <Input type="password" value={exportPassword} onChange={e => setExportPassword(e.target.value)} className="font-mono text-sm" placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`} />
              </div>
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Confirm password</Label>
                <Input type="password" value={exportPasswordConfirm} onChange={e => setExportPasswordConfirm(e.target.value)} className="font-mono text-sm" />
              </div>
            </div>
            <label className="flex items-center gap-2 font-mono text-xs text-muted-foreground/70 cursor-pointer">
              <Checkbox checked={includeAttachments} onCheckedChange={(v) => setIncludeAttachments(!!v)} />
              Include file attachments (can make the backup large)
            </label>
            <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] font-mono text-amber-400">
                If you lose this password, the backup cannot be recovered — AYZEN keeps no copy of it, even though the encrypted file is stored for you above.
              </p>
            </div>
          </CardContent>
          <CardFooter>
            <Button size="sm" className="font-mono text-xs gap-1.5" disabled={exporting} onClick={handleExport}>
              {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              Create Backup
            </Button>
          </CardFooter>
        </Card>

        {/* ── Restore from an uploaded file ──────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
              <Upload className="w-4 h-4 text-primary/70" /> Restore From a File
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              Have an older .ayzenbak file that isn't in the list above? Restore straight from it here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".ayzenbak,text/plain"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFilePicked(f); }}
            />
            <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5" onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-3.5 h-3.5" /> {restoreFileName ?? "Choose .ayzenbak file"}
            </Button>
            {restoreFileText && (
              <div className="space-y-1.5 max-w-xs">
                <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground/60">Backup password</Label>
                <Input
                  type="password" value={restorePassword} className="font-mono text-sm"
                  onChange={e => { setRestorePassword(e.target.value); setRestorePreview(null); }}
                />
              </div>
            )}
            {restorePreview && <RestoreDiffSummary preview={restorePreview} />}
            {restoreResult && (
              <div className="rounded-lg border border-border/30 bg-muted/10 p-3 flex items-center gap-2 font-mono text-xs">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                {restoreResult.restored} restored{restoreResult.skipped ? `, ${restoreResult.skipped} skipped` : ""}
              </div>
            )}
          </CardContent>
          <CardFooter className="gap-2">
            {!restorePreview ? (
              <Button size="sm" className="font-mono text-xs gap-1.5" disabled={restorePreviewing || !restoreFileText || !restorePassword} onClick={handlePreviewFileRestore}>
                {restorePreviewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                Preview
              </Button>
            ) : (
              <Button size="sm" className="font-mono text-xs gap-1.5" disabled={restoring || restorePreview.totalToAdd === 0} onClick={handleRestore}>
                {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                {restorePreview.totalToAdd === 0 ? "Nothing to restore" : `Confirm — Add ${restorePreview.totalToAdd}`}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>

      {/* Delete a stored backup — confirm */}
      <Dialog open={confirmDeleteId !== null} onOpenChange={(o) => !o && setConfirmDeleteId(null)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> Delete This Backup?
            </DialogTitle>
          </DialogHeader>
          <p className="font-mono text-xs text-muted-foreground py-2">
            This backup will be permanently removed from the vault's backup store. This cannot be undone —
            make sure you don't need it before deleting.
          </p>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDeleteId(null)} className="font-mono text-xs">Cancel</Button>
            <Button variant="destructive" size="sm" onClick={handleConfirmDelete} disabled={deleting} className="font-mono text-xs">
              {deleting && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
              Delete Forever
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </VaultSectionPage>
  );
}
