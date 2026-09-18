import { useState } from "react";
import { useGetSpamScore } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function AdminStreak() {
  const [address, setAddress] = useState("");
  const spamMutation = useGetSpamScore();

  const handleAnalyze = (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) return;
    spamMutation.mutate({ data: { address } });
  };

  const score = spamMutation.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Sybil & Spam Detection</h1>
        <p className="text-muted-foreground font-mono text-sm">Analyze wallet behaviors for sybil patterns</p>
      </div>

      <Card className="bg-card border-card-border shadow-none max-w-2xl">
        <CardHeader>
          <CardTitle className="text-sm font-mono uppercase text-primary">Run Sybil Check</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAnalyze} className="flex gap-2">
            <Input 
              placeholder="Enter wallet address..." 
              className="font-mono bg-background border-border flex-1"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <Button 
              type="submit" 
              className="font-mono uppercase"
              disabled={spamMutation.isPending || !address}
            >
              Analyze
            </Button>
          </form>
        </CardContent>
      </Card>

      {score && !spamMutation.isPending && (
        <Card className={`bg-card border shadow-none max-w-2xl ${score.level === 'Critical' ? 'border-destructive' : 'border-card-border'}`}>
          <CardContent className="pt-6">
            <div className="flex items-start gap-4">
              <div className={`p-3 rounded-full ${score.level === 'Low' ? 'bg-primary/20 text-primary' : 'bg-destructive/20 text-destructive'}`}>
                {score.level === 'Low' ? <ShieldCheck className="h-8 w-8" /> : <ShieldAlert className="h-8 w-8" />}
              </div>
              <div className="flex-1">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="font-mono font-bold text-lg">Threat Level: {score.level}</h3>
                  <Badge variant={score.level === 'Low' ? 'outline' : 'destructive'} className="font-mono">
                    Score: {score.score}/100
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground font-mono mb-4">{score.explanation}</p>
                <div className="grid grid-cols-2 gap-2 text-xs font-mono">
                  <div className="bg-background rounded p-2 border border-border">
                    <span className="text-muted-foreground block mb-1">Dust Txs</span>
                    <span className="font-bold">{score.dustTxCount}</span>
                  </div>
                  <div className="bg-background rounded p-2 border border-border">
                    <span className="text-muted-foreground block mb-1">High Freq/Low Val</span>
                    <span className="font-bold">{score.highFreqLowValueCount}</span>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
