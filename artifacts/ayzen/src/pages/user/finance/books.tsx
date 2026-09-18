import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, Landmark, Star, Briefcase, User as UserIcon } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { FinanceBook, BookType } from "@/config/finance";
import { FinancePageHeader, FinanceCard, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

const TYPE_ICON: Record<BookType, typeof Briefcase> = {
  personal: UserIcon, business: Briefcase, other: Landmark,
};

function BookDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [bookType, setBookType] = useState<BookType>("business");
  const [currency, setCurrency] = useState("BDT");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (open) { setName(""); setBookType("business"); setCurrency("BDT"); } }, [open]);

  const save = async () => {
    if (!name.trim()) { toast({ variant: "destructive", title: "Name is required" }); return; }
    setSaving(true);
    try {
      await financeApi.createBook(token, { name: name.trim(), bookType, currency });
      toast({ title: "Book created" });
      onOpenChange(false);
      onSaved();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>New Book</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Business, Freelance, Side Project" />
          </div>
          <div>
            <Label>Type</Label>
            <Select value={bookType} onValueChange={v => setBookType(v as BookType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">Personal</SelectItem>
                <SelectItem value="business">Business</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Base currency</Label>
            <Input value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} placeholder="BDT" maxLength={6} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function FinanceBooksPage() {
  const { token, isLoading: authLoading } = useAuth();
  const { toast } = useToast();
  const [books, setBooks] = useState<FinanceBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(() => {
    if (authLoading || !token) return;
    setLoading(true);
    financeApi.listBooks(token).then(setBooks).catch(() => {}).finally(() => setLoading(false));
  }, [token, authLoading]);

  useEffect(() => { load(); }, [load]);

  const handleSetDefault = async (id: number) => {
    try {
      await financeApi.setDefaultBook(token, id);
      toast({ title: "Default book updated" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this book? It must have no entries in it.")) return;
    try {
      await financeApi.deleteBook(token, id);
      toast({ title: "Deleted" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Accounting"
        title="Books"
        description="Separate ledgers — e.g. Business vs Personal — each with its own Chart of Accounts, Journal, and entries"
        actions={<Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> New Book</Button>}
      />

      {loading ? (
        <FinanceLoader />
      ) : books.length === 0 ? (
        <FinanceEmptyState icon={Landmark} title="No books yet" description="A default Personal book is created automatically the first time you use Finance." />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {books.map(b => {
            const Icon = TYPE_ICON[b.bookType] ?? Landmark;
            return (
              <FinanceCard key={b.id} className="animate-fade-up space-y-3" hover>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <p className="font-semibold">{b.name}</p>
                  </div>
                  {!!b.isDefault && <Badge className="bg-primary/10 text-primary border-primary/30"><Star className="h-3 w-3 mr-1" />Default</Badge>}
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="capitalize">{b.bookType}</span>
                  <span className="font-mono">{b.currency}</span>
                </div>
                <div className="flex gap-2">
                  {!b.isDefault && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleSetDefault(b.id)}>Set as default</Button>
                  )}
                  {!b.isDefault && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-danger ml-auto" onClick={() => handleDelete(b.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                  )}
                </div>
              </FinanceCard>
            );
          })}
        </div>
      )}

      <BookDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />
    </div>
  );
}
