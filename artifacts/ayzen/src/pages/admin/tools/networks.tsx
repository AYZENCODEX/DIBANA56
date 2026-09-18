import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Network, Plus, Edit2, Trash2, ToggleLeft, ToggleRight,
  Loader2, Radio, Link2, Globe,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Network = { id: number; name: string; network_id: string | null; chain: string; symbol: string | null; coingecko_id: string | null; rpc_url: string | null; gas_oracle_url: string | null; enabled: boolean; created_at: string };

export default function AdminNetworksPage() {
  const [networks, setNetworks] = useState<Network[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [edit, setEdit] = useState<Network | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", networkId: "", chain: "", symbol: "", coingeckoId: "", rpcUrl: "", gasOracleUrl: "" });
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const data = await customFetch<Network[]>("/networks");
      setNetworks(Array.isArray(data) ? data : []);
    } catch { setNetworks([]); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEdit(null);
    setForm({ name: "", networkId: "", chain: "", symbol: "", coingeckoId: "", rpcUrl: "", gasOracleUrl: "" });
    setDialog(true);
  };

  const openEdit = (n: Network) => {
    setEdit(n);
    setForm({ name: n.name, networkId: n.network_id ?? "", chain: n.chain, symbol: n.symbol ?? "", coingeckoId: n.coingecko_id ?? "", rpcUrl: n.rpc_url ?? "", gasOracleUrl: n.gas_oracle_url ?? "" });
    setDialog(true);
  };

  const save = async () => {
    if (!form.name.trim() || !form.chain.trim()) { toast({ title: "Name and chain are required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const body = { name: form.name.trim(), networkId: form.networkId || undefined, chain: form.chain.trim(), symbol: form.symbol || undefined, coingeckoId: form.coingeckoId || undefined, rpcUrl: form.rpcUrl || undefined, gasOracleUrl: form.gasOracleUrl || undefined };
      if (edit) {
        await customFetch(`/networks/${edit.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast({ title: "Network updated" });
      } else {
        await customFetch("/networks", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Network added" });
      }
      setDialog(false);
      await load();
    } catch { toast({ title: "Failed to save", variant: "destructive" }); } finally { setSaving(false); }
  };

  const toggle = async (n: Network) => {
    try {
      await customFetch(`/networks/${n.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !n.enabled }) });
      setNetworks(prev => prev.map(x => x.id === n.id ? { ...x, enabled: !x.enabled } : x));
    } catch { toast({ title: "Failed to toggle", variant: "destructive" }); }
  };

  const del = async (id: number) => {
    if (!confirm("Delete this network?")) return;
    try {
      await customFetch(`/networks/${id}`, { method: "DELETE" });
      toast({ title: "Deleted" });
      setNetworks(prev => prev.filter(n => n.id !== id));
    } catch { toast({ title: "Failed to delete", variant: "destructive" }); }
  };

  const f = (key: keyof typeof form, val: string) => setForm(prev => ({ ...prev, [key]: val }));

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><Radio className="w-5 h-5 text-primary" /> Networks</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage blockchain networks for gas tracking. Adding a chain here makes it available for real RPC gas price fetching.</p>
        </div>
        <Button size="sm" onClick={openCreate} className="h-9 gap-2"><Plus className="w-4 h-4" /> Add Network</Button>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="bg-card/60 border border-border/40 rounded-lg p-3">
          <div className="text-2xl font-mono font-bold text-foreground">{networks.length}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Total Networks</div>
        </div>
        <div className="bg-card/60 border border-border/40 rounded-lg p-3">
          <div className="text-2xl font-mono font-bold text-emerald-400">{networks.filter(n => n.enabled).length}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Enabled</div>
        </div>
        <div className="bg-card/60 border border-border/40 rounded-lg p-3">
          <div className="text-2xl font-mono font-bold text-primary">{networks.filter(n => n.rpc_url).length}</div>
          <div className="text-xs text-muted-foreground mt-0.5">With RPC URL</div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : (
        <div className="bg-card/60 border border-border/40 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/40 text-xs text-muted-foreground">
                <th className="text-left px-4 py-3">Network</th>
                <th className="text-left px-4 py-3">Chain / ID</th>
                <th className="text-left px-4 py-3">RPC URL</th>
                <th className="text-center px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/20">
              {networks.map(n => (
                <tr key={n.id} className="hover:bg-muted/10 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary font-mono">
                        {n.symbol?.slice(0, 2) ?? n.chain.slice(0, 2)}
                      </div>
                      <div>
                        <div className="text-sm font-medium text-foreground">{n.name}</div>
                        {n.symbol && <div className="text-[10px] text-muted-foreground">{n.symbol}</div>}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-xs font-mono text-foreground">{n.chain}</div>
                    {n.network_id && <div className="text-[10px] text-muted-foreground">ID: {n.network_id}</div>}
                  </td>
                  <td className="px-4 py-3">
                    {n.rpc_url ? (
                      <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[160px] block" title={n.rpc_url}>{n.rpc_url.replace(/^https?:\/\//, "")}</span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground/40 italic">No RPC URL</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => toggle(n)}>
                      {n.enabled
                        ? <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 gap-1"><ToggleRight className="w-3 h-3" /> Enabled</Badge>
                        : <Badge variant="outline" className="text-[10px] text-muted-foreground gap-1"><ToggleLeft className="w-3 h-3" /> Disabled</Badge>
                      }
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(n)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"><Edit2 className="w-3.5 h-3.5" /></button>
                      <button onClick={() => del(n.id)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {networks.length === 0 && <div className="text-center py-10 text-sm text-muted-foreground">No networks configured.</div>}
        </div>
      )}

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="sm:max-w-md bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Network className="w-4 h-4 text-primary" /> {edit ? "Edit" : "Add"} Network</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Name *</label>
                <Input value={form.name} onChange={e => f("name", e.target.value)} placeholder="Ethereum" className="h-9 text-sm bg-background/50" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Chain *</label>
                <Input value={form.chain} onChange={e => f("chain", e.target.value)} placeholder="ETH" className="h-9 text-sm bg-background/50" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Network ID</label>
                <Input value={form.networkId} onChange={e => f("networkId", e.target.value)} placeholder="1" className="h-9 text-sm bg-background/50" />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Symbol</label>
                <Input value={form.symbol} onChange={e => f("symbol", e.target.value)} placeholder="ETH" className="h-9 text-sm bg-background/50" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">RPC URL</label>
              <Input value={form.rpcUrl} onChange={e => f("rpcUrl", e.target.value)} placeholder="https://eth.llamarpc.com" className="h-9 text-sm bg-background/50" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Gas Oracle URL (optional)</label>
              <Input value={form.gasOracleUrl} onChange={e => f("gasOracleUrl", e.target.value)} placeholder="https://api.etherscan.io/api?module=gastracker…" className="h-9 text-sm bg-background/50" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">CoinGecko ID (for price)</label>
              <Input value={form.coingeckoId} onChange={e => f("coingeckoId", e.target.value)} placeholder="ethereum" className="h-9 text-sm bg-background/50" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(false)}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
