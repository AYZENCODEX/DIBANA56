/**
 * lib/vault-field-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-field "Change" + commit history for a Vault entity's credential fields
 * (see CredRow in pages/user/vault-entity-detail.tsx). Backs onto
 * PATCH /vault/:id/field and GET /vault/:id/field-history in
 * routes/vault.ts — updating exactly one column at a time instead of the
 * whole multi-tab entity form, with every change recorded old -> new.
 *
 * Thin hand-written wrapper around customFetch, same convention as
 * lib/vault-ban-api.ts — all paths prefixed with `/api`.
 */
import { customFetch } from "@workspace/api-client-react";

export interface VaultFieldHistoryEntry {
  id: number;
  field: string;
  fieldLabel: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: string;
}

/** Update exactly one scalar field on a vault entity, logging the change. */
export function updateVaultField(entityId: number, field: string, value: string): Promise<unknown> {
  return customFetch(`/api/vault/${entityId}/field`, {
    method: "PATCH",
    body: JSON.stringify({ field, value }),
  });
}

/** Commit history for one field on one entity, newest first. */
export function getVaultFieldHistory(entityId: number, field: string): Promise<VaultFieldHistoryEntry[]> {
  return customFetch(`/api/vault/${entityId}/field-history?field=${encodeURIComponent(field)}`);
}
