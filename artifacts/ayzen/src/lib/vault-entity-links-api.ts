/**
 * lib/vault-entity-links-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Entity relationship linking — mark that a vault entity is an alt of another,
 * shares a wallet/email/device with another, etc. Thin hand-written wrapper
 * around customFetch (same convention as vault-ban-api.ts), since this is a
 * new, small surface not worth round-tripping through the OpenAPI/orval
 * codegen. See routes/vault-entity-links.ts on the server.
 */
import { customFetch } from "@workspace/api-client-react";

export const RELATION_TYPES = [
  "alt_of", "main_of", "shares_wallet", "shares_email", "shares_ip", "shares_device", "same_owner", "other",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export const RELATION_LABELS: Record<RelationType, string> = {
  alt_of: "Alt of",
  main_of: "Main of",
  shares_wallet: "Shares wallet",
  shares_email: "Shares email",
  shares_ip: "Shares IP",
  shares_device: "Shares device",
  same_owner: "Same owner",
  other: "Other",
};

export type LinkedEntityRef = {
  id: number;
  projectName?: string | null;
  username?: string | null;
  category?: string | null;
  status?: string | null;
  label: string;
};

export type EntityLink = {
  id: number;
  relationType: RelationType;
  note: string | null;
  createdAt: string;
  entity: { id: number; projectName?: string | null; username?: string | null };
  linkedEntity: LinkedEntityRef;
};

export function listEntityLinks(entityId: number): Promise<EntityLink[]> {
  return customFetch(`/api/vault/${entityId}/links`) as Promise<EntityLink[]>;
}

export function createEntityLink(params: {
  entityId: number;
  linkedEntityId: number;
  relationType: RelationType;
  note?: string;
}): Promise<EntityLink> {
  return customFetch(`/api/vault-entity-links`, { method: "POST", body: JSON.stringify(params) }) as Promise<EntityLink>;
}

export function updateEntityLink(id: number, params: { relationType?: RelationType; note?: string }): Promise<unknown> {
  return customFetch(`/api/vault-entity-links/${id}`, { method: "PATCH", body: JSON.stringify(params) });
}

export function deleteEntityLink(id: number): Promise<unknown> {
  return customFetch(`/api/vault-entity-links/${id}`, { method: "DELETE" });
}
