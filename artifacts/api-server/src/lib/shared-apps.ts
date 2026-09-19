/**
 * The branded AYZEN products intentionally run behind one API deployment.
 * This module is the server-side source of truth for the host-to-app mapping
 * used by redirects, shared API discovery, and SIORA request context.
 *
 * It does not perform authentication or authorization. Those remain owned by
 * the existing auth and Policy Engine middleware.
 */

export type SharedAppId = "sylo" | "ryft" | "verve" | "skarn" | "warde" | "wisp" | "zynth";

export type SharedAppDefinition = {
  id: SharedAppId;
  label: string;
  homePath: string;
  routePrefixes: readonly string[];
  hostEnv: string;
  defaultHost: string;
};

export const SHARED_APP_DEFINITIONS: readonly SharedAppDefinition[] = [
  { id: "sylo", label: "Sylo", homePath: "/vault", routePrefixes: ["/vault", "/admin/vault", "/admin/team-vault"], hostEnv: "SYLO_HOSTS", defaultHost: "sylo.ayzen.tech" },
  { id: "ryft", label: "Ryft", homePath: "/wallet", routePrefixes: ["/wallet", "/wallets", "/finance", "/admin/tools/wallet"], hostEnv: "RYFT_HOSTS", defaultHost: "ryft.ayzen.tech" },
  { id: "verve", label: "Verve", homePath: "/marketplace/hub", routePrefixes: ["/marketplace", "/admin/marketplace", "/admin/marketplace-categories", "/admin/marketplace-market-config"], hostEnv: "VERVE_HOSTS", defaultHost: "verve.ayzen.tech" },
  { id: "skarn", label: "Skarn", homePath: "/projects", routePrefixes: ["/projects", "/tasks", "/content", "/admin/projects", "/admin/project-templates", "/admin/operator-progress", "/admin/tasks"], hostEnv: "SKARN_HOSTS", defaultHost: "skarn.ayzen.tech" },
  { id: "warde", label: "Warde", homePath: "/teams", routePrefixes: ["/teams", "/team_leader", "/admin/teams", "/admin/team-vault"], hostEnv: "WARDE_HOSTS", defaultHost: "warde.ayzen.tech" },
  { id: "wisp", label: "Wisp", homePath: "/mailbox", routePrefixes: ["/mailbox", "/ayzen-email", "/email-accounts", "/admin/mail-sending-config"], hostEnv: "WISP_HOSTS", defaultHost: "wisp.ayzen.tech" },
  { id: "zynth", label: "Zynth", homePath: "/assistant", routePrefixes: ["/assistant", "/admin/ai-agent"], hostEnv: "ZYNTH_HOSTS", defaultHost: "zynth.ayzen.tech" },
];

function configuredHosts(definition: SharedAppDefinition): string[] {
  return (process.env[definition.hostEnv] ?? definition.defaultHost)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

const hostToApp = new Map<string, SharedAppDefinition>(
  SHARED_APP_DEFINITIONS.flatMap((definition) =>
    configuredHosts(definition).map((host) => [host, definition] as const),
  ),
);

export function getSharedAppForHost(hostname: string | undefined): SharedAppDefinition | null {
  if (!hostname) return null;
  return hostToApp.get(hostname.trim().toLowerCase().split(":")[0]) ?? null;
}

export function getSharedAppHosts(definition: SharedAppDefinition): string[] {
  return configuredHosts(definition);
}

export function getSharedAppCatalog(): Array<Omit<SharedAppDefinition, "hostEnv" | "defaultHost"> & { hosts: string[] }> {
  return SHARED_APP_DEFINITIONS.map(({ hostEnv: _hostEnv, defaultHost: _defaultHost, ...definition }) => ({
    ...definition,
    routePrefixes: [...definition.routePrefixes],
    hosts: getSharedAppHosts(SHARED_APP_DEFINITIONS.find((item) => item.id === definition.id)!),
  }));
}