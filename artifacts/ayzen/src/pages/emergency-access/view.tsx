/**
 * emergency-access/view.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 * Public, unauthenticated landing page for the single-use "View the vault"
 * link mailed to a contact once an admin approves their grant
 * (routes/emergency-access.ts GET /emergency-access/view/:token). Outside
 * /vault and outside the authenticated app shell — the contact authenticates
 * with nothing but the bearer token in the URL, so this route can't reuse
 * VaultUnlockGate or any session-based layout. Read-only, no edit affordances
 * anywhere on this page.
 */
import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { HeartPulse, Loader2, XCircle, ShieldAlert, Clock, KeyRound } from "lucide-react";
import { viewEmergencyAccessVault } from "@/lib/emergency-access-api";

type Status = "loading" | "loaded" | "error";

const HIDDEN_FIELDS = new Set(["id", "userId", "dataEntityId", "category", "createdAt", "updatedAt", "deletedAt"]);
const LABEL_OVERRIDES: Record<string, string> = {
  projectName: "Project",
  entitySerial: "Entity ID",
  accountPassword: "Account Password",
  email2fa: "Email 2FA",
  account2fa: "Account 2FA",
};

function labelFor(key: string): string {
  if (LABEL_OVERRIDES[key]) return LABEL_OVERRIDES[key];
  const spaced = key.replace(/([A-Z])/g, " $1").replace(/\b2fa\b/i, "2FA");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function entryFields(entry: Record<string, any>): Array<[string, string]> {
  return Object.entries(entry)
    .filter(([k, v]) => !HIDDEN_FIELDS.has(k) && v !== null && v !== undefined && String(v).trim() !== "")
    .map(([k, v]) => [labelFor(k), String(v)]);
}

export default function EmergencyAccessView() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [entries, setEntries] = useState<Record<string, any>[]>([]);
  const [viewedAt, setViewedAt] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setStatus("error"); setErrorMessage("Missing access link."); return; }
    viewEmergencyAccessVault(token)
      .then(res => {
        setEntries(res.entries ?? []);
        setViewedAt(res.viewedAt);
        setExpiresAt(res.expiresAt);
        setStatus("loaded");
      })
      .catch((err: any) => {
        setStatus("error");
        setErrorMessage(err?.message ?? "This link is invalid, already used up its window, or has expired.");
      });
  }, [token]);

  if (status === "loading") {
    return (
      <div className="min-h-screen w-full bg-background flex items-center justify-center p-4">
        <div className="text-center space-y-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin mx-auto" />
          <p className="font-mono text-xs text-muted-foreground uppercase tracking-widest">Decrypting vault export...</p>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="min-h-screen w-full bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-6 text-center">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-xl flex items-center justify-center border bg-red-500/10 border-red-500/20">
              <XCircle className="w-8 h-8 text-red-400" />
            </div>
          </div>
          <h1 className="text-2xl font-mono font-bold tracking-tighter text-foreground">Access Unavailable</h1>
          <div className="bg-card border border-card-border p-6 space-y-2">
            <p className="font-mono text-sm text-red-400 font-bold">{errorMessage}</p>
            <p className="font-mono text-[10px] text-muted-foreground/50">
              This link is single-use per session and expires 30 days after approval. Reach out to whoever manages
              this account if you believe access should still be valid.
            </p>
          </div>
          <Link href="/login" className="font-mono text-sm text-primary hover:underline">Go to AYZEN</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full bg-background p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap border-b border-border/40 pb-5">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <HeartPulse className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-mono font-bold tracking-tight text-foreground">Emergency Vault Access</h1>
              <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-widest">Read-only export</p>
            </div>
          </div>
          <div className="text-right font-mono text-[10px] text-muted-foreground/60 space-y-0.5">
            <div className="flex items-center gap-1 justify-end"><Clock className="w-3 h-3" /> Viewed {new Date(viewedAt).toLocaleString()}</div>
            {expiresAt && <div>Link expires {new Date(expiresAt).toLocaleDateString()}</div>}
          </div>
        </div>

        <div className="bg-amber-500/5 border border-amber-500/25 rounded-lg p-3 flex items-start gap-2.5">
          <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="font-mono text-[11px] text-muted-foreground">
            This is a one-time, read-only export approved by an AYZEN admin. Nothing here can be edited from this
            page, and every view is logged against the account owner.
          </p>
        </div>

        {entries.length === 0 ? (
          <div className="bg-card border border-card-border rounded-lg px-6 py-12 text-center">
            <KeyRound className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="font-mono text-sm text-muted-foreground">No active vault entries to show</p>
          </div>
        ) : (
          <div className="space-y-3">
            {entries.map((entry, i) => {
              const fields = entryFields(entry);
              const title = entry.projectName ?? `Entry ${i + 1}`;
              return (
                <div key={entry.id ?? i} className="bg-card border border-card-border rounded-lg overflow-hidden">
                  <div className="px-4 py-3 border-b border-border/30 bg-muted/10 flex items-center justify-between">
                    <span className="font-mono text-sm font-bold text-foreground">{title}</span>
                    {entry.entitySerial && (
                      <span className="font-mono text-[10px] text-muted-foreground/50">{entry.entitySerial}</span>
                    )}
                  </div>
                  <div className="px-4 py-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                    {fields.map(([label, value]) => (
                      <div key={label} className="min-w-0">
                        <div className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground/50">{label}</div>
                        <div className="font-mono text-xs text-foreground break-all">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
