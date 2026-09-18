import { useState, useEffect, useCallback } from "react";
import { Eye, EyeOff, Copy, Check, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { generateTOTP } from "@/lib/totp";

export function useTimeLeft(period = 30) {
  const [t, setT] = useState(period - (Math.floor(Date.now() / 1000) % period));
  useEffect(() => {
    const iv = setInterval(() => setT(period - (Math.floor(Date.now() / 1000) % period)), 500);
    return () => clearInterval(iv);
  }, [period]);
  return t;
}

export function TOTPCard({
  label, issuer, secret, onDelete,
}: {
  label: string; issuer?: string; secret: string; onDelete?: () => void;
}) {
  const [code, setCode] = useState("------");
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  const timeLeft = useTimeLeft(30);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const c = await generateTOTP(secret);
    setCode(c);
  }, [secret]);

  useEffect(() => { refresh(); }, [refresh, Math.floor(Date.now() / 1000 / 30)]);
  useEffect(() => {
    const iv = setInterval(refresh, 1000);
    return () => clearInterval(iv);
  }, [refresh]);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast({ title: "Code copied", description: `${label} TOTP copied` });
    setTimeout(() => setCopied(false), 2000);
  };

  const isExpiring = timeLeft <= 5;

  return (
    <div className="bg-card border border-card-border rounded-xl p-4 flex flex-col gap-3 hover:border-primary/30 transition-all">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-xs font-bold text-foreground truncate">{label}</p>
          {issuer && <p className="font-mono text-[9px] text-muted-foreground/50 truncate">{issuer}</p>}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => setShown(s => !s)} className="text-muted-foreground/40 hover:text-primary transition-colors p-1">
            {shown ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
          {onDelete && (
            <button onClick={onDelete} className="text-muted-foreground/40 hover:text-red-400 transition-colors p-1">
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      <div
        className={cn(
          "font-mono text-2xl font-bold tracking-[0.25em] text-center py-2 rounded-lg border cursor-pointer transition-all select-none",
          isExpiring
            ? "text-red-400 bg-red-400/5 border-red-400/20"
            : "text-primary bg-primary/5 border-primary/20 hover:bg-primary/10"
        )}
        onClick={copy}
      >
        {shown ? code : "••• •••"}
        <span className="text-[10px] font-normal text-muted-foreground/50 block mt-0.5">click to copy</span>
      </div>

      <div>
        <Progress value={(timeLeft / 30) * 100} className={cn("h-1", isExpiring ? "[&>div]:bg-red-400" : "[&>div]:bg-primary")} />
        <div className="flex justify-between mt-1">
          <span className="font-mono text-[9px] text-muted-foreground/40">refreshes in</span>
          <span className={cn("font-mono text-[9px] font-bold", isExpiring ? "text-red-400" : "text-muted-foreground/60")}>{timeLeft}s</span>
        </div>
      </div>

      <button onClick={copy} className={cn("flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg font-mono text-xs transition-all border", copied ? "text-emerald-400 border-emerald-400/20 bg-emerald-400/5" : "text-muted-foreground border-border/40 hover:text-primary hover:border-primary/30")}>
        {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        {copied ? "Copied!" : "Copy code"}
      </button>
    </div>
  );
}
