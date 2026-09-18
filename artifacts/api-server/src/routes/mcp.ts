/**
 * routes/mcp.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this at: artifacts/api-server/src/routes/mcp.ts
 *
 * A minimal MCP (Model Context Protocol) server, mounted at POST /mcp, that
 * lets a user connect an MCP-capable client (Claude, etc.) straight to their
 * own AYZEN account — read vault entries, create/update entries, list
 * projects, pull a dashboard summary — using the exact same AYZEN API key
 * they already generate from Settings → Developer → API Keys
 * (routes/api-keys.ts). No new auth system: `Authorization: Bearer
 * ayzn_live_xxx` on the MCP request is the same bearer requireAuth already
 * accepts everywhere else.
 *
 * Deliberately implemented as a thin JSON-RPC wrapper that calls this same
 * server's own REST endpoints over loopback HTTP (forwarding the caller's
 * Authorization header) rather than re-implementing vault field encryption,
 * validation, health-rule recompute, etc. a second time. That keeps this
 * file in sync with routes/vault.ts automatically — if a field is added to
 * the REST API, this wrapper doesn't drift out of date.
 *
 * Protocol notes: implements the JSON-RPC request/response shape of MCP's
 * Streamable HTTP transport (initialize, tools/list, tools/call) as a single
 * POST endpoint. No SSE/session-resumption — sufficient for a single-user
 * request/response client like Claude's remote-MCP connector.
 */
import { Router } from "express";
import { requireAuth } from "../middlewares/auth";

const router = Router();

const INTERNAL_PORT = process.env["AYZEN_API_PORT"] ?? process.env["PORT"] ?? "8080";
const INTERNAL_BASE = `http://localhost:${INTERNAL_PORT}/api`;

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions (JSON-RPC "tools/list" shape)
// ─────────────────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "ayzen_list_vault_entries",
    description: "List the user's vault entities (summary only — no passwords/secrets). Optionally filter by category.",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string", description: "Optional category filter, e.g. 'twitter', 'discord'" } },
    },
  },
  {
    name: "ayzen_get_vault_entry",
    description: "Get full details of one vault entry by id, including decrypted credentials. Use only when the user explicitly wants a specific credential revealed.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Vault entry id" } },
      required: ["id"],
    },
  },
  {
    name: "ayzen_create_vault_entry",
    description: "Create a new vault entry. Core fields only — for the full field set (Twitter/Discord/Telegram sub-accounts, seed phrase, etc.) use the AYZEN web app.",
    inputSchema: {
      type: "object",
      properties: {
        projectName: { type: "string" },
        username: { type: "string" },
        email: { type: "string" },
        accountPassword: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["projectName"],
    },
  },
  {
    name: "ayzen_update_vault_entry",
    description: "Update fields on an existing vault entry by id. Only send the fields being changed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        projectName: { type: "string" },
        username: { type: "string" },
        email: { type: "string" },
        accountPassword: { type: "string" },
        notes: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "ayzen_list_projects",
    description: "List the projects the user is enrolled in.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ayzen_dashboard_summary",
    description: "Get a quick summary: total vault entries, how many are currently flagged by the health scan, and the user's streak/ROI stats.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Internal REST call helper — forwards the caller's own Authorization header
// ─────────────────────────────────────────────────────────────────────────────
async function callApi(authHeader: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${INTERNAL_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: authHeader },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: unknown;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) throw new Error(typeof data === "object" && data && "error" in (data as any) ? (data as any).error : `API error ${r.status}`);
  return data;
}

function toolContent(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function callTool(authHeader: string, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "ayzen_list_vault_entries": {
      const rows = (await callApi(authHeader, "GET", "/vault")) as any[];
      const filtered = args.category ? rows.filter((r) => r.category === args.category) : rows;
      const summary = filtered.map((r) => ({
        id: r.id, projectName: r.projectName, category: r.category,
        username: r.username, email: r.email, lastLoginAt: r.lastLoginAt,
        flagged: Array.isArray(r.lastHealthFlags) ? r.lastHealthFlags.length > 0 : Boolean(r.lastHealthFlags),
      }));
      return toolContent(summary);
    }
    case "ayzen_get_vault_entry": {
      if (!args.id) throw new Error("id is required");
      return toolContent(await callApi(authHeader, "GET", `/vault/${args.id}`));
    }
    case "ayzen_create_vault_entry": {
      if (!args.projectName) throw new Error("projectName is required");
      return toolContent(await callApi(authHeader, "POST", "/vault", args));
    }
    case "ayzen_update_vault_entry": {
      if (!args.id) throw new Error("id is required");
      const { id, ...fields } = args;
      return toolContent(await callApi(authHeader, "PATCH", `/vault/${id}`, fields));
    }
    case "ayzen_list_projects": {
      return toolContent(await callApi(authHeader, "GET", "/projects"));
    }
    case "ayzen_dashboard_summary": {
      const [entries, me] = await Promise.all([
        callApi(authHeader, "GET", "/vault") as Promise<any[]>,
        callApi(authHeader, "GET", "/auth/me") as Promise<any>,
      ]);
      const flagged = entries.filter((r) => (Array.isArray(r.lastHealthFlags) ? r.lastHealthFlags.length > 0 : Boolean(r.lastHealthFlags))).length;
      return toolContent({
        totalVaultEntries: entries.length,
        flaggedEntries: flagged,
        streak: me?.streak ?? 0,
        totalRoi: me?.totalRoi ?? 0,
        digestFrequency: me?.digestFrequency ?? "daily",
      });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /mcp — single JSON-RPC endpoint (initialize / tools/list / tools/call)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/mcp", requireAuth, async (req, res): Promise<void> => {
  const authHeader = req.headers.authorization as string; // requireAuth already validated this
  const { jsonrpc, id, method, params } = req.body ?? {};

  const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id: id ?? null, result });
  const replyError = (code: number, message: string) => res.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (jsonrpc !== "2.0" || !method) { replyError(-32600, "Invalid JSON-RPC request"); return; }

  try {
    switch (method) {
      case "initialize":
        reply({
          protocolVersion: "2024-11-05",
          serverInfo: { name: "ayzen", version: "1.0.0" },
          capabilities: { tools: {} },
        });
        return;
      case "tools/list":
        reply({ tools: TOOLS });
        return;
      case "tools/call": {
        const name = params?.name as string;
        const args = (params?.arguments ?? {}) as Record<string, unknown>;
        if (!name) { replyError(-32602, "params.name is required"); return; }
        try {
          reply(await callTool(authHeader, name, args));
        } catch (err: any) {
          reply({ content: [{ type: "text", text: `Error: ${err?.message ?? err}` }], isError: true });
        }
        return;
      }
      default:
        replyError(-32601, `Method not found: ${method}`);
    }
  } catch (err: any) {
    replyError(-32603, err?.message ?? "Internal error");
  }
});

export default router;
