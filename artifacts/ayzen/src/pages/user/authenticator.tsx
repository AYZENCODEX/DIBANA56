import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, Plus, Trash2, Copy, Check, RefreshCw, Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface TOTPEntry {
  id: string;
  label: string;
  issuer: string;
  secret: string;
  createdAt: string;
}

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bits = clean.split("").map(c => BASE32_CHARS.indexOf(c).toString(2).padStart(5, "0")).join("");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function generateTOTP(secret: string, period = 30): Promise<string> {
  try {
    const keyBytes = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / period);
    const counterBytes = new Uint8Array(8);
    let tmp = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = tmp & 0xff;
      tmp = Math.floor(tmp / 256);
    }
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyBytes.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]
    );
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));
    const offset = hmac[19] & 0xf;
    const otp = (
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)
    ) % 1_000_000;
    return otp.toString().padStart(6, "0");
  } catch {
    return "------";
  }
}

function useTimeLeft(period = 30) {
  const [timeLeft, setTimeLeft] = useState(period - (Math.floor(Date.now() / 1000) % period));
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft(period - (Math.floor(Date.now() / 1000) % period));
    }, 500);
    return () => clearInterval(interval);
  }, [period]);
  return timeLeft;
}

function TOTPCard({ entry, onDelete }: { entry: TOTPEntry; onDelete: () => void }) {
  const [code, setCode] = useState("------");
  const [prevCode, setPrevCode] = useState("------");
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);
  const timeLeft = useTimeLeft(30);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const newCode = await generateTOTP(entry.secret);
    setCode(c => { if (c !== "------" && c !== newCode) setPrevCode(c); return newCode; });
  }, [entry.secret]);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (timeLeft === 30 || timeLeft === 29) refresh();
  }, [timeLeft, refresh]);

  const copyCode = async () => {
    if (code === "------") return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    toast({ title: "Code copied", description: `${entry.label} TOTP copied to clipboard.` });
    setTimeout(() => setCopied(false), 2000);
  };

  const progress = (timeLeft / 30) * 100;
  const isExpiring = timeLeft <= 5;

  return (
    <Card className="bg-card border-card-border shadow-none hover:border-primary/20 transition-colors group">
      <CardHeader className="pb-2 pt-4 px-4 flex flex-row items-start justify-between">
        <div>
          <CardTitle className="font-mono text-sm font-bold text-primary">{entry.label}</CardTitle>
          {entry.issuer && <div className="text-[10px] font-mono text-muted-foreground uppercase mt-0.5">{entry.issuer}</div>}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
          <button onClick={() => setShown(s => !s)} className="text-muted-foreground hover:text-foreground transition-colors p-1">
            {shown ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          <button onClick={onDelete} className="text-muted-foreground hover:text-red-400 transition-colors p-1">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={copyCode}
            className="flex-1 font-mono text-3xl font-bold tracking-[0.3em] text-foreground hover:text-primary transition-colors text-left"
          >
            {code === "------" ? "──────" : code.slice(0, 3) + " " + code.slice(3)}
          </button>
          <button onClick={copyCode} className={`transition-colors flex-shrink-0 ${copied ? "text-green-400" : "text-muted-foreground hover:text-primary"}`}>
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          </button>
        </div>
        <div className="space-y-1">
          <Progress
            value={progress}
            className={`h-1 ${isExpiring ? "[&>div]:bg-red-500" : "[&>div]:bg-primary"}`}
          />
          <div className="flex justify-between items-center">
            <span className={`text-[10px] font-mono ${isExpiring ? "text-red-400" : "text-muted-foreground"}`}>
              {isExpiring ? "⚠ Expires in" : "Refreshes in"} {timeLeft}s
            </span>
            {prevCode !== "------" && (
              <span className="text-[9px] font-mono text-muted-foreground/50 line-through">{prevCode}</span>
            )}
          </div>
        </div>
        {shown && (
          <div className="mt-2 pt-2 border-t border-border">
            <div className="text-[9px] font-mono text-muted-foreground/50 uppercase tracking-widest mb-1">Secret (hidden)</div>
            <div className="text-[10px] font-mono text-muted-foreground bg-muted/30 rounded px-2 py-1 break-all">{entry.secret}</div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const STORAGE_KEY = "ayzen_totp_entries";

function loadEntries(): TOTPEntry[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch { return []; }
}

function saveEntries(entries: TOTPEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export default function Authenticator() {
  const [entries, setEntries] = useState<TOTPEntry[]>(loadEntries);
  const [open, setOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", issuer: "", secret: "" });
  const [secretError, setSecretError] = useState("");
  const { toast } = useToast();

  const handleAdd = async () => {
    if (!form.label || !form.secret) {
      toast({ variant: "destructive", title: "Missing fields", description: "Label and secret are required." });
      return;
    }
    const code = await generateTOTP(form.secret.trim());
    if (code === "------") {
      setSecretError("Invalid TOTP secret. Must be a valid Base32 string.");
      return;
    }
    const entry: TOTPEntry = {
      id: crypto.randomUUID(),
      label: form.label.trim(),
      issuer: form.issuer.trim(),
      secret: form.secret.trim().toUpperCase(),
      createdAt: new Date().toISOString(),
    };
    const updated = [...entries, entry];
    setEntries(updated);
    saveEntries(updated);
    toast({ title: "Authenticator added", description: `${entry.label} is now generating codes.` });
    setOpen(false);
    setForm({ label: "", issuer: "", secret: "" });
    setSecretError("");
  };

  const handleDelete = (id: string) => {
    const updated = entries.filter(e => e.id !== id);
    setEntries(updated);
    saveEntries(updated);
    setDeleteId(null);
    toast({ title: "Removed", description: "Authenticator entry deleted." });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-primary" /> 2FA Authenticator
          </h1>
          <p className="text-muted-foreground font-mono text-xs mt-1">Live TOTP code generator for all your accounts</p>
        </div>
        <Button className="font-mono uppercase text-xs tracking-wider gap-2 self-start sm:self-auto" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add Account
        </Button>
      </div>

      {entries.length === 0 ? (
        <div className="py-16 text-center font-mono text-muted-foreground bg-card border border-card-border border-dashed rounded-md flex flex-col items-center justify-center gap-3">
          <ShieldCheck className="h-12 w-12 text-muted-foreground opacity-20" />
          <div>
            <div className="font-bold mb-1">No authenticators yet</div>
            <div className="text-xs text-muted-foreground/70">Add your TOTP secrets to generate live 2FA codes</div>
          </div>
          <Button size="sm" className="font-mono text-xs mt-2 gap-2" onClick={() => setOpen(true)}>
            <Plus className="h-3 w-3" /> Add First Account
          </Button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(entry => (
            <TOTPCard key={entry.id} entry={entry} onDelete={() => setDeleteId(entry.id)} />
          ))}
        </div>
      )}

      {/* Add Dialog */}
      <Dialog open={open} onOpenChange={o => { setOpen(o); setSecretError(""); }}>
        <DialogContent className="bg-card border-card-border max-w-md">
          <DialogHeader>
            <DialogTitle className="font-mono uppercase tracking-wider text-primary flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" /> Add Authenticator
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Account Label *</Label>
              <Input
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                className="font-mono text-xs h-10 border-border bg-input"
                placeholder="e.g. zkSync Gmail / Discord"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Issuer / Platform</Label>
              <Input
                value={form.issuer}
                onChange={e => setForm(f => ({ ...f, issuer: e.target.value }))}
                className="font-mono text-xs h-10 border-border bg-input"
                placeholder="e.g. Google, Discord, Twitter"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">TOTP Secret Key *</Label>
              <Input
                value={form.secret}
                onChange={e => { setForm(f => ({ ...f, secret: e.target.value })); setSecretError(""); }}
                className={`font-mono text-xs h-10 border-border bg-input tracking-widest ${secretError ? "border-red-500" : ""}`}
                placeholder="JBSWY3DPEHPK3PXP"
              />
              {secretError && <p className="text-[10px] font-mono text-red-400">{secretError}</p>}
              <p className="text-[10px] font-mono text-muted-foreground/60">
                Scan QR code in your app, or enter the secret key shown during 2FA setup.
              </p>
            </div>
            <div className="bg-muted/20 border border-border rounded-md p-3 text-[10px] font-mono text-muted-foreground space-y-1">
              <div className="text-primary font-bold uppercase tracking-widest mb-2">How to get your secret</div>
              <div>1. Go to the site's 2FA settings</div>
              <div>2. Choose "Setup Authenticator App"</div>
              <div>3. Copy the secret key shown (not the QR code)</div>
              <div>4. Paste it here above</div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} className="font-mono text-xs border-border">Cancel</Button>
            <Button onClick={handleAdd} className="font-mono text-xs gap-2">
              <ShieldCheck className="w-3 h-3" /> Add Account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={deleteId !== null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="bg-card border-card-border max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm text-red-400">Remove Authenticator</DialogTitle>
          </DialogHeader>
          <p className="text-xs font-mono text-muted-foreground">This account will be removed from your authenticator. Make sure you have a backup before removing.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} className="font-mono text-xs border-border">Cancel</Button>
            <Button variant="destructive" onClick={() => deleteId && handleDelete(deleteId)} className="font-mono text-xs">Remove</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
