import { useState, useEffect } from "react";
import { Key, Plus, Trash2, RefreshCw, Eye, EyeOff, CheckCircle, XCircle, Database, Zap, Globe, Flame, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-base";

const BASE = getApiBase();

const PROVIDERS = [
  { id: "database",   label: "Database",    icon: Database, color: "text-blue-400",   maxSlots: 2, description: "PostgreSQL connection strings" },
  { id: "groq",       label: "Groq",        icon: Zap,      color: "text-yellow-400", maxSlots: 3, description: "Groq LLM API keys" },
  { id: "openrouter", label: "OpenRouter",   icon: Globe,    color: "text-violet-400", maxSlots: 3, description: "OpenRouter proxy keys" },
  { id: "fireworks",  label: "Fireworks AI", icon: Flame,    color: "text-orange-400", maxSlots: 3, description: "Fireworks AI API keys" },
];

interface RobinKey {
  id: number;
  provider: string;
  label: string;
  slot: number;
  key_masked: string;
  is_active: boolean;
  created_at: string;
}

interface ProviderStatus {
  provider: string;
  total: string;
  active: string;
}

function getAuthHeader() {
  const token = localStorage.getItem("ayzen_token") ?? sessionStorage.getItem("ayzen_token") ?? "";
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function ProviderSection({ provider, keys, onRefresh }: {
  provider: typeof PROVIDERS[0];
  keys: RobinKey[];
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(true);
  const [adding, setAdding] = useState<number | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [showKey, setShowKey] = useState<number | null>(null);
  const [loading, setLoading] = useState<number | null>(null);

  const Icon = provider.icon;
  const filledSlots = new Set(keys.map(k => k.slot));
  const emptySlots = Array.from({ length: provider.maxSlots }, (_, i) => i + 1).filter(s => !filledSlots.has(s));
  const activeCount = keys.filter(k => k.is_active).length;

  const addKey = async (slot: number) => {
    if (!newKey.trim()) { toast({ variant: "destructive", title: "Key value is required" }); return; }
    setLoading(slot);
    try {
      const r = await fetch(`${BASE}/api/key-manager/keys`, {
        method: "POST",
        headers: getAuthHeader(),
        body: JSON.stringify({ provider: provider.id, label: newLabel || `${provider.label} Key ${slot}`, slot, key_value: newKey }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      toast({ title: `Key added to ${provider.label} slot ${slot}` });
      setNewKey(""); setNewLabel(""); setAdding(null);
      onRefresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: e.message });
    }
    setLoading(null);
  };

  const removeKey = async (id: number) => {
    setLoading(id);
    try {
      const r = await fetch(`${BASE}/api/key-manager/keys/${id}`, { method: "DELETE", headers: getAuthHeader() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      toast({ title: "Key removed" });
      onRefresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: e.message ?? "Failed to remove key" });
    }
    setLoading(null);
  };

  const toggleKey = async (id: number) => {
    setLoading(id);
    try {
      const r = await fetch(`${BASE}/api/key-manager/keys/${id}/toggle`, { method: "PATCH", headers: getAuthHeader() });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      onRefresh();
    } catch (e: any) {
      toast({ variant: "destructive", title: e.message ?? "Failed to toggle key" });
    }
    setLoading(null);
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 p-4 hover:bg-muted/30 transition-colors"
      >
        <div className={cn("w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center", provider.color)}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 text-left">
          <div className="font-mono font-bold text-sm">{provider.label}</div>
          <div className="text-[10px] text-muted-foreground font-mono">{provider.description}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn("text-[10px] font-mono px-2 py-0.5 rounded-full border",
            activeCount > 0 ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" : "text-muted-foreground border-border"
          )}>
            {activeCount}/{provider.maxSlots} active
          </span>
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>

      {open && (
        <div className="border-t border-border p-4 space-y-3">
          {/* Existing Keys */}
          {keys.length === 0 && (
            <div className="text-center py-4 text-[11px] font-mono text-muted-foreground/50">
              No keys configured — add up to {provider.maxSlots} keys below
            </div>
          )}
          {keys.map(key => (
            <div key={key.id} className="flex items-center gap-2 p-3 rounded-lg bg-muted/20 border border-border/50">
              <div className={cn("w-5 h-5 rounded flex items-center justify-center flex-shrink-0", key.is_active ? "text-emerald-400" : "text-muted-foreground/40")}>
                {key.is_active ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono font-medium">{key.label}</div>
                <div className="text-[10px] font-mono text-muted-foreground">
                  Slot {key.slot} · {showKey === key.id ? key.key_masked : "••••••••••••••"}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowKey(s => s === key.id ? null : key.id)}
                  className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground"
                >
                  {showKey === key.id ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </button>
                <button
                  onClick={() => toggleKey(key.id)}
                  disabled={loading === key.id}
                  className={cn("text-[10px] font-mono px-2 py-0.5 rounded border transition-colors",
                    key.is_active
                      ? "border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
                      : "border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10"
                  )}
                >
                  {key.is_active ? "Disable" : "Enable"}
                </button>
                <button
                  onClick={() => removeKey(key.id)}
                  disabled={loading === key.id}
                  className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}

          {/* Add Key Form */}
          {emptySlots.length > 0 && (
            <div>
              {adding !== null ? (
                <div className="space-y-2 p-3 rounded-lg border border-primary/20 bg-primary/5">
                  <div className="text-[10px] font-mono text-primary uppercase tracking-widest">Adding Slot {adding}</div>
                  <div className="space-y-2">
                    <div>
                      <Label className="text-[10px] font-mono text-muted-foreground">Label (optional)</Label>
                      <Input
                        value={newLabel}
                        onChange={e => setNewLabel(e.target.value)}
                        placeholder={`${provider.label} Key ${adding}`}
                        className="h-8 text-xs font-mono mt-1"
                      />
                    </div>
                    <div>
                      <Label className="text-[10px] font-mono text-muted-foreground">Key Value *</Label>
                      <Input
                        type="password"
                        value={newKey}
                        onChange={e => setNewKey(e.target.value)}
                        placeholder={provider.id === "database" ? "postgresql://..." : "sk-..."}
                        className="h-8 text-xs font-mono mt-1"
                        onKeyDown={e => e.key === "Enter" && addKey(adding)}
                      />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="h-7 text-[10px] font-mono flex-1" onClick={() => addKey(adding)} disabled={loading === adding}>
                      {loading === adding ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Save Key"}
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-[10px] font-mono" onClick={() => { setAdding(null); setNewKey(""); setNewLabel(""); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 flex-wrap">
                  {emptySlots.map(slot => (
                    <button
                      key={slot}
                      onClick={() => setAdding(slot)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border hover:border-primary/40 hover:text-primary text-muted-foreground transition-colors text-[10px] font-mono"
                    >
                      <Plus className="w-3 h-3" />
                      Add Slot {slot}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const POLL_INTERVAL = 10; // seconds

export default function KeyManager() {
  const [keys, setKeys] = useState<RobinKey[]>([]);
  const [status, setStatus] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [countdown, setCountdown] = useState(POLL_INTERVAL);
  const { toast } = useToast();

  const fetchData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [keysRes, statusRes] = await Promise.all([
        fetch(`${BASE}/api/key-manager/keys`, { headers: getAuthHeader() }),
        fetch(`${BASE}/api/key-manager/status`, { headers: getAuthHeader() }),
      ]);
      if (keysRes.ok) setKeys((await keysRes.json()).keys ?? []);
      if (statusRes.ok) setStatus((await statusRes.json()).providers ?? []);
      setLastUpdated(new Date());
      setCountdown(POLL_INTERVAL);
    } catch {
      if (!silent) toast({ variant: "destructive", title: "Failed to load keys" });
    }
    if (!silent) setLoading(false);
  };

  // Initial load
  useEffect(() => { fetchData(); }, []);

  // Real-time polling every POLL_INTERVAL seconds
  useEffect(() => {
    const pollTimer = setInterval(() => fetchData(true), POLL_INTERVAL * 1000);
    return () => clearInterval(pollTimer);
  }, []);

  // Countdown display
  useEffect(() => {
    const tick = setInterval(() => setCountdown(c => c > 0 ? c - 1 : POLL_INTERVAL), 1000);
    return () => clearInterval(tick);
  }, []);

  const totalActive = status.reduce((s, p) => s + parseInt(p.active ?? "0", 10), 0);
  const totalKeys = status.reduce((s, p) => s + parseInt(p.total ?? "0", 10), 0);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Key className="w-5 h-5 text-primary" />
            <h1 className="font-mono font-bold text-xl">Robin Key Manager</h1>
            {/* Live indicator */}
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[9px] font-mono text-emerald-400 uppercase tracking-widest">Live</span>
            </div>
          </div>
          <p className="text-xs font-mono text-muted-foreground mt-1">
            Round-robin key rotation · auto-refresh in {countdown}s
            {lastUpdated && <span className="ml-2 opacity-50">· updated {lastUpdated.toLocaleTimeString()}</span>}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchData()} className="font-mono text-xs">
          <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {PROVIDERS.map(p => {
          const s = status.find(x => x.provider === p.id);
          const Icon = p.icon;
          return (
            <div key={p.id} className="p-3 rounded-lg border border-border bg-card text-center">
              <Icon className={cn("w-5 h-5 mx-auto mb-1", p.color)} />
              <div className="font-mono font-bold text-lg">{s?.active ?? 0}/{p.maxSlots}</div>
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">{p.label}</div>
            </div>
          );
        })}
      </div>

      {/* Summary bar */}
      {!loading && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border">
          <div className={cn("w-2 h-2 rounded-full", totalActive > 0 ? "bg-emerald-400" : "bg-muted-foreground")} />
          <span className="text-xs font-mono text-muted-foreground">
            {totalActive} of {totalKeys} keys active across {PROVIDERS.length} providers
          </span>
          <span className="ml-auto text-[10px] font-mono text-muted-foreground/50">
            Round-robin rotation enabled
          </span>
        </div>
      )}

      {/* Provider Sections */}
      {loading ? (
        <div className="text-center py-12 text-muted-foreground font-mono text-xs animate-pulse">
          Loading key manager...
        </div>
      ) : (
        <div className="space-y-4">
          {PROVIDERS.map(provider => (
            <ProviderSection
              key={provider.id}
              provider={provider}
              keys={keys.filter(k => k.provider === provider.id)}
              onRefresh={fetchData}
            />
          ))}
        </div>
      )}

      {/* Usage note */}
      <div className="p-4 rounded-lg border border-border/50 bg-muted/10">
        <div className="text-[10px] font-mono text-muted-foreground/60 space-y-1">
          <div className="font-bold text-muted-foreground/80 mb-2 uppercase tracking-widest">How Round-Robin Works</div>
          <p>• Each API call rotates through active keys in slot order.</p>
          <p>• Disable a key to skip it without deleting it.</p>
          <p>• The AI agent auto-selects the next key when rate-limited.</p>
          <p>• Database keys rotate on connection pool exhaustion.</p>
        </div>
      </div>
    </div>
  );
}
