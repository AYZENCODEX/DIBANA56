/**
 * components/finance/finance-entry-detail-dialog.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Read-only "full view" of a single Finance ledger record — every field on
 * FinanceEntry laid out plainly, plus its attached receipts (FinanceAttachments,
 * reused read/write as-is). Opened from the Eye icon in finance-entry-list.tsx,
 * separate from the Pencil (edit) action so browsing a record never risks an
 * accidental edit.
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useAuth } from "@/hooks/use-auth";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { FinanceEntry, FinanceParty } from "@/config/finance";
import { KIND_LABELS, STATUS_STYLES, fmtMoney } from "@/config/finance";
import { financeApi } from "@/lib/finance-api";
import { FinanceAttachments } from "./finance-attachments";
import { FinanceAmortization } from "./finance-amortization";
import { FinanceInvoiceLines } from "./finance-invoice-lines";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface Project { id: number; name: string; }

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  if (value == null || value === "") return null;
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">{label}</p>
      <p className="text-sm font-medium break-words">{value}</p>
    </div>
  );
}

export function FinanceEntryDetailDialog({
  open, onOpenChange, entry, onEntryChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: FinanceEntry | null;
  onEntryChanged?: () => void;
}) {
  const { token } = useAuth();
  const [parties, setParties] = useState<FinanceParty[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  useEffect(() => {
    if (!open) return;
    financeApi.listParties(token).then(setParties).catch(() => setParties([]));
    fetch(`${BASE}/api/projects`, { headers: { Authorization: `Bearer ${token ?? ""}` } })
      .then(r => r.ok ? r.json() : [])
      .then(data => setProjects(Array.isArray(data) ? data : (data?.projects ?? [])))
      .catch(() => setProjects([]));
  }, [open, token]);

  if (!entry) return null;

  const partyName = entry.partyId ? parties.find(p => p.id === entry.partyId)?.name ?? `#${entry.partyId}` : null;
  const projectName = entry.projectId ? projects.find(p => p.id === entry.projectId)?.name ?? `#${entry.projectId}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            {entry.title}
            <Badge variant="outline" className="capitalize">{KIND_LABELS[entry.kind]}</Badge>
            <Badge variant="outline" className={cn("capitalize", STATUS_STYLES[entry.status])}>{entry.status}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <motion.div
            className="rounded-lg border border-card-border bg-muted/20 px-4 py-3 text-center"
            initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 300, damping: 22 }}
          >
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Amount</p>
            <p className="text-2xl font-bold font-mono">{fmtMoney(entry.amount, entry.currency)}</p>
          </motion.div>

          <motion.div
            className="grid grid-cols-2 gap-x-4 gap-y-3"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, delay: 0.1 }}
          >
            <Field label="Category" value={entry.category} />
            <Field label="Currency" value={entry.currency} />
            <Field label="Project" value={projectName} />
            <Field label="Party" value={partyName} />
            <Field label="Interest Rate" value={entry.interestRate != null ? `${entry.interestRate}%` : null} />
            <Field label="Interest Paid" value={entry.interestPaid ? fmtMoney(entry.interestPaid, entry.currency) : null} />
            <Field label="Occurred" value={entry.occurredDate ? new Date(entry.occurredDate).toLocaleDateString() : null} />
            <Field label="Due Date" value={entry.dueDate ? new Date(entry.dueDate).toLocaleDateString() : null} />
            <Field label="Created" value={entry.createdAt ? new Date(entry.createdAt).toLocaleString() : null} />
            <Field label="Last Updated" value={entry.updatedAt ? new Date(entry.updatedAt).toLocaleString() : null} />
          </motion.div>

          {entry.notes && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.18 }}>
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">Notes</p>
              <p className="text-sm whitespace-pre-wrap rounded-lg border border-card-border bg-muted/10 px-3 py-2">{entry.notes}</p>
            </motion.div>
          )}

          {(entry.kind === "borrowed" || entry.kind === "lending") && (
            <motion.div
              className="border-t border-border pt-3"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.2 }}
            >
              <FinanceAmortization entry={entry} />
            </motion.div>
          )}

          {entry.kind === "receivable" && (
            <motion.div
              className="border-t border-border pt-3"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.22 }}
            >
              <FinanceInvoiceLines entry={entry} onEntryChanged={onEntryChanged} />
            </motion.div>
          )}

          <motion.div
            className="border-t border-border pt-3"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3, delay: 0.24 }}
          >
            <FinanceAttachments entryId={entry.id} />
          </motion.div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
