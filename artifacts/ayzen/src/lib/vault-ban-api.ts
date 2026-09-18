/**
 * lib/vault-ban-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Ban / unban support for Vault entities, local accounts, and KYC entities,
 * plus per-platform ban tags on an entity's Twitter/Discord/Telegram/Other
 * sub-accounts.
 *
 * Thin hand-written wrapper around customFetch, using the same request
 * shape as the generated OpenAPI client — since the generated
 * VaultEntryUpdate type doesn't cover `status`/`*Banned` yet even though the
 * backend already accepts them (see routes/vault.ts PATCH /vault/:id,
 * routes/local-accounts.ts PATCH /local-accounts/:id/status, routes/kyc.ts
 * PATCH /kyc-entries/:id/status). All paths are prefixed with `/api` — only
 * that prefix is proxied to the API server (see vite.config.ts's dev proxy
 * and app.ts's `app.use("/api", ..., router)`), same convention already used
 * in components/local-accounts.tsx and components/kyc-entries.tsx.
 */
import { customFetch } from "@workspace/api-client-react";

export type BannableCategory = "entity" | "local" | "kyc";

/** Ban or unban a whole entity/local-account/KYC-entity — this is what makes
 *  it show up in the Vault sidebar's Banned section. */
export function setBanned(category: BannableCategory, id: number, banned: boolean): Promise<unknown> {
  const status = banned ? "banned" : "active";
  if (category === "entity") {
    return customFetch(`/api/vault/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  }
  if (category === "local") {
    return customFetch(`/api/local-accounts/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
  }
  return customFetch(`/api/kyc-entries/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
}

export type EntityPlatform = "twitter" | "discord" | "telegram";

const PLATFORM_FIELD: Record<EntityPlatform, string> = {
  twitter: "twitterBanned",
  discord: "discordBanned",
  telegram: "telegramBanned",
};

/** Ban or unban a single linked platform account (Twitter/Discord/Telegram)
 *  within one entity — independent of the entity's own overall status. */
export function setEntityPlatformBanned(entityId: number, platform: EntityPlatform, banned: boolean): Promise<unknown> {
  return customFetch(`/api/vault/${entityId}`, {
    method: "PATCH",
    body: JSON.stringify({ [PLATFORM_FIELD[platform]]: banned }),
  });
}

/** Ban or unban one entry in an entity's `otherAccounts` JSON array (tagged
 *  by array index) — sends the whole updated array back, same as any other
 *  otherAccounts edit. */
export function setOtherAccountBanned(entityId: number, otherAccounts: any[], index: number, banned: boolean): Promise<unknown> {
  const next = otherAccounts.map((a, i) => (i === index ? { ...a, banned } : a));
  return customFetch(`/api/vault/${entityId}`, {
    method: "PATCH",
    body: JSON.stringify({ otherAccounts: JSON.stringify(next) }),
  });
}
