/**
 * emergency-access/confirm.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 * Public, unauthenticated landing page for the "Confirm this nomination"
 * link mailed to a would-be trusted contact (routes/emergency-access.ts
 * POST /emergency-access/confirm/:token). Lives outside /vault and outside
 * the authenticated app shell entirely — the contact may not even have an
 * AYZEN account. The token itself is the only auth; this page just calls
 * the confirm endpoint once on mount and reports the result.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { HeartPulse, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { confirmEmergencyContactInvite } from "@/lib/emergency-access-api";

type Status = "confirming" | "confirmed" | "error";

export default function EmergencyAccessConfirm() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>("confirming");
  const [errorMessage, setErrorMessage] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setStatus("error"); setErrorMessage("Missing confirmation link."); return; }
    confirmEmergencyContactInvite(token)
      .then(() => setStatus("confirmed"))
      .catch((err: any) => {
        setStatus("error");
        setErrorMessage(err?.message ?? "This confirmation link is invalid or has already been used.");
      });
  }, [token]);

  return (
    <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 z-0 opacity-[0.02]"
        style={{ backgroundImage: "linear-gradient(to right, #808080 1px, transparent 1px), linear-gradient(to bottom, #808080 1px, transparent 1px)", backgroundSize: "40px 40px" }} />

      <div className="w-full max-w-md space-y-8 relative z-10">
        <div className="text-center">
          <div className="flex justify-center mb-6">
            <div className={`w-16 h-16 rounded-xl flex items-center justify-center border shadow-2xl ${
              status === "confirmed" ? "bg-emerald-500/10 border-emerald-500/20" :
              status === "error" ? "bg-red-500/10 border-red-500/20" :
              "bg-primary/10 border-primary/20"
            }`}>
              {status === "confirming" && <Loader2 className="w-8 h-8 text-primary animate-spin" />}
              {status === "confirmed" && <CheckCircle2 className="w-8 h-8 text-emerald-400" />}
              {status === "error" && <XCircle className="w-8 h-8 text-red-400" />}
            </div>
          </div>
          <h1 className="text-3xl font-mono font-bold tracking-tighter text-foreground mb-2">Emergency Access</h1>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest">Trusted Contact Confirmation</p>
        </div>

        <div className="bg-card border border-card-border p-8 shadow-2xl relative text-center">
          <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-primary to-transparent opacity-40" />

          {status === "confirming" && (
            <p className="font-mono text-sm text-muted-foreground">Confirming your nomination...</p>
          )}

          {status === "confirmed" && (
            <div className="space-y-3">
              <p className="font-mono text-sm text-foreground font-bold">You're confirmed as a trusted contact.</p>
              <p className="font-mono text-xs text-muted-foreground leading-relaxed">
                Nothing further is needed right now. If the owner goes inactive past their wait period, you'll
                become eligible to request access — and an admin still has to approve it before anything is shared.
              </p>
              <div className="flex items-center justify-center gap-2 pt-2 text-muted-foreground/50">
                <HeartPulse className="w-3.5 h-3.5" />
                <span className="font-mono text-[10px] uppercase tracking-widest">AYZEN Vault</span>
              </div>
            </div>
          )}

          {status === "error" && (
            <div className="space-y-3">
              <p className="font-mono text-sm text-red-400 font-bold">Couldn't confirm this link</p>
              <p className="font-mono text-xs text-muted-foreground leading-relaxed">{errorMessage}</p>
              <p className="font-mono text-[10px] text-muted-foreground/50">
                Links are single-use and expire once acted on. If you think this is a mistake, ask the person who
                nominated you to send a new invite.
              </p>
            </div>
          )}
        </div>

        <div className="text-center font-mono text-sm text-muted-foreground">
          <Link href="/login" className="text-primary hover:underline">Go to AYZEN</Link>
        </div>
      </div>
    </div>
  );
}
