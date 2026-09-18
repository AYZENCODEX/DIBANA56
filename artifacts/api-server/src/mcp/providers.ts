import { pool } from "@workspace/db";

export interface ProviderRow {
  id: number;
  key: string;
  label: string;
  base_url: string;
  api_key_env: string;
  is_custom: boolean;
  enabled: boolean;
  sort_order: number;
}

const rrCounters: Record<string, number> = {};

// ── Provider (= "router") lookup ──────────────────────────────────────────────
export async function getProvider(key: string): Promise<ProviderRow | null> {
  const r = await pool.query("SELECT * FROM ai_providers WHERE key=$1", [key]);
  return r.rows[0] ?? null;
}

export async function listProviders(): Promise<ProviderRow[]> {
  const r = await pool.query("SELECT * FROM ai_providers ORDER BY sort_order, key");
  return r.rows;
}

// ── API key resolution ────────────────────────────────────────────────────────
// Prefers the DB-managed, round-robin key pool (robin_api_keys — same table
// the Key Manager admin page edits), and falls back to the provider's env var
// so existing deployments keep working with zero config. This means changing
// a provider's API key never requires a redeploy: add/rotate it in Key
// Manager and every MCP agent using that provider picks it up immediately.
export async function resolveApiKey(provider: ProviderRow): Promise<string | null> {
  try {
    const r = await pool.query(
      "SELECT id, key_value FROM robin_api_keys WHERE provider=$1 AND is_active=true ORDER BY slot",
      [provider.key]
    );
    if (r.rows.length > 0) {
      const idx = (rrCounters[provider.key] ?? 0) % r.rows.length;
      rrCounters[provider.key] = idx + 1;
      return r.rows[idx].key_value as string;
    }
  } catch {
    // robin_api_keys may not exist yet on very old installs — fall through to env.
  }
  return process.env[provider.api_key_env] ?? null;
}
