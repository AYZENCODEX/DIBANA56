/**
 * lib/vault-attachments-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 12 — Document/File Attachments.
 * Thin typed wrapper around customFetch for routes/vault-attachments.ts.
 * Same hand-written pattern as vault-security-api.ts.
 */
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

function vaultApiPath(path: string): string {
  return `${getApiBase()}/api${path}`;
}

export type AttachmentCategory = "id_scan" | "contract" | "screenshot" | "other";

export interface VaultAttachmentMeta {
  id: number;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  category: AttachmentCategory;
  note: string | null;
  uploadedAt: string;
  updatedAt: string;
}

export interface VaultAttachmentWithData extends VaultAttachmentMeta {
  dataBase64: string;
}

export function listVaultAttachments(entityId: number): Promise<{ items: VaultAttachmentMeta[] }> {
  return customFetch(vaultApiPath(`/vault/${entityId}/attachments`));
}

/** Reads a browser File into a base64 string (no data-URL prefix) for upload. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.includes(",") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export async function uploadVaultAttachment(
  entityId: number,
  file: File,
  opts?: { category?: AttachmentCategory; note?: string },
): Promise<VaultAttachmentMeta> {
  const dataBase64 = await fileToBase64(file);
  return customFetch(vaultApiPath(`/vault/${entityId}/attachments`), {
    method: "POST",
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      category: opts?.category ?? "other",
      note: opts?.note,
      dataBase64,
    }),
  });
}

export function getVaultAttachment(entityId: number, attachmentId: number): Promise<VaultAttachmentWithData> {
  return customFetch(vaultApiPath(`/vault/${entityId}/attachments/${attachmentId}`));
}

/** Triggers a browser download of the decrypted file. */
export async function downloadVaultAttachment(entityId: number, attachmentId: number): Promise<void> {
  const blob = await customFetch<Blob>(
    vaultApiPath(`/vault/${entityId}/attachments/${attachmentId}?raw=1`),
    { responseType: "blob" },
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function renameVaultAttachment(
  entityId: number,
  attachmentId: number,
  updates: { fileName?: string; category?: AttachmentCategory; note?: string | null },
): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/vault/${entityId}/attachments/${attachmentId}`), {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export function deleteVaultAttachment(entityId: number, attachmentId: number): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/vault/${entityId}/attachments/${attachmentId}`), { method: "DELETE" });
}
