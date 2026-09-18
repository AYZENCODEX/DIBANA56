/**
 * lib/vault-migration-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 13 — Import/Export Migration Tool.
 * Thin typed wrapper around customFetch for routes/vault-migration.ts.
 */
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

function vaultApiPath(path: string): string {
  return `${getApiBase()}/api${path}`;
}

export type ImportFormat = "ayzen_csv" | "ayzen_json" | "1password" | "bitwarden" | "lastpass";

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: { row?: number; index?: number; reason: string }[];
}

/** Downloads the caller's Vault entries as CSV or JSON and triggers a browser save. */
export async function exportVault(format: "csv" | "json"): Promise<void> {
  const blob = await customFetch<Blob>(vaultApiPath(`/vault/export?format=${format}`), { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ayzen-vault-export.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function importVault(format: ImportFormat, data: string): Promise<ImportResult> {
  return customFetch(vaultApiPath("/vault/import"), {
    method: "POST",
    body: JSON.stringify({ format, data }),
  });
}

/** Reads a browser File as text, for feeding into importVault(). */
export function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
