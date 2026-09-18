/**
 * finance-receipt-dialog.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-entry "Receipt" action opened from FinanceEntryList. Mints (or fetches
 * the existing) public receipt link for a ledger entry, lets the owner copy
 * it, open it, download the PDF directly, or revoke it (invalidating any
 * copy already shared). The link itself needs no login — see
 * pages/finance/receipt.tsx for what the recipient sees.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Receipt, Copy, ExternalLink, Download, Ban } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceEntry } from "@/config/finance";

export function FinanceReceiptDialog({
  open, onOpenChange, entry,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: FinanceEntry | null;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [receiptToken, setReceiptToken] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !entry) { setUrl(null); setReceiptToken(null); return; }
    setLoading(true);
    financeApi.createReceiptLink(token, entry.id)
      .then(res => { setUrl(res.url); setReceiptToken(res.token); })
      .catch((e: any) => toast({ variant: "destructive", title: "Couldn't create receipt link", description: e?.message }))
      .finally(() => setLoading(false));
  }, [open, entry, token]);

  const handleCopy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast({ title: "Link copied" });
  };

  const handleRevoke = async () => {
    if (!entry) return;
    if (!confirm("Revoke this link? Anyone holding it will lose access, and you'll need to generate a new one.")) return;
    setRevoking(true);
    try {
      await financeApi.revokeReceiptLink(token, entry.id);
      toast({ title: "Link revoked" });
      onOpenChange(false);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setRevoking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Receipt className="h-4 w-4 text-primary" /> Receipt Link</DialogTitle>
        </DialogHeader>

        {entry && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              A public link for <span className="text-foreground font-medium">{entry.title}</span>. Anyone with this
              link can view and download this receipt — no login needed. It doesn't expose anything else in your account.
            </p>

            {loading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : url ? (
              <>
                <div className="flex gap-2">
                  <Input value={url} readOnly className="font-mono text-xs" onFocus={e => e.currentTarget.select()} />
                  <Button variant="outline" size="icon" onClick={handleCopy} title="Copy link"><Copy className="h-4 w-4" /></Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => window.open(url, "_blank")}>
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Open
                  </Button>
                  {receiptToken && (
                    <Button variant="outline" size="sm" onClick={() => window.open(financeApi.publicReceiptPdfUrl(receiptToken), "_blank")}>
                      <Download className="h-3.5 w-3.5 mr-1.5" /> Download PDF
                    </Button>
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" size="sm" className="text-danger hover:text-danger" onClick={handleRevoke} disabled={!url || revoking}>
            {revoking ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Ban className="h-3.5 w-3.5 mr-1.5" />}
            Revoke link
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
