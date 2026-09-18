import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { BookOpen, Plus, Loader2, Trash2, Lock } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceAccount, AccountType } from "@/config/finance";
import { ACCOUNT_TYPE_LABELS } from "@/config/finance";
import { FinancePageHeader, SectionEyebrow, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";
import { BookSelect } from "@/components/finance/finance-book-select";
import { cn } from "@/lib/utils";

const TYPE_BADGE: Record<AccountType, string> = {
  asset: "text-sky-400 border-sky-400/30 bg-sky-400/10",
  liability: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  equity: "text-violet-400 border-violet-400/30 bg-violet-400/10",
  income: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  expense: "text-red-400 border-red-400/30 bg-red-400/10",
};

export default function FinanceAccountsPage() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<FinanceAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bookId, setBookId] = useState("");

  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("asset");
  const [normalBalance, setNormalBalance] = useState<"debit" | "credit">("debit");

  const load = () => {
    setLoading(true);
    financeApi.listAccounts(token, bookId ? { bookId } : {}).then(setAccounts).catch(() => setAccounts([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token, bookId]);

  const resetForm = () => {
    setCode(""); setName(""); setType("asset"); setNormalBalance("debit");
  };

  const handleCreate = async () => {
    if (!code.trim() || !name.trim()) { toast({ variant: "destructive", title: "Code and name are required" }); return; }
    setSaving(true);
    try {
      await financeApi.createAccount(token, { code: code.trim(), name: name.trim(), type, normalBalance, bookId: bookId ? Number(bookId) : undefined });
      toast({ title: "Account created" });
      setDialogOpen(false);
      resetForm();
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to create account", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await financeApi.deleteAccount(token, id);
      toast({ title: "Account deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to delete account", description: e?.message });
    }
  };

  if (loading) return <FinanceLoader />;

  return (
    <div className="space-y-6 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Accounting" title="Chart of Accounts"
        description="Double-entry accounts backing every Finance ledger entry"
        actions={
          <div className="flex items-center gap-2">
            <BookSelect value={bookId} onChange={setBookId} />
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" /> New Account
            </Button>
          </div>
        }
      />

      <div className="space-y-2.5">
        <SectionEyebrow icon={BookOpen}>Accounts</SectionEyebrow>
        {accounts.length === 0 ? (
          <FinanceEmptyState icon={BookOpen} title="Kono account nei" description="New Account diye ekta add koro." />
        ) : (
          <div className="rounded-xl border border-card-border bg-card overflow-hidden overflow-x-auto elevation-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Normal Balance</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map(a => (
                  <TableRow key={a.id} className="table-row-premium">
                    <TableCell className="font-mono text-xs text-muted-foreground">{a.code}</TableCell>
                    <TableCell className="font-medium flex items-center gap-2">
                      {a.name}
                      {!!a.isSystem && <Lock className="h-3 w-3 text-muted-foreground/50" aria-label="System account" />}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn("capitalize", TYPE_BADGE[a.type])}>{ACCOUNT_TYPE_LABELS[a.type]}</Badge>
                    </TableCell>
                    <TableCell className="capitalize text-xs text-muted-foreground">{a.normalBalance}</TableCell>
                    <TableCell>
                      {!a.isSystem && (
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-danger" onClick={() => handleDelete(a.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>New Account</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Code</Label>
                <Input value={code} onChange={e => setCode(e.target.value)} placeholder="e.g. 1050" />
              </div>
              <div className="space-y-1.5">
                <Label>Normal Balance</Label>
                <Select value={normalBalance} onValueChange={(v: any) => setNormalBalance(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="debit">Debit</SelectItem>
                    <SelectItem value="credit">Credit</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Bkash Wallet" />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={type} onValueChange={(v: any) => setType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map(t => (
                    <SelectItem key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
