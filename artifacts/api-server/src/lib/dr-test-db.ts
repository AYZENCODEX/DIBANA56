/**
 * lib/dr-test-db.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * DR Evidence Collector — Phase 2 (schema-isolated restore).
 * See dr-evidence-collector-design.md §1 for the full design this
 * implements. Phase 1 (lib/dr-test-runner.ts) only ever ran
 * verifyStoredChecksum() + envelopeDecryptBackup() — no restore, no schema.
 * This module adds the one genuinely new piece of infrastructure Phase 2
 * needs: a throwaway, isolated Postgres schema to restore a decrypted
 * backup into, so restore is actually exercised (not just decrypt) without
 * ever touching a real user's rows.
 *
 * Why a dedicated pg.Client and not the app's `pool` (design doc §1):
 * `SET search_path` is session-scoped. A `Pool` hands out whichever
 * connection happens to be free, and — critically — recycles connections
 * between unrelated queries, so a `search_path` set on a pooled connection
 * would leak onto the next arbitrary query on that connection once
 * released. A single dedicated `pg.Client` (its own real connection, never
 * returned to any pool) is the only way to make `SET search_path` reliably
 * sticky for the whole lifetime of one DR test run, and to guarantee it
 * cannot bleed into unrelated production queries.
 *
 * Why the production MIGRATIONS array can just be re-run here, unmodified:
 * see lib/schema-migrations.ts's own header — none of its CREATE TABLE
 * statements schema-qualify their table names, so pointing `search_path` at
 * an isolated schema before running them recreates the whole table set
 * there, in isolation, with no separate migration script to maintain.
 *
 * Lifecycle for one DR test run (see lib/dr-test-runner.ts):
 *   const iso = await createIsolatedSchema(testId);
 *   try {
 *     ... await applyRestoreDiff(userId, snapshot, { dbOverride: iso.db }) ...
 *     ... SELECT COUNT(*) against iso.db per restored table ...
 *   } finally {
 *     await dropIsolatedSchema(iso);   // ALWAYS runs, even on failure
 *   }
 */
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { buildPoolConfig } from "@workspace/db";
import * as schema from "@workspace/db/schema";
import { MIGRATIONS } from "./schema-migrations";
import { logger } from "./logger";
import { logBus } from "./log-bus";

const { Client } = pg;

export interface IsolatedSchema {
  schemaName: string;
  client: pg.Client;
  // Drizzle instance bound to `client`'s session (and therefore to
  // `schemaName` via search_path) — this is the `dbOverride` DR test runs
  // pass into applyRestoreDiff(). Deliberately typed structurally
  // compatible with the production `db` export (same drizzle-orm factory,
  // same schema), never the production connection itself.
  db: ReturnType<typeof drizzle<typeof schema>>;
  /** Any migration statement that threw while standing up the schema (see runMigrationsAgainst()'s per-statement try/catch). Empty on a clean stand-up. */
  migrationErrors: { statement: string; message: string }[];
}

/**
 * Generates a schema name that's always a valid, unquoted-safe Postgres
 * identifier (lowercase ascii + digits + underscore, well under the 63-byte
 * limit) without depending on `test_id`'s human-readable format (which
 * contains hyphens Postgres identifiers can't take unquoted). Timestamp +
 * random suffix is enough to make collisions between concurrent runs
 * practically impossible; a genuine collision would just fail the
 * `CREATE SCHEMA` (no `IF NOT EXISTS` — see createIsolatedSchema()) and
 * surface as a normal "schema_create" failure stage rather than silently
 * reusing another run's schema.
 */
export function generateSchemaName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `dr_test_${Date.now()}_${rand}`;
}

// Defense-in-depth: schemaName always comes from generateSchemaName() above,
// never from user input, but every place below that interpolates it into
// raw SQL (CREATE SCHEMA / DROP SCHEMA / SET search_path can't be
// parameterized — identifiers, not values) re-checks this shape first
// rather than trusting the caller.
const SAFE_SCHEMA_NAME = /^dr_test_[a-z0-9_]+$/;

