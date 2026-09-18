// Vault entity rank/badge system.
//
// Every vault entity — both "entity" vault entries (vault_entries table) and
// "local" vault accounts (local_accounts table) — carries a 0-10 `score`.
// That score maps to one of 5 MOBA-style ranks (Warrior → Mythic, the same
// progression shape as Mobile Legends' rank ladder), each with its own
// badge icon. Icons here are original artwork drawn in that rank-badge
// visual language (faceted gem in a shield, tier color + star count) —
// not traced from any game's actual assets.
//
// Add the score to any entity list/detail page with:
//   const rank = getEntityRank(entity.score);
//   <RankBadge score={entity.score} />

export interface EntityRank {
  key: string;
  label: string;
  /** Inclusive score range this rank covers, on the 0-10 scale. */
  min: number;
  max: number;
  /** Star/facet count shown inside the badge — rises with tier. */
  stars: number;
  colorFrom: string;
  colorTo: string;
  textColor: string;
  ringColor: string;
}

export const ENTITY_RANKS: EntityRank[] = [
  { key: "warrior",     label: "Warrior",     min: 0,  max: 1,  stars: 1, colorFrom: "#8a8f98", colorTo: "#565c66", textColor: "text-slate-300",   ringColor: "border-slate-400/30" },
  { key: "elite",       label: "Elite",       min: 2,  max: 3,  stars: 2, colorFrom: "#4ade80", colorTo: "#15803d", textColor: "text-emerald-400", ringColor: "border-emerald-400/30" },
  { key: "master",      label: "Master",      min: 4,  max: 5,  stars: 3, colorFrom: "#38bdf8", colorTo: "#1d4ed8", textColor: "text-blue-400",    ringColor: "border-blue-400/30" },
  { key: "grandmaster", label: "Grandmaster", min: 6,  max: 7,  stars: 4, colorFrom: "#c084fc", colorTo: "#7e22ce", textColor: "text-purple-400",  ringColor: "border-purple-400/30" },
  { key: "mythic",      label: "Mythic",      min: 8,  max: 10, stars: 5, colorFrom: "#fb7185", colorTo: "#facc15", textColor: "text-amber-300",   ringColor: "border-amber-400/40" },
];

export function getEntityRank(score: number | null | undefined): EntityRank {
  const s = Math.max(0, Math.min(10, Number(score ?? 5)));
  return ENTITY_RANKS.find(r => s >= r.min && s <= r.max) ?? ENTITY_RANKS[2];
}

/** The faceted-gem-in-a-shield badge icon, colored per rank, with the
 *  rank's star count as small facets along the bottom edge. */
export function RankBadgeIcon({ rank, size = 28 }: { rank: EntityRank; size?: number }) {
  const gid = `rank-grad-${rank.key}`;
  return (
    <svg width={size} height={size} viewBox="0 0 40 44" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={rank.colorFrom} />
          <stop offset="100%" stopColor={rank.colorTo} />
        </linearGradient>
      </defs>
      {/* Shield outline */}
      <path
        d="M20 1 L37 7 V20 C37 30 30 39 20 43 C10 39 3 30 3 20 V7 Z"
        fill={`url(#${gid})`}
        stroke="rgba(255,255,255,0.35)"
        strokeWidth="1"
      />
      {/* Inner facet — diamond */}
      <path d="M20 10 L28 18 L20 34 L12 18 Z" fill="rgba(255,255,255,0.85)" opacity="0.9" />
      <path d="M20 10 L28 18 L20 22 L12 18 Z" fill="rgba(255,255,255,0.55)" />
      {/* Tier stars along the base */}
      {Array.from({ length: rank.stars }).map((_, i) => {
        const total = rank.stars;
        const spacing = 26 / Math.max(total, 1);
        const x = 20 - (total - 1) * spacing / 2 + i * spacing;
        return <circle key={i} cx={x} cy={39.5} r="1.4" fill="rgba(255,255,255,0.9)" />;
      })}
    </svg>
  );
}

/** Compact "icon + label" chip for cards; pass just the raw score. */
export function RankBadge({ score, showLabel = true, size = 18 }: { score: number | null | undefined; showLabel?: boolean; size?: number }) {
  const rank = getEntityRank(score);
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border bg-black/20 ${rank.ringColor}`}
      title={`${rank.label} · ${Math.max(0, Math.min(10, Number(score ?? 5)))}/10`}
    >
      <RankBadgeIcon rank={rank} size={size} />
      {showLabel && (
        <span className={`font-mono text-[9px] uppercase tracking-wider font-bold ${rank.textColor}`}>
          {rank.label}
        </span>
      )}
    </span>
  );
}
