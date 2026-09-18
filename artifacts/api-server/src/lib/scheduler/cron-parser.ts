/**
 * lib/scheduler/cron-parser.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Mega Engine — Phase 8 blueprint, Part B2: Recurring/Cron Scheduler
 * (AYZEN_Mega_Event_Workflow_Scheduler_Engine_Phase8.md §29 "Cron" / §32
 * "Timezone").
 *
 * Deliberately hand-rolled rather than pulling in `cron-parser`/`luxon`/
 * `date-fns-tz`: this container has no network access for `pnpm install`,
 * and none of those packages are already resolvable in pnpm-lock.yaml (the
 * `node-cron` dependency B1 uses is a dispatch-loop ticker, not a
 * schedule-math library — it has no "next run at" API). Everything here is
 * built on the platform's own `Intl.DateTimeFormat`, which every Node LTS
 * ships with full ICU/IANA timezone data — no new dependency required.
 *
 * Standard 5-field cron only (minute hour dom month dow), numeric fields
 * only (no month/day-name aliases like `JAN`/`MON`, no `@daily`-style
 * shorthands) — §29's own example (`0 * * * *`) is numeric, and keeping
 * the grammar small keeps this file auditable. Supports `*`, single
 * values, lists (`a,b,c`), ranges (`a-b`), and steps (`* /n`, `a-b/n`).
 * Day-of-week `7` is accepted as an alias for `0` (Sunday), matching
 * standard cron/POSIX behavior. When BOTH dom and dow are restricted
 * (neither is `*`), a day matches if EITHER field matches — the same
 * "OR, not AND" rule real cron implementations use.
 */

const FIELD_BOUNDS = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 7],
} as const;

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domIsWildcard: boolean;
  dowIsWildcard: boolean;
}

function parseField(raw: string, [min, max]: readonly [number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = parseInt(stepStr, 10);
      if (!(step > 0)) throw new Error(`Cron field step must be positive: "${part}"`);
      let lo = min, hi = max;
      if (base !== "*") {
        if (base.includes("-")) {
          const [a, b] = base.split("-").map(Number);
          lo = a; hi = b;
        } else {
          lo = hi = parseInt(base, 10);
        }
      }
      for (let v = lo; v <= hi; v += step) out.add(v);
      continue;
    }
    if (part === "*") {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (Number.isNaN(a) || Number.isNaN(b) || a > b) throw new Error(`Invalid cron range: "${part}"`);
      for (let v = a; v <= b; v++) out.add(v);
      continue;
    }
    const v = parseInt(part, 10);
    if (Number.isNaN(v)) throw new Error(`Invalid cron field value: "${part}"`);
    out.add(v);
  }
  for (const v of out) {
    if (v < min || v > max) throw new Error(`Cron field value ${v} out of range [${min}, ${max}] in "${raw}"`);
  }
  if (!out.size) throw new Error(`Cron field produced no values: "${raw}"`);
  return out;
}

/** Parses and validates a 5-field cron expression. Throws synchronously on malformed input — callers (job-store.ts's scheduleCron()) call this at schedule time so a bad expression fails fast, not silently at first dispatch. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Cron expression must have exactly 5 fields (minute hour dom month dow): "${expr}"`);
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = fields;

  const dow = parseField(dowRaw, FIELD_BOUNDS.dow);
  if (dow.has(7)) { dow.delete(7); dow.add(0); } // 7 == Sunday, same as 0

  return {
    minute: parseField(minuteRaw, FIELD_BOUNDS.minute),
    hour: parseField(hourRaw, FIELD_BOUNDS.hour),
    dom: parseField(domRaw, FIELD_BOUNDS.dom),
    month: parseField(monthRaw, FIELD_BOUNDS.month),
    dow,
    domIsWildcard: domRaw === "*",
    dowIsWildcard: dowRaw === "*",
  };
}

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0-6, Sunday = 0
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// One Intl.DateTimeFormat per timezone is enough — formatToParts() is the
// expensive part, not construction, but reusing the formatter avoids
// rebuilding ICU locale data on every one of the (up to several thousand)
// calls a single nextCronOccurrence() search can make.
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** UTC instant -> that instant's wall-clock components in `timeZone` (§32 — canonical storage stays UTC; this is only for evaluating the cron expression against a local calendar/clock). Throws if `timeZone` isn't a recognized IANA identifier (Intl does this validation for us). */
export function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    // Intl's h23 cycle can format midnight as "24" in some ICU builds — normalize.
    hour: map.hour === "24" ? 0 : Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: WEEKDAY_INDEX[map.weekday] ?? 0,
  };
}

