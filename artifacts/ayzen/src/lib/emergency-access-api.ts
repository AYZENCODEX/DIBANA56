/**
 * lib/emergency-access-api.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Feature 16 — Emergency Access / Dead-Man Switch.
 * Thin typed wrapper around customFetch for routes/emergency-access.ts.
 */
import { customFetch } from "@workspace/api-client-react";
import { getApiBase } from "@/lib/api-base";

function vaultApiPath(path: string): string {
  return `${getApiBase()}/api${path}`;
}

export interface EmergencyContact {
  id: number;
  contactName: string;
  contactEmail: string;
  waitDays: number;
  status: "active" | "revoked";
  confirmedAt: string | null;
  createdAt: string;
}

export interface EmergencyAccessGrant {
  id: number;
  contactId: number;
  ownerUserId: number;
  status: "pending_admin_review" | "approved" | "denied" | "cancelled" | "expired" | "revoked";
  ownerInactiveSinceAt: string | null;
  triggeredAt: string;
  cancelledAt: string | null;
  adminReviewedAt: string | null;
  adminNote: string | null;
  accessTokenExpiresAt: string | null;
  accessedAt: string | null;
}

// ─── Owner: manage contacts ─────────────────────────────────────────────────

export function listEmergencyContacts(): Promise<{ items: EmergencyContact[] }> {
  return customFetch(vaultApiPath("/emergency-access/contacts"));
}

export function addEmergencyContact(contactName: string, contactEmail: string, waitDays: number): Promise<EmergencyContact> {
  return customFetch(vaultApiPath("/emergency-access/contacts"), {
    method: "POST",
    body: JSON.stringify({ contactName, contactEmail, waitDays }),
  });
}

export function revokeEmergencyContact(contactId: number): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/emergency-access/contacts/${contactId}`), { method: "DELETE" });
}

// ─── Contact: confirm a nomination (public link, no auth) ──────────────────

export function confirmEmergencyContactInvite(token: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/emergency-access/confirm/${token}`), { method: "POST" });
}

// ─── Owner: view + cancel triggered grants (proof of life) ─────────────────

export function listEmergencyGrants(): Promise<{ items: EmergencyAccessGrant[] }> {
  return customFetch(vaultApiPath("/emergency-access/grants"));
}

export function cancelEmergencyGrant(grantId: number): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/emergency-access/grants/${grantId}/cancel`), { method: "POST" });
}

// ─── Admin: review triggered grants ─────────────────────────────────────────

export function listAdminEmergencyGrants(status = "pending_admin_review"): Promise<{ items: any[] }> {
  return customFetch(vaultApiPath(`/admin/emergency-access/grants?status=${encodeURIComponent(status)}`));
}

export function approveEmergencyGrant(grantId: number, note?: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/admin/emergency-access/grants/${grantId}/approve`), {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

export function denyEmergencyGrant(grantId: number, note?: string): Promise<{ ok: true }> {
  return customFetch(vaultApiPath(`/admin/emergency-access/grants/${grantId}/deny`), {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

// ─── Contact: view the vault via an approved token link (public) ──────────

export function viewEmergencyAccessVault(token: string): Promise<{ entries: any[]; viewedAt: string; expiresAt: string }> {
  return customFetch(vaultApiPath(`/emergency-access/view/${token}`));
}
