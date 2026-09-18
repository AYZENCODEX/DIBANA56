/**
 * vault-emergency-access.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 *
 * Owner-facing half of routes/emergency-access.ts: nominate trusted
 * contacts with an inactivity threshold, see any grants the dead-man-switch
 * cron has triggered, and cancel a grant (proof of life) before an admin
 * acts on it. The contact's confirm/view links and the admin review queue
 * live outside this page (public token links, admin console respectively).
 */
import { useEffect, useState } from "react";
import { HeartPulse, Plus, Trash2, Loader2, Clock, ShieldAlert, XCircle, Mail } from "lucide-react";
import { VaultSectionPage, VaultSectionEmptyState } from "@/components/layout/vault-sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  listEmergencyContacts, addEmergencyContact, revokeEmergencyContact,
  listEmergencyGrants, cancelEmergencyGrant,
  type EmergencyContact, type EmergencyAccessGrant,
} from "@/lib/emergency-access-api";

const GRANT_STATUS_LABEL: Record<EmergencyAccessGrant["status"], string> = {
  pending_admin_review: "Pending admin review",
  approved: "Approved — access granted",
  denied: "Denied",
  cancelled: "Cancelled by you",
  expired: "Expired",
  revoked: "Revoked",
};

export default function VaultEmergencyAccess() {
  const { toast } = useToast();
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [grants, setGrants] = useState<EmergencyAccessGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);

  function refresh() {
    setLoading(true);
    Promise.all([listEmergencyContacts(), listEmergencyGrants()])
      .then(([c, g]) => { setContacts(c.items); setGrants(g.items); })
      .catch(() => toast({ title: "Couldn't load emergency access settings", variant: "destructive" }))
      .finally(() => setLoading(false));
  }

  useEffect(refresh, []);

  async function handleRevoke(id: number) {
    try {
      await revokeEmergencyContact(id);
      toast({ title: "Contact revoked" });
      refresh();
    } catch {
      toast({ title: "Couldn't revoke contact", variant: "destructive" });
    }
  }

  async function handleCancelGrant(id: number) {
    try {
      await cancelEmergencyGrant(id);
      toast({ title: "Request cancelled", description: "Good to know you're okay — the pending grant has been cancelled." });
      refresh();
    } catch {
      toast({ title: "Couldn't cancel this request", variant: "destructive" });
    }
  }

  const pendingGrants = grants.filter(g => g.status === "pending_admin_review");
  const otherGrants = grants.filter(g => g.status !== "pending_admin_review");

  return (
    <VaultSectionPage
      title="Emergency Access"
      description="Nominate a trusted contact who can request access if you go inactive"
      icon={HeartPulse}
      headerExtra={
        <Button size="sm" className="font-mono text-xs gap-1.5" onClick={() => setAddOpen(true)}>
          <Plus className="w-3.5 h-3.5" /> Add Contact
        </Button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 text-primary animate-spin" /></div>
      ) : (
        <div className="space-y-4">
          {pendingGrants.length > 0 && (
            <div className="space-y-2">
              {pendingGrants.map(g => {
                const contact = contacts.find(c => c.id === g.contactId);
                return (
                  <div key={g.id} className="bg-amber-500/5 border border-amber-500/25 rounded-lg p-3 flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-start gap-2.5">
                      <ShieldAlert className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                      <div>
                        <p className="font-mono text-xs text-amber-400 font-bold">Emergency access triggered</p>
                        <p className="font-mono text-[10px] text-muted-foreground/60 mt-0.5">
                          {contact?.contactName ?? "A nominated contact"} is eligible after inactivity. Triggered {new Date(g.triggeredAt).toLocaleString()}.
                          Still needs admin approval — cancel below if you're okay.
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline" size="sm" className="font-mono text-xs gap-1.5 border-amber-500/30 text-amber-400 flex-shrink-0"
                      onClick={() => handleCancelGrant(g.id)}
                    >
                      <XCircle className="w-3.5 h-3.5" /> I'm here — cancel
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-mono uppercase tracking-wide flex items-center gap-2">
                <HeartPulse className="w-4 h-4 text-primary/70" /> Trusted Contacts
              </CardTitle>
              <CardDescription className="font-mono text-xs">
                If you're inactive past a contact's wait period, they become eligible to request vault
                access — final access still requires admin approval.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {contacts.length === 0 ? (
                <VaultSectionEmptyState
                  icon={HeartPulse}
                  title="No trusted contacts yet"
                  note="Add a contact so someone you trust can request access if something happens to you."
                />
              ) : (
                <div className="space-y-2">
                  {contacts.map(c => (
                    <div key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/30 bg-card">
                      <div className="min-w-0 flex items-center gap-2.5">
                        <Mail className="w-4 h-4 text-muted-foreground/50 flex-shrink-0" />
                        <div className="min-w-0">
                          <p className="font-mono text-xs font-bold truncate">{c.contactName}</p>
                          <p className="font-mono text-[10px] text-muted-foreground/50 truncate">{c.contactEmail}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2.5 flex-shrink-0">
                        <span className="font-mono text-[10px] text-muted-foreground/60 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {c.waitDays}d
                        </span>
                        <span className={`font-mono text-[9px] uppercase px-1.5 py-0.5 rounded ${c.confirmedAt ? "bg-emerald-500/10 text-emerald-400" : "bg-muted/30 text-muted-foreground/50"}`}>
                          {c.confirmedAt ? "Confirmed" : "Awaiting confirmation"}
                        </span>
                        {c.status === "active" && (
                          <button onClick={() => handleRevoke(c.id)} className="text-muted-foreground/40 hover:text-red-400 transition-colors">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {otherGrants.length > 0 && (
            <Card className="border-dashed border-border/40 bg-muted/10">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-mono uppercase tracking-wide">Past Requests</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {otherGrants.map(g => (
                  <div key={g.id} className="flex items-center justify-between font-mono text-[10px] text-muted-foreground/60">
                    <span>{new Date(g.triggeredAt).toLocaleDateString()}</span>
                    <span>{GRANT_STATUS_LABEL[g.status]}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {addOpen && (
        <AddContactDialog
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); refresh(); }}
        />
      )}
    </VaultSectionPage>
  );
}

function AddContactDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [waitDays, setWaitDays] = useState("30");
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    if (!name.trim()) { toast({ title: "Enter a contact name", variant: "destructive" }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast({ title: "Enter a valid email", variant: "destructive" }); return; }
    const days = Number(waitDays);
    if (!Number.isFinite(days) || days < 3 || days > 365) { toast({ title: "Wait days must be between 3 and 365", variant: "destructive" }); return; }

    setBusy(true);
    try {
      await addEmergencyContact(name.trim(), email.trim(), days);
      toast({ title: "Invite sent", description: `${email.trim()} needs to confirm before this nomination is active.` });
      onSaved();
    } catch (err: any) {
      toast({ title: "Couldn't add contact", description: err?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="font-mono">
        <DialogHeader>
          <DialogTitle>Add Trusted Contact</DialogTitle>
          <DialogDescription>They'll get an email to confirm before this nomination is active.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Name</Label>
            <Input value={name} onChange={e => setName(e.target.value)} className="text-sm" placeholder="Jane Doe" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Email</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className="text-sm" placeholder="jane@example.com" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-widest text-muted-foreground/60">Wait days (inactivity before eligible)</Label>
            <Input type="number" min={3} max={365} value={waitDays} onChange={e => setWaitDays(e.target.value)} className="text-sm" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="font-mono text-xs" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="font-mono text-xs gap-1.5" disabled={busy} onClick={handleSave}>
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            Send Invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
