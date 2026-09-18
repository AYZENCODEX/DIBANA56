import { useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Rocket, Server, Loader2 } from "lucide-react";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

export default function DevAznDeploy() {
  const { toast } = useToast();
  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [sysInfo, setSysInfo] = useState<any>(null);

  const token = localStorage.getItem("ayzen_token") ?? sessionStorage.getItem("ayzen_token") ?? "";

  const loadSysInfo = async () => {
    const r = await fetch(`${BASE}/api/dev/system-info`, { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) setSysInfo(await r.json());
  };

  const deploy = async () => {
    if (!userId || !amount) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/dev/azn/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId: Number(userId), amount: Number(amount), note }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Deploy failed");
      toast({ title: "AZN Deployed", description: `${amount} AZN sent to user #${userId}. New balance: ${data.newAznBalance}` });
      setUserId(""); setAmount(""); setNote("");
    } catch (e: any) {
      toast({ title: "Deploy failed", description: e.message, variant: "destructive" });
    }
    setLoading(false);
  };

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-mono font-bold text-primary flex items-center gap-2">
          <Rocket className="w-5 h-5" /> AZN Deploy Tools
        </h1>
        <p className="text-xs text-muted-foreground font-mono mt-1">
          Developer-only tool to directly deploy (grant) AZN balance to any user's wallet.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono">Deploy AZN to User</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <Label className="text-xs font-mono">User ID</Label>
              <Input value={userId} onChange={e => setUserId(e.target.value)} placeholder="e.g. 12" className="font-mono" />
            </div>
            <div>
              <Label className="text-xs font-mono">Amount (AZN)</Label>
              <Input value={amount} onChange={e => setAmount(e.target.value)} placeholder="e.g. 500" className="font-mono" />
            </div>
          </div>
          <div>
            <Label className="text-xs font-mono">Note (optional)</Label>
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Reason for deployment" className="font-mono" />
          </div>
          <Button onClick={deploy} disabled={loading || !userId || !amount} className="gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Rocket className="w-4 h-4" />}
            Deploy AZN
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-mono flex items-center gap-2">
            <Server className="w-4 h-4" /> System Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" size="sm" onClick={loadSysInfo}>Refresh</Button>
          {sysInfo && (
            <pre className="text-[10px] font-mono bg-muted/40 border border-border rounded p-3 overflow-x-auto">
              {JSON.stringify(sysInfo, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
