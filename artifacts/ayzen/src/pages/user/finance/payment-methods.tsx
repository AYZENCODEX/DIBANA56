/**
 * pages/user/finance/payment-methods.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Publish your own receiving destinations (bKash/Nagad/Rocket/bank/USDT) so
 * an invoice's public "Repay" page (pages/finance/invoice-public.tsx) can
 * show a debtor exactly where to send money. Informational only — no
 * gateway API integration; the debtor pays manually and submits a
 * reference back on that page (routes/finance-invoices.ts).
 */
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Trash2, Loader2, Smartphone, Landmark, Wallet, Star } from "lucide-react";
import { financeInvoiceApi } from "@/lib/finance-api";
import { PAYMENT_METHOD_LABELS, type FinancePaymentMethod, type PaymentMethodType } from "@/config/finance";
import { FinancePageHeader, FinanceCard, FinanceEmptyState, FinanceLoader } from "@/components/finance/finance-ui";

const TYPE_ICON: Record<PaymentMethodType, typeof Smartphone> = {
  bkash: Smartphone, nagad: Smartphone, rocket: Smartphone, bank: Landmark, usdt: Wallet,
};

function MethodDialog({ open, onOpenChange, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; onSaved: () => void }) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [methodType, setMethodType] = useState<PaymentMethodType>("bkash");
  const [label, setLabel] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankAccountName, setBankAccountName] = useState("");
  const [bankAccountNumber, setBankAccountNumber] = useState("");
  const [bankRoutingNumber, setBankRoutingNumber] = useState("");
  const [usdtAddress, setUsdtAddress] = useState("");
  const [usdtNetwork, setUsdtNetwork] = useState("TRC20");
  const [isDefault, setIsDefault] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMethodType("bkash"); setLabel(""); setAccountNumber(""); setBankName("");
      setBankAccountName(""); setBankAccountNumber(""); setBankRoutingNumber("");
      setUsdtAddress(""); setUsdtNetwork("TRC20"); setIsDefault(false);
    }
  }, [open]);

  const save = async () => {
    if (methodType === "bank" && !bankAccountNumber.trim()) { toast({ variant: "destructive", title: "Bank account number is required" }); return; }
    if (methodType === "usdt" && !usdtAddress.trim()) { toast({ variant: "destructive", title: "USDT address is required" }); return; }
    if (["bkash", "nagad", "rocket"].includes(methodType) && !accountNumber.trim()) { toast({ variant: "destructive", title: "Account number is required" }); return; }

    setSaving(true);
    try {
      await financeInvoiceApi.createPaymentMethod(token, {
        methodType, label: label.trim() || undefined,
        accountNumber: accountNumber.trim() || undefined,
        bankName: bankName.trim() || undefined, bankAccountName: bankAccountName.trim() || undefined,
        bankAccountNumber: bankAccountNumber.trim() || undefined, bankRoutingNumber: bankRoutingNumber.trim() || undefined,
        usdtAddress: usdtAddress.trim() || undefined, usdtNetwork: usdtNetwork.trim() || undefined,
        isDefault,
      });
      toast({ title: "Payment method added" });
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
        <DialogHeader><DialogTitle>New Payment Method</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Type</Label>
            <Select value={methodType} onValueChange={v => setMethodType(v as PaymentMethodType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethodType[]).map(t => (
                  <SelectItem key={t} value={t}>{PAYMENT_METHOD_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Label (optional)</Label>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Personal bKash" />
          </div>

          {["bkash", "nagad", "rocket"].includes(methodType) && (
            <div>
              <Label>{PAYMENT_METHOD_LABELS[methodType]} Number</Label>
              <Input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="01XXXXXXXXX" />
            </div>
          )}

          {methodType === "bank" && (
            <>
              <div><Label>Bank Name</Label><Input value={bankName} onChange={e => setBankName(e.target.value)} /></div>
              <div><Label>Account Name</Label><Input value={bankAccountName} onChange={e => setBankAccountName(e.target.value)} /></div>
              <div><Label>Account Number</Label><Input value={bankAccountNumber} onChange={e => setBankAccountNumber(e.target.value)} /></div>
              <div><Label>Routing Number (optional)</Label><Input value={bankRoutingNumber} onChange={e => setBankRoutingNumber(e.target.value)} /></div>
            </>
          )}

          {methodType === "usdt" && (
            <>
              <div><Label>USDT Address</Label><Input value={usdtAddress} onChange={e => setUsdtAddress(e.target.value)} placeholder="T..." /></div>
              <div>
                <Label>Network</Label>
                <Select value={usdtNetwork} onValueChange={setUsdtNetwork}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TRC20">TRC20 (Tron)</SelectItem>
                    <SelectItem value="ERC20">ERC20 (Ethereum)</SelectItem>
                    <SelectItem value="BEP20">BEP20 (BSC)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
            Set as default
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}Add</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function methodDetail(m: FinancePaymentMethod): string {
  if (m.methodType === "bank") return [m.bankName, m.bankAccountName, m.bankAccountNumber].filter(Boolean).join(" · ");
  if (m.methodType === "usdt") return [m.usdtAddress, m.usdtNetwork].filter(Boolean).join(" · ");
  return m.accountNumber ?? "—";
}

export default function FinancePaymentMethodsPage() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [methods, setMethods] = useState<FinancePaymentMethod[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    financeInvoiceApi.listPaymentMethods(token).then(setMethods).finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleSetDefault = async (id: number) => {
    try {
      await financeInvoiceApi.updatePaymentMethod(token, id, { isDefault: true });
      toast({ title: "Default updated" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Remove this payment method? It will stop appearing on new invoices.")) return;
    try {
      await financeInvoiceApi.deletePaymentMethod(token, id);
      toast({ title: "Removed" });
      load();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    }
  };

  return (
    <div className="space-y-5 page-enter">
      <FinancePageHeader
        eyebrow="Finance · Invoices"
        title="Payment Methods"
        description="Where debtors send you money — shown on the public Repay page of every invoice you send"
        actions={<Button size="sm" onClick={() => setDialogOpen(true)}><Plus className="h-4 w-4 mr-1.5" /> Add Method</Button>}
      />

      {loading ? (
        <FinanceLoader />
      ) : methods.length === 0 ? (
        <FinanceEmptyState icon={Wallet} title="No payment methods yet" description="Add a bKash, Nagad, Rocket, bank, or USDT destination so invoices know where to send you money." />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {methods.map(m => {
            const Icon = TYPE_ICON[m.methodType] ?? Wallet;
            return (
              <FinanceCard key={m.id} className="animate-fade-up space-y-3" hover>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" />
                    <p className="font-semibold">{m.label || PAYMENT_METHOD_LABELS[m.methodType]}</p>
                  </div>
                  {!!m.isDefault && <Badge className="bg-primary/10 text-primary border-primary/30"><Star className="h-3 w-3 mr-1" />Default</Badge>}
                </div>
                <p className="text-xs text-muted-foreground truncate">{methodDetail(m)}</p>
                <div className="flex gap-2">
                  {!m.isDefault && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleSetDefault(m.id)}>Set as default</Button>
                  )}
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-danger ml-auto" onClick={() => handleDelete(m.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </FinanceCard>
            );
          })}
        </div>
      )}

      <MethodDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />
    </div>
  );
}
