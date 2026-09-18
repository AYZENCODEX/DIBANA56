/**
 * components/receipt/fantastic-receipt-view.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared visual shell for the three public receipt pages (Local Entity,
 * Vault Entity, Project P&L) — pages/receipt/local.tsx, entity.tsx,
 * project.tsx. Deliberately more "fantastic"/showy than the plain Finance
 * ledger receipt (pages/finance/receipt.tsx): dark gradient backdrop with
 * glow blobs, a glass hero card with a large colored P&L number, and a
 * frosted stat grid. Kept as one component so all three receipt types stay
 * visually consistent.
 */
import { Download, ShieldCheck, Sparkles, TrendingUp, TrendingDown } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export interface FantasticStat {
  label: string;
  value: string;
  color?: string;
}

export function FantasticReceiptView({
  kicker, title, subtitle, avatarLetter,
  heroLabel, heroValue, heroPositive,
  stats, notes, receiptId, issuedBy, generatedAt, pdfUrl,
}: {
  kicker: string;
  title: string;
  subtitle?: string | null;
  avatarLetter: string;
  heroLabel: string;
  heroValue: string;
  heroPositive?: boolean | null;
  stats: FantasticStat[];
  notes?: string | null;
  receiptId: number | string;
  issuedBy?: string | null;
  generatedAt: string;
  pdfUrl: string;
}) {
  const heroColor = heroPositive === true ? "text-emerald-400" : heroPositive === false ? "text-red-400" : "text-foreground";
  const heroGlow = heroPositive === true ? "shadow-[0_0_60px_-10px_rgba(52,211,153,0.45)]" : heroPositive === false ? "shadow-[0_0_60px_-10px_rgba(248,113,113,0.4)]" : "";

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-[#07090c] p-4 md:p-8">
      {/* Decorative glow blobs */}
      <motion.div
        className="pointer-events-none absolute -top-32 -left-24 w-[420px] h-[420px] rounded-full bg-primary/25 blur-[120px]"
        initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease: "easeOut" }}
      />
      <motion.div
        className="pointer-events-none absolute -bottom-40 -right-24 w-[460px] h-[460px] rounded-full bg-fuchsia-500/15 blur-[130px]"
        initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease: "easeOut", delay: 0.1 }}
      />
      <motion.div
        className="pointer-events-none absolute top-1/3 right-1/4 w-[280px] h-[280px] rounded-full bg-cyan-400/10 blur-[100px]"
        initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 1.1, ease: "easeOut", delay: 0.2 }}
      />

      <div className="relative max-w-xl mx-auto space-y-5">
        {/* Brand row */}
        <motion.div
          className="flex items-center justify-between"
          initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary to-cyan-400 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-black" />
            </div>
            <span className="font-mono text-sm font-bold tracking-tight text-white">AYZEN</span>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">{kicker}</span>
        </motion.div>

        {/* Glass hero card */}
        <motion.div
          className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-6 md:p-8 space-y-6 shadow-2xl"
          initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
        >
          <motion.div
            className="flex items-center gap-4"
            initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.4, delay: 0.35 }}
          >
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/80 to-cyan-500/60 flex items-center justify-center flex-shrink-0 text-xl font-bold text-white font-mono shadow-lg shadow-primary/20">
              {avatarLetter.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <h1 className="text-xl md:text-2xl font-bold text-white tracking-tight truncate">{title}</h1>
              {subtitle && <p className="text-sm text-white/50 truncate">{subtitle}</p>}
            </div>
          </motion.div>

          {/* Hero PnL number */}
          <motion.div
            className={cn("rounded-2xl border border-white/10 bg-black/30 px-6 py-7 text-center", heroGlow)}
            initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.45 }}
          >
            <div className="flex items-center justify-center gap-1.5 mb-2">
              {heroPositive === true && <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />}
              {heroPositive === false && <TrendingDown className="w-3.5 h-3.5 text-red-400" />}
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">{heroLabel}</span>
            </div>
            <div className={cn("font-mono font-black text-4xl md:text-5xl tracking-tight", heroColor)}>{heroValue}</div>
          </motion.div>

          {/* Stat grid */}
          <div className="grid grid-cols-2 gap-3">
            {stats.map((s, i) => (
              <motion.div
                key={i}
                className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.55 + i * 0.05 }}
              >
                <div className="font-mono text-[9px] uppercase tracking-widest text-white/35">{s.label}</div>
                <div className={cn("font-mono font-bold text-sm mt-1 truncate", s.color ? "" : "text-white/90")} style={s.color ? { color: s.color } : undefined}>
                  {s.value}
                </div>
              </motion.div>
            ))}
          </div>

          {notes && (
            <motion.div
              className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.55 + stats.length * 0.05 + 0.1 }}
            >
              <div className="font-mono text-[9px] uppercase tracking-widest text-white/35 mb-1.5">Notes</div>
              <p className="text-sm text-white/70 leading-relaxed">{notes}</p>
            </motion.div>
          )}

          <motion.div
            className="flex items-center justify-between pt-1"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.55 + stats.length * 0.05 + 0.15 }}
          >
            <div className="font-mono text-[10px] text-white/30">
              Receipt #{receiptId}{issuedBy ? ` · Issued by ${issuedBy}` : ""}
            </div>
            <a
              href={pdfUrl}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-white/15 text-white/80 hover:bg-white/10 hover:text-white transition-colors"
            >
              <Download className="w-3.5 h-3.5" /> PDF
            </a>
          </motion.div>
        </motion.div>

        <motion.div
          className="flex items-start gap-2 px-1"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4, delay: 0.55 + stats.length * 0.05 + 0.2 }}
        >
          <ShieldCheck className="w-3.5 h-3.5 text-white/25 flex-shrink-0 mt-0.5" />
          <p className="font-mono text-[9px] text-white/25 leading-relaxed">
            System-generated, read-only receipt from AYZEN. Generated {new Date(generatedAt).toLocaleString()}.
            Anyone holding this link can view it — nothing else in the account is reachable from here.
          </p>
        </motion.div>
      </div>
    </div>
  );
}

export function FantasticReceiptLoading() {
  return (
    <div className="min-h-screen w-full bg-[#07090c] flex items-center justify-center p-4">
      <div className="text-center space-y-3">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="font-mono text-xs text-white/40 uppercase tracking-widest">Loading receipt...</p>
      </div>
    </div>
  );
}

export function FantasticReceiptError({ message }: { message: string }) {
  return (
    <div className="min-h-screen w-full bg-[#07090c] flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-5 text-center">
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center border border-red-500/20 bg-red-500/10">
            <ShieldCheck className="w-6 h-6 text-red-400" />
          </div>
        </div>
        <h1 className="text-lg font-mono font-bold tracking-tight text-white">Receipt Unavailable</h1>
        <div className="bg-white/5 border border-white/10 p-5 space-y-2 rounded-xl">
          <p className="font-mono text-xs text-red-400 font-bold">{message}</p>
        </div>
        <a href="/login" className="font-mono text-xs text-primary hover:underline">Go to AYZEN</a>
      </div>
    </div>
  );
}
