/**
 * lib/policy/pip/drizzle-device-trust-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The real `DeviceTrustProvider` (see device-trust-adapter.ts for the
 * interface this implements and for why this module deliberately only
 * ever reports "trusted"/"unknown", never "untrusted"), backed by
 * `user_sessions` — same raw-SQL-table posture
 * `drizzle-session-context-provider.ts` (this phase) and
 * `login-security-risk-provider.ts` (10B) already document for tables
 * outside the Drizzle schema.
 *
 * ── The query, and its known limitation ───────────────────────────────────
 * `SELECT 1 ... WHERE user_id = $1 AND user_agent = $2 LIMIT 1` — true iff
 * ANY session row (active, revoked, or expired — this is a "have we ever
 * seen this device" fact, not a "is this device currently valid" one)
 * exists for this exact User-Agent string. Deliberately not scoped to
 * `revoked_at IS NULL` the way `drizzle-session-context-provider.ts` scopes
 * ITS query: a device someone used from a now-revoked or since-expired
 * session was still, factually, seen before — revoking a session doesn't
 * un-happen the device having been used.
 *
 * Known limitation (documented, not silently glossed over): a User-Agent
 * string alone is a coarse fingerprint — it changes on every browser
 * version bump and is identical across every user of the same
 * browser/OS/version combination, so this is a weak, best-effort signal,
 * not a strong device-identity claim. Real device fingerprinting (Rule 18:
 * no mock-to-prod without real backend) is out of scope for this phase —
 * see device-trust-adapter.ts's own header for why a coarser-but-real
 * signal was chosen over inventing one that doesn't exist in this
 * codebase.
 *
 * Nothing in the app constructs `DrizzleDeviceTrustProvider` yet — same
 * additive, unwired posture every other Drizzle/DB-backed provider in this
 * engine already has. Deliberately excluded from `lib/policy/index.ts`'s
 * barrel — import it directly where actually needed.
 */

import { pool } from "@workspace/db";
import type { DeviceSignal, DeviceTrustProvider } from "./device-trust-adapter";

export class DrizzleDeviceTrustProvider implements DeviceTrustProvider {
  async getDeviceSignal(userId: number, userAgent: string): Promise<DeviceSignal> {
    const r = await pool.query(`SELECT 1 FROM user_sessions WHERE user_id = $1 AND user_agent = $2 LIMIT 1`, [
      userId,
      userAgent,
    ]);
    return { seenBefore: r.rows.length > 0 };
  }
}
