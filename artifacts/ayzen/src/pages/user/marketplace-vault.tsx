import { useState, useEffect, useCallback } from "react";
import { useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  Vault, Plus, X, ShoppingCart, Shield, Tag,
  Star, BarChart3, RefreshCw, Lock, Check,
  Database, Smartphone, ChevronRight, ShieldCheck, Gamepad2,
} from "lucide-react";
import { metricLabelFor } from "@/lib/entity-worth";
import { LOCAL_ACCOUNT_MARKET_CATEGORIES } from "@/config/vault-local";
import { LOCAL_ACCOUNT_BUY_FIELDS } from "@/config/fields/local-account-buy";
import { ENTITY_PLATFORM_META } from "@/config/marketplace";

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
const tok = () => localStorage.getItem("ayzen_token") ?? "";
const api = (p: string, o?: RequestInit) =>
  fetch(`${BASE}/api${p}`, { ...o, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok()}`, ...(o?.headers ?? {}) } });

// Account categories (LOCAL_ACCOUNT_MARKET_CATEGORIES), category-specific
// buy fields (LOCAL_ACCOUNT_BUY_FIELDS), and entity platform meta
// (ENTITY_PLATFORM_META) now live in @/config/vault-local.ts,
// @/config/fields/local-account-buy.ts, and @/config/marketplace.ts —
// imported above. Adding a category, a buy filter field, or an entity
// platform is one entry in the relevant file.

interface EntityPlatformRow {
  id: string; label: string; icon: React.ElementType; color: string; border: string; bg: string;
  metricLabel: string; metricValue: string; age: string; worth: string;
}

function getEntityPlatforms(entry: any): EntityPlatformRow[] {
  if (!entry) return [];
  const list: EntityPlatformRow[] = [];
  if (entry.twitterUsername || entry.twitter_username) {
    list.push({ id: "twitter", ...ENTITY_PLATFORM_META.twitter, metricLabel: "Followers", metricValue: entry.twitterFollowers ?? entry.twitter_followers ?? "", age: entry.twitterAge ?? entry.twitter_age ?? "", worth: entry.twitterWorth ?? entry.twitter_worth ?? "" });
  }
  if (entry.discordUsername || entry.discord_username) {
    list.push({ id: "discord", ...ENTITY_PLATFORM_META.discord, metricLabel: "Followers", metricValue: entry.discordFollowers ?? entry.discord_followers ?? "", age: entry.discordAge ?? entry.discord_age ?? "", worth: entry.discordWorth ?? entry.discord_worth ?? "" });
  }
  if (entry.telegramUsername || entry.telegram_username || entry.telegramPhone || entry.telegram_phone) {
    list.push({ id: "telegram", ...ENTITY_PLATFORM_META.telegram, metricLabel: "—", metricValue: "", age: entry.telegramAge ?? entry.telegram_age ?? "", worth: entry.telegramWorth ?? entry.telegram_worth ?? "" });
  }
  try {
    const raw = entry.otherAccounts ?? entry.other_accounts;
    const others = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
    if (Array.isArray(others)) {
      others.forEach((o: any, i: number) => {
        if (o?.platform) {
          list.push({
            id: `other-${i}-${o.platform}`, label: o.platform, icon: Database,
            color: "text-purple-400", border: "border-purple-400/30", bg: "bg-purple-400/10",
            metricLabel: metricLabelFor(o.platform), metricValue: o.metric ?? "", age: o.age ?? "", worth: o.worth ?? "",
          });
        }
      });
    }
  } catch { /* ignore malformed json */ }
  return list;
}

// ── Create Buy Order Modal ────────────────────────────────────────────────────
function BuyOrderModal({ vaultType, onClose, onSuccess }: { vaultType: "entity" | "local" | "kyc" | "game"; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const isEntity = vaultType === "entity";
  const [step, setStep] = useState<"category" | "platforms" | "details" | "price">(isEntity ? "platforms" : "category");
  const [category, setCategory] = useState("");
  const [details, setDetails] = useState<Record<string, any>>({});
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [creating, setCreating] = useState(false);

  // Entity flow: multi-select which platforms the buyer wants, with a min-metric filter each.
  const [platformSel, setPlatformSel] = useState<Record<string, boolean>>({});
  const [platformFilters, setPlatformFilters] = useState<Record<string, { minMetric: string; minAge: string }>>({});
  const [otherPlatformName, setOtherPlatformName] = useState("");

  const fields = LOCAL_ACCOUNT_BUY_FIELDS[category] ?? [];
  const catDef = LOCAL_ACCOUNT_MARKET_CATEGORIES.find(c => c.id === category);
  const selectedPlatformIds = Object.keys(platformSel).filter(k => platformSel[k]);

  const togglePlatform = (id: string) => setPlatformSel(p => ({ ...p, [id]: !p[id] }));
  const setFilter = (id: string, key: "minMetric" | "minAge", value: string) =>
    setPlatformFilters(p => ({ ...p, [id]: { minMetric: p[id]?.minMetric ?? "", minAge: p[id]?.minAge ?? "", [key]: value } }));

  const handleCreate = async () => {
    if (!priceMin || !priceMax) { toast({ title: "Set price range" }); return; }
    if (isEntity && selectedPlatformIds.length === 0) { toast({ title: "Select at least one platform" }); return; }
    setCreating(true);
    try {
      const payload = isEntity ? {
        order_type: "buy",
        vault_type: vaultType,
        account_type: "entity",
        category: "Entity",
        title: `Looking for entity with ${selectedPlatformIds.map(id => ENTITY_PLATFORM_META[id]?.label ?? id).join(" + ")}`,
        account_details: {
          platforms: selectedPlatformIds.map(id => ({
            platform: id,
            label: ENTITY_PLATFORM_META[id]?.label ?? id,
            minMetric: platformFilters[id]?.minMetric || null,
            minAge: platformFilters[id]?.minAge || null,
          })),
        },
        price_min: Number(priceMin),
        price_max: Number(priceMax),
        price: Number(priceMin),
      } : {
        order_type: "buy",
        vault_type: vaultType,
        account_type: category,
        account_details: details,
        price_min: Number(priceMin),
        price_max: Number(priceMax),
        price: Number(priceMin),
      };
      const r = await api("/marketplace/vault/listings", { method: "POST", body: JSON.stringify(payload) });
      const d = await r.json();
      if (r.ok) { toast({ title: "Buy order created!" }); onSuccess(); onClose(); }
      else toast({ variant: "destructive", title: d.error });
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-primary/20 rounded-xl w-full max-w-md mx-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40 sticky top-0 bg-card">
          <div>
            <span className="font-mono font-bold text-sm">Create Buy Order</span>
            <div className="text-[10px] font-mono text-muted-foreground capitalize">{vaultType} account · {step}</div>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Entity: platform multi-select (replaces category for entities, which carry several platforms at once) */}
          {isEntity && step === "platforms" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">Select the platform(s) you're looking for on an entity account:</p>
              <div className="space-y-2">
                {Object.entries(ENTITY_PLATFORM_META).map(([id, meta]) => {
                  const Icon = meta.icon;
                  const selected = !!platformSel[id];
                  return (
                    <div key={id} className={cn("rounded-xl border transition-all", selected ? `${meta.bg} ${meta.border}` : "border-border/30")}>
                      <button onClick={() => togglePlatform(id)} className="w-full flex items-center gap-3 p-3 text-left">
                        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", selected ? meta.bg : "bg-muted/20")}>
                          <Icon className={cn("w-5 h-5", meta.color)} />
                        </div>
                        <span className="font-mono text-sm font-bold flex-1">{meta.label}</span>
                        {selected && <Check className={cn("w-4 h-4", meta.color)} />}
                      </button>
                      {selected && (
                        <div className="px-3 pb-3 grid grid-cols-2 gap-2">
                          <Input placeholder="Min followers/age #" value={platformFilters[id]?.minMetric ?? ""} onChange={e => setFilter(id, "minMetric", e.target.value)} className="font-mono text-xs h-8" />
                          <Input placeholder="Min account age" value={platformFilters[id]?.minAge ?? ""} onChange={e => setFilter(id, "minAge", e.target.value)} className="font-mono text-xs h-8" />
                        </div>
                      )}
                    </div>
                  );
                })}
                <div className={cn("rounded-xl border transition-all", platformSel["other"] ? "bg-purple-400/10 border-purple-400/30" : "border-border/30")}>
                  <button onClick={() => togglePlatform("other")} className="w-full flex items-center gap-3 p-3 text-left">
                    <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", platformSel["other"] ? "bg-purple-400/10" : "bg-muted/20")}>
                      <Database className="w-5 h-5 text-purple-400" />
                    </div>
                    <span className="font-mono text-sm font-bold flex-1">Other Platform</span>
                    {platformSel["other"] && <Check className="w-4 h-4 text-purple-400" />}
                  </button>
                  {platformSel["other"] && (
                    <div className="px-3 pb-3">
                      <Input placeholder="e.g. GitHub, LinkedIn, Reddit..." value={otherPlatformName} onChange={e => setOtherPlatformName(e.target.value)} className="font-mono text-xs h-8" />
                    </div>
                  )}
                </div>
              </div>
              <Button onClick={() => setStep("price")} disabled={selectedPlatformIds.length === 0} className="w-full font-mono text-xs">
                Next: Price Range <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </>
          )}

          {/* Step 1: Category (local accounts only) */}
          {!isEntity && step === "category" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">Select the account type you want to buy:</p>
              <div className="space-y-2">
                {LOCAL_ACCOUNT_MARKET_CATEGORIES.map(cat => {
                  const Icon = cat.icon;
                  return (
                    <button key={cat.id} onClick={() => setCategory(cat.id)}
                      className={cn("w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                        category === cat.id ? `${cat.bg} ${cat.border} ${cat.color}` : "border-border/30 hover:border-primary/20")}>
                      <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", category === cat.id ? cat.bg : "bg-muted/20")}>
                        <Icon className={cn("w-5 h-5", cat.color)} />
                      </div>
                      <span className="font-mono text-sm font-bold">{cat.label}</span>
                      {category === cat.id && <Check className="w-4 h-4 ml-auto" />}
                    </button>
                  );
                })}
              </div>
              <Button onClick={() => setStep("details")} disabled={!category} className="w-full font-mono text-xs">
                Next: Account Requirements <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </>
          )}

          {/* Step 2: Details (local accounts only) */}
          {!isEntity && step === "details" && catDef && (
            <>
              <div className="flex items-center gap-2 bg-muted/20 rounded-lg px-3 py-2">
                <catDef.icon className={cn("w-4 h-4", catDef.color)} />
                <span className="font-mono text-sm font-bold">{catDef.label} Requirements</span>
              </div>
              <div className="space-y-3">
                {fields.map(field => (
                  <div key={field.key}>
                    <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">{field.label}</label>
                    {field.type === "toggle" ? (
                      <div className="flex gap-2">
                        {["Yes", "No"].map(v => (
                          <button key={v} onClick={() => setDetails(d => ({ ...d, [field.key]: v === "Yes" }))}
                            className={cn("flex-1 py-2 rounded-lg border font-mono text-xs transition-all",
                              details[field.key] === (v === "Yes") ? "bg-primary/10 border-primary/40 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                            {v}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Input
                        type={field.type === "number" ? "number" : "text"}
                        value={details[field.key] ?? ""}
                        onChange={e => setDetails(d => ({ ...d, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className="font-mono text-sm"
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("category")} className="flex-1 font-mono text-xs">Back</Button>
                <Button onClick={() => setStep("price")} className="flex-1 font-mono text-xs">
                  Next: Price Range <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </>
          )}

          {/* Final step: Price */}
          {step === "price" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">Set your price range (in AZN):</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Min Price (AZN)</label>
                  <Input type="number" value={priceMin} onChange={e => setPriceMin(e.target.value)} placeholder="e.g. 500" className="font-mono text-sm" />
                </div>
                <div>
                  <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Max Price (AZN)</label>
                  <Input type="number" value={priceMax} onChange={e => setPriceMax(e.target.value)} placeholder="e.g. 2000" className="font-mono text-sm" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(isEntity ? "platforms" : "details")} className="flex-1 font-mono text-xs">Back</Button>
                <Button onClick={handleCreate} disabled={creating} className="flex-1 font-mono text-xs bg-amber-600 hover:bg-amber-700 text-white border-0">
                  {creating ? "Creating..." : "Create Buy Order"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Create Sell Order Modal ───────────────────────────────────────────────────
function SellOrderModal({ vaultType, onClose, onSuccess }: { vaultType: "entity" | "local" | "kyc" | "game"; onClose: () => void; onSuccess: () => void }) {
  const { toast } = useToast();
  const isEntity = vaultType === "entity";
  const [step, setStep] = useState<"category" | "vault" | "platforms" | "details" | "price">(isEntity ? "vault" : "category");
  const [category, setCategory] = useState("");
  const [vaultEntries, setVaultEntries] = useState<any[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<any>(null);
  const [details, setDetails] = useState<Record<string, any>>({});
  const [price, setPrice] = useState("");
  const [creating, setCreating] = useState(false);

  // Entity flow: per-platform price selection (an entity can carry Twitter + Discord + Telegram + others at once).
  const [platformPrices, setPlatformPrices] = useState<Record<string, string>>({});
  const [platformSel, setPlatformSel] = useState<Record<string, boolean>>({});

  const catDef = LOCAL_ACCOUNT_MARKET_CATEGORIES.find(c => c.id === category);
  const fields = LOCAL_ACCOUNT_BUY_FIELDS[category] ?? [];
  const entityPlatforms = getEntityPlatforms(selectedEntry);
  const selectedEntityPlatforms = entityPlatforms.filter(p => platformSel[p.id] !== false); // default-selected
  const totalPrice = selectedEntityPlatforms.reduce((s, p) => s + (parseFloat(platformPrices[p.id]) || 0), 0);

  useEffect(() => {
    if (step === "vault" && vaultType === "entity") {
      api("/vault").then(r => r.json()).then(d => setVaultEntries(Array.isArray(d) ? d : []));
    } else if (step === "vault" && vaultType === "local") {
      api("/local-accounts").then(r => r.json()).then(d => setVaultEntries(Array.isArray(d) ? d : []));
    } else if (step === "vault" && vaultType === "kyc") {
      api("/kyc-entries").then(r => r.json()).then(d => setVaultEntries(Array.isArray(d) ? d : []));
    } else if (step === "vault" && vaultType === "game") {
      api("/game-entries").then(r => r.json()).then(d => setVaultEntries(Array.isArray(d) ? d : []));
    }
  }, [step, vaultType]);

  useEffect(() => {
    if (!selectedEntry) return;
    if (isEntity) {
      // Prefill each platform's price from its recorded worth, and default every platform to selected.
      const rows = getEntityPlatforms(selectedEntry);
      const prices: Record<string, string> = {};
      const sel: Record<string, boolean> = {};
      rows.forEach(r => { prices[r.id] = r.worth || ""; sel[r.id] = true; });
      setPlatformPrices(prices);
      setPlatformSel(sel);
    } else {
      const autoFilled: Record<string, any> = {};
      if (selectedEntry.account_create_date) autoFilled.account_create_date = selectedEntry.account_create_date;
      if (selectedEntry.followers) autoFilled.followers = selectedEntry.followers;
      if (selectedEntry.twofa) autoFilled.has_2fa = true;
      setDetails(autoFilled);
    }
  }, [selectedEntry, isEntity]);

  const handleCreate = async () => {
    if (isEntity) {
      if (selectedEntityPlatforms.length === 0) { toast({ title: "Select at least one platform" }); return; }
      if (selectedEntityPlatforms.some(p => !platformPrices[p.id])) { toast({ title: "Set a price for each selected platform" }); return; }
      setCreating(true);
      try {
        const payload = {
          order_type: "sell",
          vault_type: "entity",
          vault_entry_id: selectedEntry.id,
          account_type: "entity",
          category: "Entity",
          title: `${selectedEntry.projectName ?? "Entity"} — ${selectedEntityPlatforms.map(p => p.label).join(" + ")}`,
          account_details: {
            platforms: selectedEntityPlatforms.map(p => ({
              platform: p.id, label: p.label, price: Number(platformPrices[p.id]) || 0,
              metricLabel: p.metricLabel, metricValue: p.metricValue, age: p.age,
            })),
          },
          price: totalPrice,
        };
        const r = await api("/marketplace/vault/listings", { method: "POST", body: JSON.stringify(payload) });
        const d = await r.json();
        if (r.ok) { toast({ title: "Sell listing created!" }); onSuccess(); onClose(); }
        else toast({ variant: "destructive", title: d.error });
      } catch { toast({ variant: "destructive", title: "Network error" }); }
      setCreating(false);
      return;
    }
    if (!price) { toast({ title: "Price required" }); return; }
    setCreating(true);
    try {
      const payload: any = {
        order_type: "sell",
        vault_type: vaultType,
        account_type: category,
        account_details: details,
        price: Number(price),
        title: `${catDef?.label ?? category} Account`,
        category,
      };
      if (selectedEntry) {
        if (vaultType === "kyc") payload.kyc_entry_id = selectedEntry.id;
        else if (vaultType === "game") payload.game_entry_id = selectedEntry.id;
        else payload.local_account_id = selectedEntry.id;
      }
      const r = await api("/marketplace/vault/listings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (r.ok) { toast({ title: "Sell listing created!" }); onSuccess(); onClose(); }
      else toast({ variant: "destructive", title: d.error });
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-card border border-amber-500/20 rounded-xl w-full max-w-md mx-4 shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/40 sticky top-0 bg-card">
          <div>
            <span className="font-mono font-bold text-sm">Create Sell Order</span>
            <div className="text-[10px] font-mono text-muted-foreground capitalize">{vaultType} account · {step}</div>
          </div>
          <button onClick={onClose}><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Category (local accounts only — an entity's "category" is its own set of platforms) */}
          {!isEntity && step === "category" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">Select the account category you are selling:</p>
              <div className="space-y-2">
                {LOCAL_ACCOUNT_MARKET_CATEGORIES.map(cat => {
                  const Icon = cat.icon;
                  return (
                    <button key={cat.id} onClick={() => setCategory(cat.id)}
                      className={cn("w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                        category === cat.id ? `${cat.bg} ${cat.border} ${cat.color}` : "border-border/30 hover:border-primary/20")}>
                      <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", category === cat.id ? cat.bg : "bg-muted/20")}>
                        <Icon className={cn("w-5 h-5", cat.color)} />
                      </div>
                      <span className="font-mono text-sm font-bold">{cat.label}</span>
                      {category === cat.id && <Check className="w-4 h-4 ml-auto" />}
                    </button>
                  );
                })}
              </div>
              <Button onClick={() => setStep("vault")} disabled={!category} className="w-full font-mono text-xs">
                Next: Select from Vault <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </>
          )}

          {/* Vault Entry Selection */}
          {step === "vault" && (
            <>
              <p className="text-[11px] font-mono text-muted-foreground">
                {isEntity ? "Select the entity from your vault to sell:" : `Select the ${vaultType} account from your vault (optional — skip to enter manually):`}
              </p>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {vaultEntries.length === 0 ? (
                  <p className="text-center py-4 font-mono text-sm text-muted-foreground/50">No {vaultType} accounts in vault</p>
                ) : (
                  vaultEntries.map(entry => (
                    <button key={entry.id} onClick={() => setSelectedEntry(entry)}
                      className={cn("w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left",
                        selectedEntry?.id === entry.id ? "border-primary/40 bg-primary/5" : "border-border/30 hover:border-primary/20")}>
                      <div className="w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center flex-shrink-0">
                        {vaultType === "entity" ? <Database className="w-4 h-4 text-muted-foreground" /> : vaultType === "kyc" ? <ShieldCheck className="w-4 h-4 text-muted-foreground" /> : vaultType === "game" ? <Gamepad2 className="w-4 h-4 text-muted-foreground" /> : <Smartphone className="w-4 h-4 text-muted-foreground" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs font-bold truncate">
                          {vaultType === "entity" ? (entry.projectName ?? entry.project_name ?? `Entity #${entry.id}`)
                            : vaultType === "kyc" ? (entry.name ?? entry.username ?? entry.platform ?? `KYC #${entry.id}`)
                            : vaultType === "game" ? (entry.name ?? entry.username ?? entry.platform ?? `Game #${entry.id}`)
                            : (entry.label ?? entry.category ?? `Account #${entry.id}`)}
                        </div>
                        <div className="font-mono text-[9px] text-muted-foreground">
                          {isEntity ? getEntityPlatforms(entry).map(p => p.label).join(" · ") || "No platforms filled in yet"
                            : vaultType === "kyc" ? (entry.platform ?? entry.category ?? "—")
                            : vaultType === "game" ? (entry.platform ?? entry.category ?? "—")
                            : (entry.category ?? "—")}
                        </div>
                      </div>
                      {selectedEntry?.id === entry.id && <Check className="w-4 h-4 text-primary flex-shrink-0" />}
                    </button>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                {!isEntity && <Button variant="outline" onClick={() => setStep("category")} className="flex-1 font-mono text-xs">Back</Button>}
                <Button onClick={() => setStep(isEntity ? "platforms" : "details")} disabled={isEntity && !selectedEntry} className="flex-1 font-mono text-xs">
                  {isEntity ? "Next: Choose Platforms" : (selectedEntry ? "Next: Review Details" : "Skip: Enter Manually")} <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </>
          )}

          {/* Entity: per-platform price selection */}
          {isEntity && step === "platforms" && (
            <>
              {entityPlatforms.length === 0 ? (
                <div className="text-center py-6">
                  <p className="font-mono text-sm text-muted-foreground/60 mb-1">This entity has no platform data yet.</p>
                  <p className="font-mono text-[10px] text-muted-foreground/40">Add Twitter, Discord, Telegram or Other account details in the Vault first.</p>
                </div>
              ) : (
                <>
                  <p className="text-[11px] font-mono text-muted-foreground">Choose which platforms to include and set a price for each:</p>
                  <div className="space-y-2">
                    {entityPlatforms.map(p => {
                      const Icon = p.icon;
                      const selected = platformSel[p.id] !== false;
                      return (
                        <div key={p.id} className={cn("rounded-xl border transition-all", selected ? `${p.bg} ${p.border}` : "border-border/30 opacity-60")}>
                          <button onClick={() => setPlatformSel(s => ({ ...s, [p.id]: !selected }))} className="w-full flex items-center gap-3 p-3 text-left">
                            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0", selected ? p.bg : "bg-muted/20")}>
                              <Icon className={cn("w-5 h-5", p.color)} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="font-mono text-sm font-bold">{p.label}</div>
                              {(p.metricValue || p.age) && (
                                <div className="font-mono text-[9px] text-muted-foreground">
                                  {p.metricValue && `${p.metricLabel}: ${p.metricValue}`}{p.metricValue && p.age && " · "}{p.age && `Age: ${p.age}`}
                                </div>
                              )}
                            </div>
                            {selected && <Check className={cn("w-4 h-4", p.color)} />}
                          </button>
                          {selected && (
                            <div className="px-3 pb-3">
                              <Input type="number" placeholder="Price (AZN)" value={platformPrices[p.id] ?? ""}
                                onChange={e => setPlatformPrices(pp => ({ ...pp, [p.id]: e.target.value }))}
                                className="font-mono text-sm h-8" />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center justify-between bg-muted/20 rounded-lg px-3 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Total Price</span>
                    <span className="font-mono font-bold text-sm text-amber-400">{totalPrice.toFixed(0)} AZN</span>
                  </div>
                </>
              )}
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("vault")} className="flex-1 font-mono text-xs">Back</Button>
                <Button onClick={handleCreate} disabled={creating || entityPlatforms.length === 0} className="flex-1 font-mono text-xs bg-amber-600 hover:bg-amber-700 text-white border-0">
                  {creating ? "Creating..." : "List for Sale"}
                </Button>
              </div>
            </>
          )}

          {/* Account Details (local accounts only) */}
          {!isEntity && step === "details" && catDef && (
            <>
              <div className="flex items-center gap-2 bg-muted/20 rounded-lg px-3 py-2">
                <catDef.icon className={cn("w-4 h-4", catDef.color)} />
                <span className="font-mono text-sm font-bold">{catDef.label} Account Details</span>
              </div>
              {selectedEntry && (
                <div className="bg-emerald-400/5 border border-emerald-400/20 rounded-lg px-3 py-2 text-[10px] font-mono text-emerald-400/80 flex items-center gap-2">
                  <Check className="w-3 h-3" /> Some fields auto-filled from vault
                </div>
              )}
              <div className="space-y-3">
                {fields.map(field => (
                  <div key={field.key}>
                    <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">{field.label}</label>
                    {field.type === "toggle" ? (
                      <div className="flex gap-2">
                        {["Yes", "No"].map(v => (
                          <button key={v} onClick={() => setDetails(d => ({ ...d, [field.key]: v === "Yes" }))}
                            className={cn("flex-1 py-2 rounded-lg border font-mono text-xs transition-all",
                              details[field.key] === (v === "Yes") ? "bg-primary/10 border-primary/40 text-primary" : "border-border/40 text-muted-foreground hover:border-border")}>
                            {v}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <Input
                        type={field.type === "number" ? "number" : "text"}
                        value={details[field.key] ?? ""}
                        onChange={e => setDetails(d => ({ ...d, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className={cn("font-mono text-sm", details[field.key] ? "border-emerald-400/30" : "")}
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("vault")} className="flex-1 font-mono text-xs">Back</Button>
                <Button onClick={() => setStep("price")} className="flex-1 font-mono text-xs">
                  Next: Set Price <ChevronRight className="w-3.5 h-3.5 ml-1" />
                </Button>
              </div>
            </>
          )}

          {/* Price (local accounts only — entity price is the sum of per-platform prices) */}
          {!isEntity && step === "price" && (
            <>
              <div>
                <label className="block text-[10px] font-mono text-muted-foreground/60 mb-1 uppercase tracking-wider">Price (AZN) *</label>
                <Input type="number" value={price} onChange={e => setPrice(e.target.value)} placeholder="e.g. 1500" className="font-mono text-sm" />
                {price && <p className="text-[10px] font-mono text-muted-foreground/50 mt-1">Platform fee: 5% · You receive: {(Number(price) * 0.95).toFixed(0)} AZN</p>}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep("details")} className="flex-1 font-mono text-xs">Back</Button>
                <Button onClick={handleCreate} disabled={creating} className="flex-1 font-mono text-xs bg-amber-600 hover:bg-amber-700 text-white border-0">
                  {creating ? "Creating..." : "List for Sale"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
type VaultTab = "entity" | "local" | "kyc" | "game";
type ViewMode = "sell" | "buy";

// Reads the initial tab from ?type= so sidebar links like
// /marketplace/vault?type=kyc land directly on the right tab.
function initialVaultTab(): VaultTab {
  if (typeof window === "undefined") return "entity";
  const t = new URLSearchParams(window.location.search).get("type");
  return t === "local" || t === "kyc" || t === "game" ? t : "entity";
}

export default function MarketplaceVault() {
  const { toast } = useToast();
  const { user } = useAuth();
  const search = useSearch();
  const [vaultTab, setVaultTab] = useState<VaultTab>(initialVaultTab);

  // Keep the tab in sync if the sidebar's ?type= changes while this page is
  // already mounted (e.g. Entity → KYC via the Vault Market sub-sidebar).
  useEffect(() => {
    const t = new URLSearchParams(search).get("type");
    if (t === "entity" || t === "local" || t === "kyc" || t === "game") setVaultTab(t);
  }, [search]);

  const [viewMode, setViewMode] = useState<ViewMode>("sell");
  const [listings, setListings] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [wallet, setWallet] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [catFilter, setCatFilter] = useState("all");
  const [buying, setBuying] = useState<number | null>(null);
  const [showBuyOrder, setShowBuyOrder] = useState(false);
  const [showSellOrder, setShowSellOrder] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        vault_type: vaultTab,
        order_type: viewMode,
        limit: "50",
      });
      if (catFilter !== "all") params.set("account_type", catFilter);
      const [l, s, w] = await Promise.all([
        api(`/marketplace/vault/listings?${params}`).then(r => r.json()),
        api("/marketplace/vault/stats").then(r => r.json()),
        api("/marketplace/wallet").then(r => r.json()),
      ]);
      setListings(l.listings ?? []);
      setStats(s);
      setWallet(w?.vault ?? null);
    } catch {}
    setLoading(false);
  }, [vaultTab, viewMode, catFilter]);

  useEffect(() => { load(); }, [load]);

  const handleBuy = async (id: number) => {
    setBuying(id);
    try {
      const r = await api("/marketplace/vault/buy", { method: "POST", body: JSON.stringify({ listing_id: id }) });
      const d = await r.json();
      if (!r.ok) toast({ variant: "destructive", title: d.error });
      else { toast({ title: `Purchased!`, description: `Cost: ${d.price} AZN` }); load(); }
    } catch { toast({ variant: "destructive", title: "Network error" }); }
    setBuying(null);
  };

  const handleCancel = async (id: number) => {
    await api(`/marketplace/vault/listings/${id}`, { method: "DELETE" });
    toast({ title: "Listing removed" }); load();
  };

  return (
    <div className="space-y-5 page-enter">
      {showBuyOrder && <BuyOrderModal vaultType={vaultTab} onClose={() => setShowBuyOrder(false)} onSuccess={load} />}
      {showSellOrder && <SellOrderModal vaultType={vaultTab} onClose={() => setShowSellOrder(false)} onSuccess={load} />}

      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-amber-500/15 border border-amber-500/30 flex items-center justify-center">
              <Vault className="w-4 h-4 text-amber-400" />
            </div>
            <h1 className="text-2xl font-bold font-mono tracking-tighter uppercase">Vault Market</h1>
            <Badge variant="outline" className="font-mono text-[10px] border-amber-400/30 text-amber-400 bg-amber-400/5">SECURE</Badge>
          </div>
          <p className="text-muted-foreground font-mono text-sm">Buy & sell crypto accounts · Escrow protected</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} className="font-mono text-xs h-8">
            <RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowBuyOrder(true)} className="font-mono text-xs h-8 gap-1.5 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10">
            <Plus className="w-3.5 h-3.5" /> Buy Order
          </Button>
          <Button size="sm" onClick={() => setShowSellOrder(true)} className="font-mono text-xs h-8 gap-1.5 bg-amber-600 hover:bg-amber-700 text-white border-0">
            <Plus className="w-3.5 h-3.5" /> Sell Order
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "For Sale",      value: stats?.active_listings ?? "—",    icon: Vault,     color: "text-amber-400" },
          { label: "Buy Orders",    value: stats?.active_buy_orders ?? "—",  icon: ShoppingCart, color: "text-emerald-400" },
          { label: "Floor Price",   value: `${stats?.floor_price?.toFixed(0) ?? "—"} AZN`, icon: Tag, color: "text-primary" },
          { label: "Vault Wallet",  value: `${wallet?.balance?.toFixed(0) ?? "0"} AZN`, icon: Star, color: "text-violet-400" },
        ].map(s => (
          <div key={s.label} className="bg-card border border-card-border rounded-xl p-3 flex items-center gap-3">
            <div className={cn("w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center flex-shrink-0", s.color)}>
              <s.icon className="w-4 h-4" />
            </div>
            <div>
              <div className={cn("font-mono font-bold text-base", s.color)}>{loading ? <Skeleton className="h-5 w-12" /> : s.value}</div>
              <div className="font-mono text-[9px] text-muted-foreground">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Category is now selected from the main sidebar's Vault Market ▸
          Entity/Local/KYC/Game — this page just renders whichever ?type=
          is active (see vaultTab sync effect above), no in-page nav needed. */}
      <div className="space-y-4">
        {/* View Mode: Sell listings vs Buy orders */}
        <div className="flex gap-1.5">
          {([
              { id: "sell" as ViewMode, label: "For Sale" },
              { id: "buy"  as ViewMode, label: "Buy Requests" },
            ] as const).map(m => (
              <button key={m.id} onClick={() => setViewMode(m.id)}
                className={cn("px-3 py-1.5 text-[10px] font-mono rounded-full border transition-all",
                  viewMode === m.id ? "bg-amber-500/15 text-amber-400 border-amber-400/30" : "border-border/40 text-muted-foreground hover:border-border")}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Category Filters — local accounts only; an entity's "category" is its own set of platforms */}
          {vaultTab === "local" && (
            <div className="flex gap-1.5 flex-wrap">
              <button onClick={() => setCatFilter("all")}
                className={cn("px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-all",
                  catFilter === "all" ? "bg-amber-500/15 text-amber-400 border-amber-400/30" : "text-muted-foreground border-border/30 hover:border-border")}>
                All
              </button>
              {LOCAL_ACCOUNT_MARKET_CATEGORIES.map(cat => {
                const Icon = cat.icon;
                return (
                  <button key={cat.id} onClick={() => setCatFilter(cat.id)}
                    className={cn("flex items-center gap-1 px-2.5 py-1 rounded text-[10px] font-mono uppercase tracking-wider border transition-all",
                      catFilter === cat.id ? `${cat.bg} ${cat.border} ${cat.color}` : "text-muted-foreground border-border/30 hover:border-border")}>
                    <Icon className="w-3 h-3" /> {cat.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Listings */}
          {loading ? (
            <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-xl" />)}</div>
          ) : listings.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground/40 font-mono text-sm bg-card border border-border/30 rounded-xl">
              <Vault className="w-10 h-10 mx-auto mb-3 opacity-20" />
              <p>No {viewMode === "sell" ? "listings" : "buy requests"} found</p>
              <Button size="sm" className="mt-4 font-mono text-xs gap-1.5 bg-amber-600 hover:bg-amber-700 text-white border-0"
                onClick={() => viewMode === "sell" ? setShowSellOrder(true) : setShowBuyOrder(true)}>
                <Plus className="w-3.5 h-3.5" /> Create {viewMode === "sell" ? "Sell" : "Buy"} Order
              </Button>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {listings.map(l => {
                const isEntityListing = l.vault_type === "entity" || l.account_type === "entity";
                const catDef = LOCAL_ACCOUNT_MARKET_CATEGORIES.find(c => c.id === l.account_type);
                const CatIcon = isEntityListing ? Database : (catDef?.icon ?? Shield);
                const isMine = l.seller_id === user?.id;
                const isBuyOrder = l.order_type === "buy";
                const details: Record<string, any> = l.account_details ?? {};
                const entityPlatformRows: any[] = isEntityListing && Array.isArray(details.platforms) ? details.platforms : [];
                return (
                  <div key={l.id} className={cn(
                    "bg-card border rounded-xl overflow-hidden transition-all",
                    isMine ? "border-amber-400/20" : "border-card-border hover:border-amber-400/30"
                  )}>
                    <div className="bg-gradient-to-r from-amber-500/5 to-transparent border-b border-border/30 px-4 py-2.5 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <CatIcon className={cn("w-3.5 h-3.5", isEntityListing ? "text-amber-400" : (catDef?.color ?? "text-muted-foreground"))} />
                        <span className="font-mono text-xs text-muted-foreground/70">#{l.id}</span>
                        {isEntityListing
                          ? <Badge variant="outline" className="font-mono text-[8px] uppercase text-amber-400 border-amber-400/30">Entity</Badge>
                          : (catDef && <Badge variant="outline" className={cn("font-mono text-[8px] uppercase", catDef.color, catDef.border)}>{catDef.label}</Badge>)}
                        {isBuyOrder && <Badge variant="outline" className="font-mono text-[8px] border-emerald-400/30 text-emerald-400">BUY REQUEST</Badge>}
                        {isMine && <Badge variant="outline" className="font-mono text-[8px] border-amber-400/30 text-amber-400">MINE</Badge>}
                      </div>
                      <div className="font-mono font-bold text-sm text-primary">
                        {isBuyOrder && l.price_min && l.price_max
                          ? `${l.price_min}–${l.price_max} AZN`
                          : `${Number(l.price).toLocaleString()} AZN`}
                      </div>
                    </div>
                    <div className="p-4 space-y-2">
                      <h3 className="font-mono font-bold text-sm">{l.title}</h3>
                      {/* Entity listings: per-platform breakdown */}
                      {isEntityListing && entityPlatformRows.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {entityPlatformRows.map((p: any, i: number) => {
                            const meta = ENTITY_PLATFORM_META[p.platform];
                            const Icon = meta?.icon ?? Database;
                            return (
                              <div key={i} className={cn("flex items-center gap-1.5 rounded-lg px-2 py-1 font-mono text-[9px] border",
                                meta ? `${meta.bg} ${meta.border} ${meta.color}` : "bg-purple-400/10 border-purple-400/30 text-purple-400")}>
                                <Icon className="w-3 h-3" />
                                <span className="font-bold">{p.label ?? p.platform}</span>
                                {p.price != null && <span className="opacity-80">· {p.price} AZN</span>}
                                {p.minMetric && <span className="opacity-80">· min {p.minMetric}</span>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Local account details */}
                      {!isEntityListing && Object.keys(details).length > 0 && (
                        <div className="grid grid-cols-2 gap-1.5">
                          {Object.entries(details).map(([k, v]) => (
                            <div key={k} className="bg-muted/20 rounded px-2 py-1 font-mono text-[9px]">
                              <div className="text-muted-foreground/60 uppercase tracking-wider mb-0.5">{k.replace(/_/g, " ")}</div>
                              <div className="text-foreground font-bold">{String(v)}</div>
                            </div>
                          ))}
                        </div>
                      )}
                      {l.description && <p className="font-mono text-[11px] text-muted-foreground/60 line-clamp-2">{l.description}</p>}
                      <div className="flex items-center justify-between pt-1">
                        <div className="text-[9px] font-mono text-muted-foreground/40">
                          {isBuyOrder ? "Requested" : "Listed"} by {l.seller_username} · {new Date(l.created_at).toLocaleDateString()}
                        </div>
                        {isMine ? (
                          <Button size="sm" variant="outline" onClick={() => handleCancel(l.id)}
                            className="font-mono text-[9px] h-6 border-red-500/20 text-red-400 hover:bg-red-500/10">
                            <X className="w-2.5 h-2.5 mr-1" /> Remove
                          </Button>
                        ) : isBuyOrder ? (
                          <Button size="sm" className="font-mono text-[9px] h-7 bg-emerald-600 hover:bg-emerald-700 text-white border-0 gap-1">
                            <Lock className="w-3 h-3" /> Fulfill Request
                          </Button>
                        ) : (
                          <Button size="sm" onClick={() => handleBuy(l.id)} disabled={buying === l.id}
                            className="font-mono text-[9px] h-7 bg-amber-600 hover:bg-amber-700 text-white border-0 gap-1">
                            <ShoppingCart className="w-3 h-3" />
                            {buying === l.id ? "Buying..." : "Buy Securely"}
                          </Button>
                        )}
                      </div>
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
