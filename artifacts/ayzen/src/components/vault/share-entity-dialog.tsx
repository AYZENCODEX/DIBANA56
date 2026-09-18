import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Share2, Loader2, User, ListChecks, LayoutGrid } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { customFetch } from "@workspace/api-client-react";

export type VaultEntityType = "local" | "entity" | "kyc" | "game";

export interface ShareTarget {
  entityType: VaultEntityType;
  entityId: number;
}

type FieldPermission = "view" | "edit";
type FieldPermissionMap = Record<string, FieldPermission>;

/** Turns a raw db column name into something readable, e.g. "email_backup_code" -> "Email Backup Code". */
function humanizeField(field: string): string {
  return field.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Create-a-share dialog. Pass a single item via `items={[{ entityType, entityId }]}`
 * or many for a bulk share (same or mixed types) — the same dialog drives both.
 * Ownership of the underlying item never changes; this only grants another
 * user access, which the owner can turn off later from ManageSharesDialog.
 *
 * Sharing mode: "Whole item" grants the classic view/edit access to every
 * field. "Specific fields" (single-item shares only — field sets differ
 * per entity type, so this doesn't make sense across a mixed bulk batch)
 * lets the owner pick exactly which fields the recipient can see, and
 * whether each one is view-only or editable — e.g. share just the
 * username + email of an account without exposing its 2FA/backup codes.
 */
export function ShareEntityDialog({
  open, onClose, items, entityLabel, onShared,
}: {
  open: boolean;
  onClose: () => void;
  items: ShareTarget[];
  /** Optional human label shown in the dialog, e.g. an account name — only used for single-item shares. */
  entityLabel?: string;
  onShared?: () => void;
}) {
  const [username, setUsername] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("view");
  const [mode, setMode] = useState<"whole" | "fields">("whole");
  const [availableFields, setAvailableFields] = useState<string[]>([]);
  const [sensitiveFields, setSensitiveFields] = useState<string[]>([]);
  const [fieldPerms, setFieldPerms] = useState<FieldPermissionMap>({});
  const [loadingFields, setLoadingFields] = useState(false);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const isBulk = items.length > 1;
  const singleEntityType = !isBulk ? items[0]?.entityType : undefined;

  const reset = () => { setUsername(""); setPermission("view"); setMode("whole"); setFieldPerms({}); };

  // Load the shareable field list for this entity type whenever the dialog
  // opens on a single item — needed to render the per-field picker.
  useEffect(() => {
    if (!open || isBulk || !singleEntityType) return;
    let cancelled = false;
    setLoadingFields(true);
    customFetch<{ fields: string[]; sensitiveFields: string[] }>(`/api/vault-shares/fields/${singleEntityType}`)
      .then((data) => {
        if (cancelled) return;
        setAvailableFields(data.fields);
        setSensitiveFields(data.sensitiveFields ?? []);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingFields(false); });
    return () => { cancelled = true; };
  }, [open, isBulk, singleEntityType]);

  const toggleField = (field: string, checked: boolean) => {
    setFieldPerms((prev) => {
      const next = { ...prev };
      if (checked) next[field] = next[field] ?? "view";
      else delete next[field];
      return next;
    });
  };

  const setFieldPermLevel = (field: string, level: FieldPermission) => {
    setFieldPerms((prev) => ({ ...prev, [field]: level }));
  };

  const submit = async () => {
    if (!username.trim()) { toast({ variant: "destructive", title: "Enter a username or email to share with" }); return; }
    if (!items.length) return;
    if (mode === "fields" && Object.keys(fieldPerms).length === 0) {
      toast({ variant: "destructive", title: "Select at least one field to share" }); return;
    }
    setSaving(true);
    try {
      const fieldPermissions = mode === "fields" ? fieldPerms : undefined;
      if (isBulk) {
        const data = await customFetch<{ sharedCount: number; failedCount: number; failed: { reason: string }[] }>(
          "/api/vault-shares/bulk",
          { method: "POST", body: JSON.stringify({ items, username: username.trim(), permission }) }
        );
        if (data.sharedCount > 0) {
          toast({
            title: `Shared ${data.sharedCount} item${data.sharedCount === 1 ? "" : "s"}`,
            description: data.failedCount ? `${data.failedCount} item(s) couldn't be shared.` : undefined,
          });
        } else {
          toast({ variant: "destructive", title: "Nothing was shared", description: data.failed?.[0]?.reason });
        }
      } else {
        await customFetch("/api/vault-shares", {
          method: "POST",
          body: JSON.stringify({ entityType: items[0].entityType, entityId: items[0].entityId, username: username.trim(), permission, fieldPermissions }),
        });
        toast({
          title: "Shared",
          description: mode === "fields"
            ? `${Object.keys(fieldPerms).length} field(s) of ${entityLabel ?? "this item"} shared with ${username.trim()}.`
            : `${entityLabel ?? "This item"} is now shared with ${username.trim()}.`,
        });
      }
      reset();
      onShared?.();
      onClose();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to share", description: err?.data?.error ?? err?.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm flex items-center gap-2">
            <Share2 className="w-4 h-4 text-primary" />
            {isBulk ? `Share ${items.length} Items` : "Share Item"}
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px]">
            {isBulk
              ? "Grant another user access to the selected items. Ownership stays with you."
              : `Grant another user access to ${entityLabel ?? "this item"}. Ownership stays with you.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Share with (username or email)</Label>
            <div className="relative">
              <User className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40" />
              <Input
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="e.g. teammate01"
                className="pl-8 font-mono text-xs"
                autoFocus
              />
            </div>
          </div>

          {!isBulk && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Share scope</Label>
              <RadioGroup value={mode} onValueChange={(v: any) => setMode(v)} className="grid grid-cols-2 gap-2">
                <label className={`flex items-center gap-1.5 border rounded-md px-2.5 py-1.5 cursor-pointer font-mono text-[11px] ${mode === "whole" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <RadioGroupItem value="whole" className="w-3 h-3" />
                  <LayoutGrid className="w-3 h-3 text-muted-foreground" /> Whole item
                </label>
                <label className={`flex items-center gap-1.5 border rounded-md px-2.5 py-1.5 cursor-pointer font-mono text-[11px] ${mode === "fields" ? "border-primary bg-primary/5" : "border-border"}`}>
                  <RadioGroupItem value="fields" className="w-3 h-3" />
                  <ListChecks className="w-3 h-3 text-muted-foreground" /> Specific fields
                </label>
              </RadioGroup>
            </div>
          )}

          {mode === "whole" && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">Access level</Label>
              <Select value={permission} onValueChange={(v: any) => setPermission(v)}>
                <SelectTrigger className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="view" className="font-mono text-xs">View only</SelectItem>
                  <SelectItem value="edit" className="font-mono text-xs">Can edit</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {mode === "fields" && !isBulk && (
            <div className="space-y-1.5">
              <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/60">
                Fields to share {Object.keys(fieldPerms).length > 0 && `(${Object.keys(fieldPerms).length} selected)`}
              </Label>
              {loadingFields ? (
                <div className="flex items-center justify-center py-6 text-muted-foreground/60">
                  <Loader2 className="w-4 h-4 animate-spin" />
                </div>
              ) : (
                <ScrollArea className="h-52 rounded-md border border-border">
                  <div className="p-2 space-y-1">
                    {availableFields.map((field) => {
                      const checked = field in fieldPerms;
                      const isSensitive = sensitiveFields.includes(field);
                      return (
                        <div key={field} className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
                          <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                            <Checkbox
                              checked={checked}
                              onCheckedChange={(v) => toggleField(field, !!v)}
                              className="shrink-0"
                            />
                            <span className="font-mono text-[11px] truncate">{humanizeField(field)}</span>
                            {isSensitive && <span className="text-[9px] font-mono uppercase tracking-wider text-amber-500/80 shrink-0">credential</span>}
                          </label>
                          {checked && (
                            <Select value={fieldPerms[field]} onValueChange={(v: any) => setFieldPermLevel(field, v)}>
                              <SelectTrigger className="h-6 w-[72px] font-mono text-[10px] shrink-0">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="view" className="font-mono text-[10px]">View</SelectItem>
                                <SelectItem value="edit" className="font-mono text-[10px]">Edit</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </ScrollArea>
              )}
              <p className="text-[10px] font-mono text-muted-foreground/50">Unchecked fields stay completely hidden from the recipient.</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} className="font-mono text-xs">Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving} className="font-mono text-xs gap-1.5">
            {saving && <Loader2 className="w-3 h-3 animate-spin" />} Share
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
