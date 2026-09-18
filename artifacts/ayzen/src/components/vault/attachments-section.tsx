/**
 * components/vault/attachments-section.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * "Attachments" section for vault-entity-detail.tsx — encrypted file storage
 * per entity (ID scan, contract, screenshot, etc). Backed by
 * routes/vault-attachments.ts. Same self-contained-section pattern as
 * linked-entities-section.tsx: owns its own data fetching, renders a small
 * card list, and is dropped into the entity detail page with one line.
 */
import { useEffect, useRef, useState } from "react";
import { Paperclip, Upload, Download, Trash2, Loader2, FileText, Image as ImageIcon, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  listVaultAttachments, uploadVaultAttachment, downloadVaultAttachment, deleteVaultAttachment,
  type VaultAttachmentMeta, type AttachmentCategory,
} from "@/lib/vault-attachments-api";

const CATEGORY_LABEL: Record<AttachmentCategory, string> = {
  id_scan: "ID Scan",
  contract: "Contract",
  screenshot: "Screenshot",
  other: "Other",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return FileText;
  return FileIcon;
}

export function AttachmentsSection({ entityId }: { entityId: number }) {
  const { toast } = useToast();
  const [items, setItems] = useState<VaultAttachmentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [category, setCategory] = useState<AttachmentCategory>("other");
  const [busyId, setBusyId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function refresh() {
    setLoading(true);
    listVaultAttachments(entityId)
      .then(r => setItems(r.items))
      .catch(() => toast({ title: "Couldn't load attachments", variant: "destructive" }))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, [entityId]);

  async function handleFilePicked(file: File) {
    setUploading(true);
    try {
      await uploadVaultAttachment(entityId, file, { category });
      toast({ title: "File uploaded", description: file.name });
      refresh();
    } catch (err: any) {
      toast({ title: "Upload failed", description: err?.message, variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDownload(id: number) {
    setBusyId(id);
    try {
      await downloadVaultAttachment(entityId, id);
    } catch {
      toast({ title: "Download failed", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: number) {
    setBusyId(id);
    try {
      await deleteVaultAttachment(entityId, id);
      toast({ title: "Attachment deleted" });
      setItems(prev => prev.filter(i => i.id !== id));
    } catch {
      toast({ title: "Couldn't delete attachment", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Paperclip className="w-4 h-4 text-primary/70" />
        <h3 className="font-mono text-xs uppercase tracking-widest text-muted-foreground/70">Attachments</h3>
      </div>

      {loading ? (
        <div className="flex justify-center py-8"><Loader2 className="w-4 h-4 text-primary animate-spin" /></div>
      ) : items.length === 0 ? (
        <p className="font-mono text-[11px] text-muted-foreground/45">No files attached yet — ID scans, contracts, or screenshots go here, encrypted at rest.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map(a => {
            const Icon = iconFor(a.mimeType);
            return (
              <div key={a.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/30 bg-card">
                <div className="min-w-0 flex items-center gap-2.5">
                  <Icon className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="font-mono text-xs font-bold truncate">{a.fileName}</p>
                    <p className="font-mono text-[9px] text-muted-foreground/45">
                      {CATEGORY_LABEL[a.category]} · {formatBytes(a.fileSizeBytes)} · {new Date(a.uploadedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <button onClick={() => handleDownload(a.id)} disabled={busyId === a.id} className="text-muted-foreground/50 hover:text-primary transition-colors">
                    {busyId === a.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
                  </button>
                  <button onClick={() => handleDelete(a.id)} disabled={busyId === a.id} className="text-muted-foreground/50 hover:text-red-400 transition-colors">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Select value={category} onValueChange={(v) => setCategory(v as AttachmentCategory)}>
          <SelectTrigger className="w-36 font-mono text-xs h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(CATEGORY_LABEL) as AttachmentCategory[]).map(c => (
              <SelectItem key={c} value={c} className="font-mono text-xs">{CATEGORY_LABEL[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFilePicked(f); }}
        />
        <Button variant="outline" size="sm" className="font-mono text-xs gap-1.5 h-8" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
          Upload File
        </Button>
      </div>
    </div>
  );
}