function assertSafeSchemaName(schemaName: string): void {
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Refusing to use unsafe DR test schema name: ${schemaName}`);
  }
}

/** Runs the shared MIGRATIONS array against `client`'s current session — whatever `search_path` is already set to. Same per-statement try/catch/log pattern as index.ts's waitForDbThenMigrate(), since a handful of ALTER TABLE statements existing purely for legacy production upgrades are expected to be no-ops (or occasionally inapplicable) against a brand-new schema. */
async function runMigrationsAgainst(client: pg.Client): Promise<{ statement: string; message: string }[]> {
  const errors: { statement: string; message: string }[] = [];
  for (const q of MIGRATIONS) {
    try {
      await client.query(q);
    } catch (err: any) {
      errors.push({ statement: q.slice(0, 120), message: err?.message ?? String(err) });
    }
  }
  return errors;
}

/**
 * Stands up a brand-new, empty, isolated schema with the full production
 * table set inside it, ready for a restore to be applied into. Never
 * throws for a migration-statement failure (collected in the returned
 * `migrationErrors` instead — see runDrTest()'s "schema" failure stage);
 * DOES throw if the dedicated connection itself can't be opened or
 * `CREATE SCHEMA` fails outright, since neither of those leaves anything
 * for dropIsolatedSchema() to clean up.
 */
export async function createIsolatedSchema(testId: string): Promise<IsolatedSchema> {
  const schemaName = generateSchemaName();
  assertSafeSchemaName(schemaName);

  const client = new Client(buildPoolConfig());
  await client.connect();

  try {
    // No "IF NOT EXISTS" — a name collision (see generateSchemaName()'s
    // comment) should surface as a real failure, not silently attach to
    // whatever schema already happens to exist under that name.
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}", public`);
  } catch (err) {
    // Nothing durable was created (or CREATE SCHEMA itself failed) — just
    // release the connection, there's no schema for dropIsolatedSchema()
    // to be called against.
    await client.end().catch(() => {});
    throw err;
  }

  const migrationErrors = await runMigrationsAgainst(client);

  const isolatedDb = drizzle(client, { schema });

  logBus.system(`DR test ${testId}: isolated schema "${schemaName}" ready (${MIGRATIONS.length - migrationErrors.length}/${MIGRATIONS.length} migration statements applied)`);
  if (migrationErrors.length) {
    logger.warn({ testId, schemaName, migrationErrors }, "DR test isolated-schema migration had errors");
  }

  return { schemaName, client, db: isolatedDb, migrationErrors };
}

/**
 * Drops the isolated schema and closes its dedicated connection. Always
 * safe to call — designed to sit in a `finally` block (see
 * lib/dr-test-runner.ts) so a schema is never left behind even when the
 * restore itself failed partway through. Never throws: a cleanup failure
 * is logged (and, per the design doc §2, would ideally also be reflected
 * in the evidence record by the caller) rather than masking whatever
 * result the DR test actually produced.
 */
export async function dropIsolatedSchema(iso: Pick<IsolatedSchema, "schemaName" | "client">): Promise<{ ok: boolean; error?: string }> {
  assertSafeSchemaName(iso.schemaName);
  try {
    await iso.client.query(`DROP SCHEMA IF EXISTS "${iso.schemaName}" CASCADE`);
    return { ok: true };
  } catch (err: any) {
    logger.error({ schemaName: iso.schemaName, err }, "DR test isolated-schema cleanup (DROP SCHEMA) failed");
    logBus.error(`DR test cleanup FAILED for schema "${iso.schemaName}": ${err?.message ?? err}`);
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    // Always close the dedicated connection regardless of whether the DROP
    // itself succeeded — an orphaned schema (rare, and itself logged above)
    // is a lesser problem than an orphaned open connection.
    await iso.client.end().catch(() => {});
  }
}

/**
 * SELECT COUNT(*) for one table under the isolated schema's search_path.
 * `sqlTable` must be one of this module's own known-safe identifiers (the
 * RestoreTableKey → physical-table map lib/dr-test-runner.ts builds from
 * lib/vault-snapshot-restore.ts's own RAW_PLANS + drizzle table objects) —
 * never derived from request input.
 */
export async function countRows(iso: Pick<IsolatedSchema, "client">, sqlTable: string): Promise<number> {
  const result = await iso.client.query(`SELECT COUNT(*)::int AS count FROM "${sqlTable}"`);
  return Number(result.rows[0]?.count ?? 0);
}