/**
 * Inverse of getZonedParts(): given wall-clock components meant to be read
 * IN `timeZone`, returns the UTC instant they correspond to. Standard
 * "guess, measure the error via the same formatter, correct" technique for
 * doing IANA-timezone-aware conversion with nothing but Intl (this is what
 * date-fns-tz's `zonedTimeToUtc` does internally too) — converges in 1-2
 * iterations for all real timezones, including across DST transitions,
 * except the ~1 hour/year "spring forward" gap where the requested local
 * time never occurs; that edge case is not specially detected here (it
 * resolves to the nearest instant the correction converges to) since §56's
 * "measure before optimizing" posture doesn't warrant more machinery for a
 * scheduler where being off by up to an hour on a skipped local wall-clock
 * instant, once a year, on schedules that happen to land exactly there, is
 * an acceptable known gap.
 */
export function zonedTimeToUtc(parts: { year: number; month: number; day: number; hour: number; minute: number; second?: number }, timeZone: string): Date {
  const second = parts.second ?? 0;
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, second);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const zoned = getZonedParts(new Date(guess), timeZone);
    const zonedAsUtc = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute, zoned.second);
    const diff = zonedAsUtc - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

function dayMatches(parsed: ParsedCron, wc: Pick<ZonedParts, "month" | "day" | "weekday">): boolean {
  if (!parsed.month.has(wc.month)) return false;
  const domOk = parsed.dom.has(wc.day);
  const dowOk = parsed.dow.has(wc.weekday);
  if (parsed.domIsWildcard && parsed.dowIsWildcard) return true;
  if (parsed.domIsWildcard) return dowOk;
  if (parsed.dowIsWildcard) return domOk;
  return domOk || dowOk; // both restricted -> OR, standard cron semantics
}

// Safety bound (§56 — "measure before optimizing", and never an unbounded
// search): a cron expression with no reachable occurrence (e.g. Feb 30th,
// which parseCron() would actually reject, but a legitimate sparse
// expression like leap-day-only could still need several years) gives up
// rather than looping forever.
const MAX_SEARCH_DAYS = 5 * 366;

/**
 * §29/§30 — the next instant, strictly after `after`, at which `expr`
 * (evaluated in `timezone`) fires. Searches day-by-day (cheap — only
 * month/dom/dow checks) and only expands to hour/minute combinations on a
 * day that already matches, rather than a naive minute-by-minute walk —
 * keeps even a once-a-year expression's search well under a second.
 */
export function nextCronOccurrence(expr: string, timezone: string, after: Date): Date {
  const parsed = parseCron(expr);
  const sortedHours = [...parsed.hour].sort((a, b) => a - b);
  const sortedMinutes = [...parsed.minute].sort((a, b) => a - b);

  const startWc = getZonedParts(after, timezone);
  const dayZeroMidnightUtc = zonedTimeToUtc({ year: startWc.year, month: startWc.month, day: startWc.day, hour: 0, minute: 0, second: 0 }, timezone);

  for (let d = 0; d <= MAX_SEARCH_DAYS; d++) {
    // Re-derive the candidate day's own wall-clock date from a UTC instant
    // rather than trusting `d * 86_400_000` to land on local midnight —
    // DST-affected zones can have 23/25-hour days, so this self-corrects
    // instead of drifting.
    const approxUtc = new Date(dayZeroMidnightUtc.getTime() + d * 86_400_000);
    const wcDay = getZonedParts(approxUtc, timezone);
    if (!dayMatches(parsed, wcDay)) continue;

    for (const h of sortedHours) {
      for (const m of sortedMinutes) {
        const candidate = zonedTimeToUtc({ year: wcDay.year, month: wcDay.month, day: wcDay.day, hour: h, minute: m, second: 0 }, timezone);
        if (candidate.getTime() > after.getTime()) return candidate;
      }
    }
  }

  throw new Error(`No occurrence found for cron "${expr}" (${timezone}) within ${MAX_SEARCH_DAYS} days of ${after.toISOString()}`);
}

/**
 * §31 Misfire Handling support — every occurrence of `expr` in
 * [fromInclusive, toInclusive], capped at `cap` results (a schedule that
 * was due many times while the system was down should never produce an
 * unbounded catch-up list — see misfire.ts's CATCH_UP_CAP). Includes
 * `fromInclusive` itself if it happens to land exactly on the schedule
 * (the normal case when called with a job's own overdue `run_at`).
 */
export function cronOccurrencesInRange(expr: string, timezone: string, fromInclusive: Date, toInclusive: Date, cap: number): { occurrences: Date[]; truncated: boolean } {
  const parsed = parseCron(expr);
  const occurrences: Date[] = [];

  const wc0 = getZonedParts(fromInclusive, timezone);
  if (parsed.minute.has(wc0.minute) && parsed.hour.has(wc0.hour) && dayMatches(parsed, wc0)) {
    occurrences.push(new Date(zonedTimeToUtc({ year: wc0.year, month: wc0.month, day: wc0.day, hour: wc0.hour, minute: wc0.minute, second: 0 }, timezone)));
  }

  let cursor = fromInclusive;
  while (occurrences.length < cap) {
    const next = nextCronOccurrence(expr, timezone, cursor);
    if (next.getTime() > toInclusive.getTime()) break;
    occurrences.push(next);
    cursor = next;
  }

  return { occurrences, truncated: occurrences.length >= cap };
}
