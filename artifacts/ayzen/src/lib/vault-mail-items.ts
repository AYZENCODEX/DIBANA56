// Shared helpers for the Vault Mail Hub hierarchy (category → entity → mail).
// Each "MailItem" is one email address found on a vault record, tagged with
// which section it came from (entity/local/kyc/game) and which record id it
// belongs to, so the hierarchy pages can group addresses back into entities.

export type MailCategory = "entity" | "local" | "kyc" | "game";

export interface MailItem {
  id: string;
  category: MailCategory;
  entityId: number;
  entityName: string;
  label: string;
  email: string;
  password?: string | null;
  recovery?: string | null;
  recoveryPassword?: string | null;
  twofa?: string | null;
}

export interface MailEntitySummary {
  category: MailCategory;
  entityId: number;
  entityName: string;
  items: MailItem[];
}

export function buildEntityMailItems(entries: any[]): MailItem[] {
  const items: MailItem[] = [];
  (entries ?? []).forEach(e => {
    if (e.email) items.push({ id: `entity-${e.id}-main`, category: "entity", entityId: e.id, entityName: e.projectName, label: "Main", email: e.email, password: e.emailPassword, recovery: e.emailRecovery, recoveryPassword: e.emailRecoveryPassword, twofa: e.email2fa });
    if (e.twitterEmail) items.push({ id: `entity-${e.id}-tw`, category: "entity", entityId: e.id, entityName: e.projectName, label: "Twitter", email: e.twitterEmail, password: e.twitterEmailPassword, recovery: e.twitterEmailRecovery, recoveryPassword: e.twitterEmailRecoveryPassword, twofa: e.twitter2fa });
    if (e.discordEmail) items.push({ id: `entity-${e.id}-dc`, category: "entity", entityId: e.id, entityName: e.projectName, label: "Discord", email: e.discordEmail, password: e.discordEmailPassword, recovery: e.discordEmailRecovery, recoveryPassword: e.discordEmailRecoveryPassword, twofa: e.discord2fa });
    if (e.telegramLinkedEmail) items.push({ id: `entity-${e.id}-tg`, category: "entity", entityId: e.id, entityName: e.projectName, label: "Telegram", email: e.telegramLinkedEmail, password: e.telegramLinkedEmailPassword, twofa: e.telegram2fa });
    if (e.otherAccounts) {
      try {
        const others: any[] = JSON.parse(e.otherAccounts);
        others.forEach((a, i) => {
          if (a?.email) items.push({ id: `entity-${e.id}-other-${i}`, category: "entity", entityId: e.id, entityName: e.projectName, label: a.platform || "Other", email: a.email, password: a.password });
        });
      } catch { /* ignore malformed otherAccounts JSON */ }
    }
  });
  return items;
}

export function buildLocalMailItems(accounts: any[]): MailItem[] {
  const items: MailItem[] = [];
  (accounts ?? []).forEach(a => {
    const name = a.label ?? a.username ?? a.category ?? `Account #${a.id}`;
    if (a.email) items.push({ id: `local-${a.id}-main`, category: "local", entityId: a.id, entityName: name, label: "Main", email: a.email, password: a.password, recovery: a.recovery_email, recoveryPassword: a.recovery_email_password, twofa: a.twofa });
    if (a.recovery_email && a.recovery_email !== a.email) items.push({ id: `local-${a.id}-rec`, category: "local", entityId: a.id, entityName: name, label: "Recovery", email: a.recovery_email, password: a.recovery_email_password, twofa: a.recovery_email_twofa });
  });
  return items;
}

export function buildKycMailItems(entries: any[]): MailItem[] {
  const items: MailItem[] = [];
  (entries ?? []).forEach(e => {
    const name = e.name ?? e.username ?? e.platform ?? `KYC #${e.id}`;
    if (e.email) items.push({ id: `kyc-${e.id}-main`, category: "kyc", entityId: e.id, entityName: name, label: "Main", email: e.email, password: e.email_password, twofa: e.email_2fa });
  });
  return items;
}

export function buildGameMailItems(entries: any[]): MailItem[] {
  const items: MailItem[] = [];
  (entries ?? []).forEach(e => {
    const name = e.username ?? e.category ?? `Game #${e.id}`;
    if (e.email) items.push({ id: `game-${e.id}-main`, category: "game", entityId: e.id, entityName: name, label: "Main", email: e.email, password: e.email_password, twofa: e.email_2fa });
  });
  return items;
}

/** Group a flat MailItem[] back into one summary per entity (for category list pages). */
export function groupByEntity(items: MailItem[]): MailEntitySummary[] {
  const map = new Map<string, MailEntitySummary>();
  items.forEach(item => {
    const key = `${item.category}-${item.entityId}`;
    if (!map.has(key)) map.set(key, { category: item.category, entityId: item.entityId, entityName: item.entityName, items: [] });
    map.get(key)!.items.push(item);
  });
  return [...map.values()];
}

export const MAIL_CATEGORY_LABEL: Record<MailCategory, string> = {
  entity: "Entity", local: "Local", kyc: "KYC", game: "Game",
};
