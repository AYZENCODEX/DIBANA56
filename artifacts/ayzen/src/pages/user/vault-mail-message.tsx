import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Mail, Loader2, ChevronLeft, AlertCircle, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface InboxBody { seqno: number; subject: string; from: string; date: string; body: string; }

function extractVerificationCodes(text: string): string[] {
  return [...new Set(text.match(/\b\d{4,8}\b/g) ?? [])].slice(0, 6);
}

// ─── Full-page single email view ───────────────────────────────────────────────
export default function VaultMailMessage() {
  const params = useParams<{ accountId: string; seqno: string }>();
  const [, navigate] = useLocation();
  const { token } = useAuth();

  const [msg, setMsg] = useState<InboxBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const { accountId, seqno } = params;

  useEffect(() => {
    setLoading(true); setError(null);
    fetch(`${BASE}/api/email-accounts/${accountId}/fetch-body`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ seqno: Number(seqno) }),
    })
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.detail ?? data.error ?? "Failed to load email");
        setMsg(data);
      })
      .catch(e => setError(e.message ?? "Failed to load email"))
      .finally(() => setLoading(false));
  }, [accountId, seqno, token]);

  const copyCode = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  };

  const goBack = () => navigate(`/vault/mail/${accountId}`);

  const codes = msg ? extractVerificationCodes(msg.body || "") : [];

  return (
    <div className="space-y-4 page-enter max-w-3xl">
      <Button variant="ghost" size="sm" onClick={goBack} className="font-mono text-xs gap-1.5 -ml-2">
        <ChevronLeft className="w-3.5 h-3.5" /> Back to Inbox
      </Button>

      {loading && (
        <div className="flex items-center justify-center min-h-[40vh]">
          <Loader2 className="w-6 h-6 text-primary animate-spin" />
        </div>
      )}

      {!loading && error && (
        <div className="flex items-start gap-2 text-red-400 bg-red-500/5 border border-red-500/20 rounded-xl px-4 py-3">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-mono text-xs font-bold">Couldn't load this email</p>
            <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">{error}</p>
          </div>
        </div>
      )}

      {!loading && !error && msg && (
        <div className="bg-card border border-card-border rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-border/20 space-y-1.5">
            <div className="flex items-center gap-2">
              <Mail className="w-4 h-4 text-primary flex-shrink-0" />
              <p className="font-mono text-sm font-bold text-foreground">{msg.subject}</p>
            </div>
            <p className="font-mono text-[10px] text-muted-foreground/60">From: {msg.from}</p>
            <p className="font-mono text-[10px] text-muted-foreground/40">{msg.date}</p>
          </div>

          {codes.length > 0 && (
            <div className="px-5 py-3 border-b border-border/20 bg-amber-400/5 flex flex-wrap items-center gap-2">
              <span className="font-mono text-[9px] uppercase tracking-widest text-amber-300/70">Codes found</span>
              {codes.map(code => (
                <button key={code} onClick={() => copyCode(code)}
                  className="flex items-center gap-1 font-mono text-[11px] font-bold px-2 py-1 rounded bg-amber-400/10 text-amber-300 border border-amber-400/25 hover:bg-amber-400/20">
                  {code}
                  {copied === code ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
              ))}
            </div>
          )}

          <div className="px-5 py-4">
            <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed break-words">
              {msg.body || "(empty)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
