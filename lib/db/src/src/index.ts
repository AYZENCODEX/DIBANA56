import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

function buildPoolConfig(): pg.PoolConfig {
  let connectionString = process.env.DATABASE_URL!;
  let needsSsl = false;

  try {
    const url = new URL(connectionString);
    const isSupabase = /supabase\.co$|pooler\.supabase\.com$/.test(url.hostname);

    if (isSupabase) {
      needsSsl = true;
      // Supabase's transaction pooler (port 6543) does not support prepared
      // statements, which Drizzle relies on. Force the session pooler (5432).
      if (url.port === "6543") {
        url.port = "5432";
        connectionString = url.toString();
      }
    }
  } catch {
    // If DATABASE_URL isn't a valid URL, fall back to using it as-is.
  }

  const config: pg.PoolConfig = { connectionString };
  if (needsSsl) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

export const pool = new Pool(buildPoolConfig());
export const db = drizzle(pool, { schema });

export * from "./schema";
