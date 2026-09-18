/**
 * components/finance/finance-attachments.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * "Receipts" section dropped into finance-entry-dialog.tsx once an entry
 * exists (upload needs an entryId). Self-contained: owns its own fetch,
 * upload, view, and delete — same pattern as vault/attachments-section.tsx.
 * Backed by routes/finance.ts's /finance/entries/:id/attachments/* routes.
 */
import { useEffect, useRef, useState } from "react";
import { Paperclip, Upload, Eye, Trash2, Loader2, FileText, Image as ImageIcon, File as FileIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { financeApi } from "@/lib/finance-api";
import type { FinanceAttachment } from "@/config/finance";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function FinanceAttachments({ entryId }: { entryId: number }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [items, setItems] = useState<FinanceAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function refresh() {
    setLoading(true);
    financeApi.listAttachments(token, entryId)
      .then(setItems)
      .catch(() => toast({ variant: "destructive", title: "Couldn't load receipts" }))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, [entryId]);

  async function handleFilePicked(file: File) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast({ variant: "destructive", title: "File too large", description: "Receipts are limited to 8MB." });
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      const dataBase64 = await fileToBase64(file);
      await financeApi.uploadAttachment(token, entryId, {
        fileName: file.name, mimeType: file.type || "application/octet-stream", dataBase64,
      });
      toast({ title: "Receipt attached", description: file.name });
      refresh();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Upload failed", description: err?.message });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleView(a: FinanceAttachment) {
    setBusyId(a.id);
    try {
      await financeApi.viewAttachment(token, entryId, a.id, a.fileName);
    } catch {
      toast({ variant: "destructive", title: "Couldn't open receipt" });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(id: number) {
    setBusyId(id);
    try {
      await financeApi.deleteAttachment(token, entryId, id);
      setItems(prev => prev.filter(i => i.id !== id));
    } catch {
      toast({ variant: "destructive", title: "Couldn't delete receipt" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" /> Receipts / Attachments
        </div>
        <input ref={fileInputRef} type="file" accept="image/*,application/pdf" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFilePicked(f); }} />
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs gap-1" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
          Attach
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No receipts attached yet.</p>
      ) : (
        <div className="space-y-1">
          {items.map(a => {
            const Icon = iconFor(a.mimeType);
            return (
              <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs">
                <div className="min-w-0 flex items-center gap-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.fileName}</p>
                    <p className="text-[10px] text-muted-foreground">{formatBytes(a.fileSizeBytes)} · {new Date(a.uploadedAt).toLocaleDateString()}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button type="button" onClick={() => handleView(a)} disabled={busyId === a.id} className="text-muted-foreground hover:text-primary transition-colors p-1">
                    {busyId === a.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                  <button type="button" onClick={() => handleDelete(a.id)} disabled={busyId === a.id} className="text-muted-foreground hover:text-red-400 transition-colors p-1">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
