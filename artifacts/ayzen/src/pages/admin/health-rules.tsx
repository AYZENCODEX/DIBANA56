import { useState, useEffect } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  ShieldAlert, Plus, Edit2, Trash2, ToggleLeft, ToggleRight, Loader2,
  AlertCircle, AlertTriangle, CheckCircle,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type HealthRule = { id: number; rule_key: string; threshold_value: string | null; severity: string; enabled: boolean };

const RULE_KEYS = ["missing_2fa", "missing_wallet", "inactive_days", "missing_email", "missing_backup_codes", "banned_status"];
const SEVERITIES = ["warning", "critical"];
const SEVERITY_STYLES: Record<string, string> = {
  warning: "border-yellow-500/30 text-yellow-400 bg-yellow-400/5",
  critical: "border-red-500/30 text-red-400 bg-red-400/5",
};

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "critical") return <AlertCircle className="w-3.5 h-3.5 text-red-400" />;
  if (severity === "warning") return <AlertTriangle className="w-3.5 h-3.5 text-yellow-400" />;
  return <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />;
}

const RULE_DESCRIPTIONS: Record<string, string> = {
  missing_2fa: "Entity has no 2FA configured for any platform",
  missing_wallet: "Entity has no wallet addresses linked",
  inactive_days: "Entity has not been active for N days",
  missing_email: "Entity has no email address configured",
  missing_backup_codes: "Entity has no backup codes stored",
  banned_status: "Entity status is 'banned' or 'suspended'",
};

export default function AdminHealthRulesPage() {
  const [rules, setRules] = useState<HealthRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState(false);
  const [edit, setEdit] = useState<HealthRule | null>(null);
  const [ruleKey, setRuleKey] = useState("missing_2fa");
  const [threshold, setThreshold] = useState("");
  const [severity, setSeverity] = useState("warning");
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const load = async () => {
    setLoading(true);
    try {
      const data = await customFetch<HealthRule[]>("/health-rules");
      setRules(Array.isArray(data) ? data : []);
    } catch { setRules([]); } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => { setEdit(null); setRuleKey("missing_2fa"); setThreshold(""); setSeverity("warning"); setDialog(true); };
  const openEdit = (r: HealthRule) => { setEdit(r); setRuleKey(r.rule_key); setThreshold(r.threshold_value ?? ""); setSeverity(r.severity); setDialog(true); };

  const save = async () => {
    setSaving(true);
    try {
      const body = { ruleKey, thresholdValue: threshold || undefined, severity };
      if (edit) {
        await customFetch(`/health-rules/${edit.id}`, { method: "PATCH", body: JSON.stringify({ thresholdValue: threshold || undefined, severity }) });
        toast({ title: "Rule updated" });
      } else {
        await customFetch("/health-rules", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Rule created" });
      }
      setDialog(false);
      await load();
    } catch { toast({ title: "Failed to save", variant: "destructive" }); } finally { setSaving(false); }
  };

  const toggle = async (r: HealthRule) => {
    try {
      await customFetch(`/health-rules/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) });
      setRules(prev => prev.map(x => x.id === r.id ? { ...x, enabled: !x.enabled } : x));
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const del = async (id: number) => {
    if (!confirm("Delete this rule?")) return;
    try {
      await customFetch(`/health-rules/${id}`, { method: "DELETE" });
      toast({ title: "Deleted" });
      setRules(prev => prev.filter(r => r.id !== id));
    } catch { toast({ title: "Failed", variant: "destructive" }); }
  };

  const needsThreshold = ruleKey === "inactive_days";

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-foreground flex items-center gap-2"><ShieldAlert className="w-5 h-5 text-primary" /> Entity Health Rules</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Configure configurable thresholds that determine entity health badges (🟢 / 🟡 / 🔴).</p>
        </div>
        <Button size="sm" onClick={openCreate} className="h-9 gap-2"><Plus className="w-4 h-4" /> New Rule</Button>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <div className="bg-card/60 border border-border/40 rounded-lg p-3">
          <div className="text-2xl font-mono font-bold text-foreground">{rules.length}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Total Rules</div>
        </div>
        <div className="bg-card/60 border border-yellow-500/20 rounded-lg p-3">
          <div className="text-2xl font-mono font-bold text-yellow-400">{rules.filter(r => r.severity === "warning" && r.enabled).length}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Warnings</div>
        </div>
        <div className="bg-card/60 border border-red-500/20 rounded-lg p-3">
          <div className="text-2xl font-mono font-bold text-red-400">{rules.filter(r => r.severity === "critical" && r.enabled).length}</div>
          <div className="text-xs text-muted-foreground mt-0.5">Critical</div>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : rules.length === 0 ? (
        <div className="text-center py-16 text-sm text-muted-foreground">No health rules configured. Create one to start evaluating entity health.</div>
      ) : (
        <div className="space-y-2">
          {rules.map(r => (
            <div key={r.id} className={cn("flex items-start gap-3 p-4 bg-card/60 border rounded-lg transition-all", r.enabled ? "border-border/40" : "border-border/20 opacity-60")}>
              <SeverityIcon severity={r.severity} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-mono font-medium text-foreground">{r.rule_key}</span>
                  <Badge variant="outline" className={cn("text-[10px] capitalize", SEVERITY_STYLES[r.severity] ?? "")}>{r.severity}</Badge>
                  {r.threshold_value && <span className="text-[10px] text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded">threshold: {r.threshold_value}</span>}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{RULE_DESCRIPTIONS[r.rule_key] ?? r.rule_key}</p>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => toggle(r)} className="p-1.5 rounded hover:bg-muted/20 transition-colors" title={r.enabled ? "Disable" : "Enable"}>
                  {r.enabled ? <ToggleRight className="w-4 h-4 text-emerald-400" /> : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
                </button>
                <button onClick={() => openEdit(r)} className="p-1.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"><Edit2 className="w-3.5 h-3.5" /></button>
                <button onClick={() => del(r.id)} className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent className="sm:max-w-sm bg-card border-border">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><ShieldAlert className="w-4 h-4 text-primary" /> {edit ? "Edit" : "New"} Health Rule</DialogTitle></DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Rule Key</label>
              {edit ? (
                <Input value={ruleKey} disabled className="h-9 text-sm bg-muted/20" />
              ) : (
                <Select value={ruleKey} onValueChange={setRuleKey}>
                  <SelectTrigger className="h-9 text-sm bg-background/50"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {RULE_KEYS.map(k => <SelectItem key={k} value={k} className="font-mono text-xs">{k}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[10px] text-muted-foreground">{RULE_DESCRIPTIONS[ruleKey] ?? ""}</p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Severity</label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="h-9 text-sm bg-background/50"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {needsThreshold && (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Threshold (days)</label>
                <Input value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="30" type="number" className="h-9 text-sm bg-background/50" />
              </div>
            )}
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
