/**
 * components/receipt-link-dialog.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic "Share Receipt" dialog — mints (or fetches) a public receipt link
 * for whatever item is passed in, lets the owner copy/open/download-PDF/
 * revoke it. Same UX as finance-receipt-dialog.tsx but parametrized so
 * Local Entity, Vault Entity, and Project P&L pages can all reuse it
 * instead of three near-identical copies.
 */
import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Sparkles, Copy, ExternalLink, Download, Ban, Mail } from "lucide-react";
import type { ReceiptLink } from "@/lib/receipt-api";

export interface ReceiptApi {
  create: (id: number | string) => Promise<ReceiptLink>;
  revoke: (id: number | string) => Promise<unknown>;
  publicPdfUrl: (token: string) => string;
  // Optional — only Task Submission / Vault Category receipts support
  // emailing the link straight to the account's own inbox so far.
  sendEmail?: (id: number | string) => Promise<{ success: boolean }>;
}

export function ReceiptLinkDialog({
  open, onOpenChange, itemId, itemLabel, api, title = "Share Receipt", description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  itemId: number | string | null;
  itemLabel?: string;
  api: ReceiptApi;
  title?: string;
  description?: string;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [emailing, setEmailing] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!open || itemId == null || itemId === "") { setUrl(null); setToken(null); return; }
    setLoading(true);
    api.create(itemId)
      .then(res => { setUrl(res.url); setToken(res.token); })
      .catch((e: any) => toast({ variant: "destructive", title: "Couldn't create receipt link", description: e?.message }))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId]);

  const handleCopy = async () => {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    toast({ title: "Link copied" });
  };

  const handleEmail = async () => {
    if (itemId == null || !api.sendEmail) return;
    setEmailing(true);
    try {
      await api.sendEmail(itemId);
      toast({ title: "Email sent", description: "The receipt link was emailed." });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Couldn't send email", description: e?.message });
    } finally {
      setEmailing(false);
    }
  };

  const handleRevoke = async () => {
    if (itemId == null) return;
    if (!confirm("Revoke this link? Anyone holding it will lose access, and you'll need to generate a new one.")) return;
    setRevoking(true);
    try {
      await api.revoke(itemId);
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
          <DialogTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> {title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {description ?? (
              <>
                A public, beautifully themed receipt {itemLabel && <>for <span className="text-foreground font-medium">{itemLabel}</span></>} — anyone
                with this link can view and download it, no login needed. Nothing else in your account is reachable from it.
              </>
            )}
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
                {token && (
                  <Button variant="outline" size="sm" onClick={() => window.open(api.publicPdfUrl(token), "_blank")}>
                    <Download className="h-3.5 w-3.5 mr-1.5" /> Download PDF
                  </Button>
                )}
                {api.sendEmail && (
                  <Button variant="outline" size="sm" onClick={handleEmail} disabled={emailing}>
                    {emailing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Mail className="h-3.5 w-3.5 mr-1.5" />}
                    Email It
                  </Button>
                )}
              </div>
            </>
          ) : null}
        </div>

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
