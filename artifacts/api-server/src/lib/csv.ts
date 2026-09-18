/**
 * lib/csv.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Minimal, dependency-free RFC-4180-ish CSV parser/writer. Used by
 * routes/vault-migration.ts (import/export) and routes/compliance-report.ts
 * (CSV activity export). Handles quoted fields, embedded commas/newlines,
 * and doubled-quote escaping (`""` inside a quoted field) — the handful of
 * cases that break a naive `line.split(",")` parser and are exactly what
 * real exports from 1Password/Bitwarden/LastPass rely on.
 */

/** Parses CSV text into an array of row arrays (no header handling — see parseCsvObjects). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalize line endings so \r\n and \r don't produce phantom blank rows.
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  // Flush the final field/row (files without a trailing newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully-empty trailing rows (common with a trailing newline).
  return rows.filter(r => !(r.length === 1 && r[0] === ""));
}

/** Parses CSV text with a header row into an array of { header: value } objects. */
export function parseCsvObjects(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(r => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}

function csvEscape(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Serializes an array of objects into CSV text using `columns` as the header/order. */
export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map(c => csvEscape(row[c])).join(","));
  }
  return lines.join("\n");
}
