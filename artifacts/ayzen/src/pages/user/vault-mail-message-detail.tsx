import { useState, useEffect } from "react";
import { useParams, useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { ArrowLeft, Mail, Loader2, User, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";

interface StoredMessageDetail {
  id: number; from: string; to: string; subject: string; body: string | null; date: string | null;
}

export default function VaultMailMessage() {
  const params = useParams<{ category: string; id: string; msgId: string }>();
  const [, navigate] = useLocation();
  const { token } = useAuth();
  const [msg, setMsg] = useState<StoredMessageDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${BASE}/api/mail-messages/${params.msgId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (!r.ok) throw new Error("Message not found");
        return r.json();
      })
      .then(setMsg)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [params.msgId, token]);

  return (
    <div className="space-y-5 page-enter max-w-2xl">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="h-8 w-8 flex-shrink-0" onClick={() => navigate(`/vault/mail-hub/${params.category}/${params.id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <h1 className="text-lg font-bold font-mono tracking-tighter flex items-center gap-2">
          <Mail className="w-4 h-4 text-primary" /> Email
        </h1>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
      ) : error || !msg ? (
        <div className="text-center py-16 space-y-2">
          <Mail className="w-8 h-8 text-muted-foreground/30 mx-auto" />
          <p className="font-mono text-xs text-muted-foreground/50">{error ?? "Message not found"}</p>
        </div>
      ) : (
        <div className="bg-card border border-card-border rounded-xl p-5 space-y-4">
          <div className="space-y-1.5">
            <h2 className="font-mono text-sm font-bold">{msg.subject || "(no subject)"}</h2>
            <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
              <User className="w-3 h-3" /> {msg.from}
            </div>
            {msg.date && (
              <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/40">
                <Calendar className="w-3 h-3" /> {new Date(msg.date).toLocaleString()}
              </div>
            )}
          </div>
          <div className="border-t border-border/40 pt-4">
            <pre className="font-mono text-xs whitespace-pre-wrap break-words text-foreground/90 leading-relaxed">
              {msg.body || "(empty body — try Sync from the entity page to refetch)"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
