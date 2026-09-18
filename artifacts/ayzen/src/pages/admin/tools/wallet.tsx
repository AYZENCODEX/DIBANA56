import { useState } from "react";
import { useAnalyzeWallet } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Wallet, Activity, ArrowRightLeft, ShieldAlert } from "lucide-react";

export default function AdminWallet() {
  const [address, setAddress] = useState("");
  const analyzeMutation = useAnalyzeWallet();

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) return;
    analyzeMutation.mutate({ data: { address, networks: ["ethereum", "arbitrum", "optimism"] } });
  };

  const result = analyzeMutation.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Wallet Inspector</h1>
        <p className="text-muted-foreground font-mono text-sm">Deep analysis and heuristic scoring</p>
      </div>

      <Card className="bg-card border-card-border shadow-none max-w-2xl">
        <CardContent className="pt-6">
          <form onSubmit={handleAnalyze} className="flex gap-2">
            <Input 
              placeholder="Enter EVM address (0x...)" 
              className="font-mono bg-background border-border flex-1"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <Button 
              type="submit" 
              className="font-mono uppercase"
              disabled={analyzeMutation.isPending || !address}
            >
              <Search className="h-4 w-4 mr-2" /> Inspect
            </Button>
          </form>
        </CardContent>
      </Card>

      {analyzeMutation.isPending && (
        <div className="text-center py-12 font-mono text-primary animate-pulse">
          INITIALIZING DEEP SCAN...
        </div>
      )}

      {result && !analyzeMutation.isPending && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">Activity Score</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-primary">{result.activityScore}/100</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">Wallet Age</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{result.walletAge} Days</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">Tx Count</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">{result.txCount}</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card border-card-border shadow-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono uppercase text-muted-foreground">Volume</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold font-mono">${result.txVolume?.toLocaleString() || 0}</div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
