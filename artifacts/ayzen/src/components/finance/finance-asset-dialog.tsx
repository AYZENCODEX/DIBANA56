import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { financeApi } from "@/lib/finance-api";
import type { AssetType, FinanceAsset, FinanceAssetOwner, FinanceParty } from "@/config/finance";
import { ASSET_TYPE_LABELS, ASSET_TYPE_LIQUIDITY_HINT } from "@/config/finance";

export function FinanceAssetDialog({
  open, onOpenChange, defaultType, asset, onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultType: AssetType;
  asset?: FinanceAsset | null;
  onSaved?: () => void;
}) {
  const { token } = useAuth();
  const { toast } = useToast();
  const [assetType, setAssetType] = useState<AssetType>(defaultType);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [totalValue, setTotalValue] = useState("");
  const [interestRate, setInterestRate] = useState("");
  const [maturityDate, setMaturityDate] = useState("");
  const [notes, setNotes] = useState("");
  const [owners, setOwners] = useState<FinanceAssetOwner[]>([{ partyId: null, ownerName: "You", ownershipPercent: 100 }]);
  const [parties, setParties] = useState<FinanceParty[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAssetType(asset?.assetType ?? defaultType);
    setName(asset?.name ?? "");
    setProvider(asset?.provider ?? "");
    setTotalValue(asset ? String(asset.totalValue) : "");
    setInterestRate(asset?.interestRate != null ? String(asset.interestRate) : "");
    setMaturityDate(asset?.maturityDate ? asset.maturityDate.slice(0, 10) : "");
    setNotes(asset?.notes ?? "");
    setOwners(asset?.owners?.length ? asset.owners.map(o => ({ ...o })) : [{ partyId: null, ownerName: "You", ownershipPercent: 100 }]);
    financeApi.listParties(token).then(setParties).catch(() => setParties([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, asset, defaultType]);

  const isJoint = assetType === "mutual_fund" || assetType === "locked" || assetType === "other";
  const totalPct = owners.reduce((s, o) => s + (Number(o.ownershipPercent) || 0), 0);

  const updateOwner = (i: number, patch: Partial<FinanceAssetOwner>) => {
    setOwners(prev => prev.map((o, idx) => idx === i ? { ...o, ...patch } : o));
  };
  const addOwner = () => setOwners(prev => [...prev, { partyId: null, ownerName: "", ownershipPercent: 0 }]);
  const removeOwner = (i: number) => setOwners(prev => prev.filter((_, idx) => idx !== i));

  const handleSave = async () => {
    if (!name.trim()) { toast({ variant: "destructive", title: "Name is required" }); return; }
    const val = parseFloat(totalValue);
    if (!val || val <= 0) { toast({ variant: "destructive", title: "Enter a valid total value" }); return; }
    if (owners.some(o => !o.ownerName.trim())) { toast({ variant: "destructive", title: "Every owner needs a name" }); return; }

    setSaving(true);
    try {
      const payload = {
        assetType, name: name.trim(), provider: provider.trim() || null,
        totalValue: val,
        interestRate: interestRate ? parseFloat(interestRate) : null,
        maturityDate: maturityDate || null,
        liquidity: ASSET_TYPE_LIQUIDITY_HINT[assetType],
        notes: notes.trim() || null,
        owners: owners.map(o => ({ partyId: o.partyId, ownerName: o.ownerName.trim(), ownershipPercent: Number(o.ownershipPercent) || 0 })),
      };
      if (asset) {
        await financeApi.updateAsset(token, asset.id, payload);
        toast({ title: "Updated" });
      } else {
        await financeApi.createAsset(token, payload);
        toast({ title: "Added" });
      }
      onOpenChange(false);
      onSaved?.();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed", description: e?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{asset ? "Edit" : "Add"} Asset</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Asset Type</Label>
            <Select value={assetType} onValueChange={v => setAssetType(v as AssetType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(ASSET_TYPE_LABELS) as AssetType[]).map(t => (
                  <SelectItem key={t} value={t}>{ASSET_TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. XYZ Growth Fund, bKash, DBBL Account" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Provider (optional)</Label>
              <Input value={provider} onChange={e => setProvider(e.target.value)} placeholder="e.g. IDLC, bKash" />
            </div>
            <div>
              <Label>Total Value</Label>
              <Input type="number" value={totalValue} onChange={e => setTotalValue(e.target.value)} placeholder="Full fund/account value" />
            </div>
          </div>

          {(assetType === "mutual_fund" || assetType === "locked") && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Interest / Return Rate (%)</Label>
                <Input type="number" value={interestRate} onChange={e => setInterestRate(e.target.value)} />
              </div>
              <div>
                <Label>Maturity Date</Label>
                <Input type="date" value={maturityDate} onChange={e => setMaturityDate(e.target.value)} />
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <Label className="mb-0">
                Ownership Split {isJoint && <span className="text-muted-foreground font-normal">(add co-owners for a joint asset)</span>}
              </Label>
              <Button type="button" size="sm" variant="outline" onClick={addOwner}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Owner
              </Button>
            </div>
            <div className="space-y-2">
              {owners.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    className="flex-1"
                    placeholder="Name (e.g. You, Rafiq)"
                    value={o.ownerName}
                    onChange={e => updateOwner(i, { ownerName: e.target.value, partyId: e.target.value.trim().toLowerCase() === "you" ? null : o.partyId })}
                  />
                  <Select
                    value={parties.find(p => p.id === o.partyId)?.name ?? "__manual"}
                    onValueChange={v => {
                      if (v === "__manual") { updateOwner(i, { partyId: null }); return; }
                      const p = parties.find(p => String(p.id) === v);
                      if (p) updateOwner(i, { partyId: p.id, ownerName: p.name });
                    }}
                  >
                    <SelectTrigger className="w-36 shrink-0"><SelectValue placeholder="Link party" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__manual">Manual / You</SelectItem>
                      {parties.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <div className="relative w-24 shrink-0">
                    <Input
                      type="number"
                      value={o.ownershipPercent}
                      onChange={e => updateOwner(i, { ownershipPercent: Number(e.target.value) })}
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                  {owners.length > 1 && (
                    <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-red-400 shrink-0" onClick={() => removeOwner(i)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <p className={`text-xs mt-1.5 ${totalPct === 100 ? "text-muted-foreground" : "text-amber-400"}`}>
              Total: {totalPct}% {totalPct !== 100 && "— shares don't add up to 100%"}
            </p>
          </div>

          <div>
            <Label>Notes</Label>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            {asset ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
