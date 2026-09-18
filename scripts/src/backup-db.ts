// scripts/src/backup-db.ts
// ─────────────────────────────────────────────────────────────────────────────
// Backs up the primary Postgres database (DATABASE_URL — your Neon/Supabase
// project) in two ways:
//   1. A timestamped, gzipped local .sql dump (kept for BACKUP_RETENTION_COUNT
//      runs, older ones pruned automatically).
//   2. If BACKUP_DATABASE_URL is set, mirrors the dump into a SECOND Postgres
//      database — a separate Neon/Supabase project, ideally on a different
//      account. This protects you even if something happens to the primary
//      project itself (accidental deletion, billing lockout, etc.), which a
//      provider's own point-in-time-recovery backups don't cover since those
//      live inside the same project.
//
// Requires the `pg_dump` and `psql` CLI tools on PATH (Postgres client tools —
// `apt install postgresql-client` / `brew install libpq`).
//
// Usage:
//   DATABASE_URL=... BACKUP_DATABASE_URL=... npx tsx scripts/src/backup-db.ts
//
// Typical setup: run this on a schedule (cron, GitHub Actions scheduled
// workflow, or a Render/Railway cron job) — e.g. every 6 hours.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const DATABASE_URL = process.env["DATABASE_URL"];
const BACKUP_DATABASE_URL = process.env["BACKUP_DATABASE_URL"]; // optional second DB to mirror into
const RETENTION = parseInt(process.env["BACKUP_RETENTION_COUNT"] ?? "14", 10);
const BACKUP_DIR = process.env["BACKUP_DIR"] ?? join(process.cwd(), "backups");

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set — nothing to back up.");
  process.exit(1);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function run() {
  mkdirSync(BACKUP_DIR, { recursive: true });

  const stamp = timestamp();
  const rawPath = join(BACKUP_DIR, `backup-${stamp}.sql`);
  const gzPath = `${rawPath}.gz`;

  console.log(`[backup-db] Dumping primary database...`);
  // --clean --if-exists so the dump can be replayed onto the mirror DB
  // idempotently (drops+recreates objects rather than erroring on conflicts).
  const dump = execFileSync(
    "pg_dump",
    ["--clean", "--if-exists", "--no-owner", "--no-privileges", DATABASE_URL as string],
    { maxBuffer: 1024 * 1024 * 1024 }
  );

  writeFileSync(gzPath, gzipSync(dump));
  console.log(`[backup-db] Saved local dump: ${gzPath} (${(dump.length / 1024 / 1024).toFixed(2)} MB uncompressed)`);

  if (BACKUP_DATABASE_URL) {
    console.log(`[backup-db] Mirroring into backup database...`);
    // Write the raw (uncompressed) dump to a temp file for psql to consume,
    // then remove it — we don't keep two copies of the plaintext dump around.
    writeFileSync(rawPath, dump);
    try {
      execFileSync("psql", [BACKUP_DATABASE_URL, "-f", rawPath], { stdio: "inherit" });
      console.log(`[backup-db] Mirror complete.`);
    } finally {
      unlinkSync(rawPath);
    }
  } else {
    console.log(`[backup-db] BACKUP_DATABASE_URL not set — skipping mirror step (local dump only).`);
  }

  // Retention: keep the newest N local dumps, delete the rest.
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("backup-") && f.endsWith(".sql.gz"))
    .map((f) => ({ name: f, mtime: statSync(join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const old of files.slice(RETENTION)) {
    unlinkSync(join(BACKUP_DIR, old.name));
    console.log(`[backup-db] Pruned old backup: ${old.name}`);
  }

  console.log(`[backup-db] Done. ${Math.min(files.length, RETENTION)} local backup(s) retained.`);
}

run();
