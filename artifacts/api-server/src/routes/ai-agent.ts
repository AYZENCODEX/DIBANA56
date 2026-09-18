import { Router } from "express";
import { pool } from "@workspace/db";
import { requireRoles } from "../middlewares/auth";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const router = Router();
const requireDev = requireRoles("dev");
const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(process.cwd(), "../../");

function resolveSafePath(rel: string): string {
  const target = path.resolve(REPO_ROOT, rel);
  if (!target.startsWith(REPO_ROOT)) throw new Error("Path escapes repository root");
  if (/node_modules|\.git\//.test(rel)) throw new Error("Path is blocked");
  return target;
}

// ── MCP-style tools available to the AI agent ─────────────────────────────────
async function runTool(toolName: string, input: Record<string, any>, sessionId: string): Promise<string> {
  switch (toolName) {
    case "execute_sql": {
      const { query } = input;
      if (!query) return "Error: query is required";
      const dangerous = /drop table|truncate|delete from users|update users set role/i;
      if (dangerous.test(query)) return "Error: Destructive query blocked. Use specific WHERE clauses.";
      try {
        const r = await pool.query(query);
        return JSON.stringify({ rows: r.rows.slice(0, 100), rowCount: r.rowCount });
      } catch (e: any) { return `SQL Error: ${e.message}`; }
    }
    case "execute_shell": {
      const { command } = input;
      if (!command) return "Error: command is required";
      const blocked = /rm -rf|mkfs|dd if|:(){ :|:& };:|shutdown|reboot/;
      if (blocked.test(command)) return "Error: Command blocked for safety.";
      try {
        const { stdout, stderr } = await execAsync(command, { timeout: 10000, cwd: process.cwd() });
        return stdout || stderr || "(no output)";
      } catch (e: any) { return `Shell Error: ${e.message}`; }
    }
    case "query_logs": {
      const { level, limit = 20 } = input;
      try {
        let q = "SELECT route, method, status_code, duration_ms, recorded_at FROM request_metrics";
        if (level === "error") q += " WHERE status_code >= 500";
        else if (level === "warn") q += " WHERE status_code >= 400";
        q += ` ORDER BY recorded_at DESC LIMIT ${Number(limit)}`;
        const r = await pool.query(q);
        return JSON.stringify(r.rows);
      } catch (e: any) { return `Log Error: ${e.message}`; }
    }
    case "query_error_logs": {
      const { limit = 20 } = input;
      try {
        const r = await pool.query(
          "SELECT level, message, endpoint, stack, timestamp FROM error_logs ORDER BY timestamp DESC LIMIT $1",
          [Number(limit)]
        );
        return JSON.stringify(r.rows);
      } catch (e: any) { return `Error Log Error: ${e.message}`; }
    }
    case "query_workflow_logs": {
      try {
        const { logBus } = await import("../lib/log-bus");
        const { limit = 30 } = input;
        return JSON.stringify(logBus.recent(Number(limit)));
      } catch (e: any) { return `Workflow Log Error: ${e.message}`; }
    }
    case "get_platform_stats": {
      try {
        const [users, projects, tasks, revenue] = await Promise.all([
          pool.query("SELECT COUNT(*) as cnt FROM users"),
          pool.query("SELECT COUNT(*) as cnt FROM projects WHERE status='active'"),
          pool.query("SELECT COUNT(*) as cnt FROM tasks"),
          pool.query("SELECT SUM(azn_amount) as total FROM credit_transactions WHERE status='approved'"),
        ]);
        return JSON.stringify({
          total_users: users.rows[0].cnt,
          active_projects: projects.rows[0].cnt,
          total_tasks: tasks.rows[0].cnt,
          total_revenue_azn: revenue.rows[0].total ?? 0,
        });
      } catch (e: any) { return `Error: ${e.message}`; }
    }
    case "list_tables": {
      try {
        const r = await pool.query(`
          SELECT table_name, 
                 (SELECT COUNT(*) FROM information_schema.columns WHERE table_name=t.table_name) as col_count
          FROM information_schema.tables t
          WHERE table_schema='public' ORDER BY table_name
        `);
        return JSON.stringify(r.rows);
      } catch (e: any) { return `Error: ${e.message}`; }
    }
    case "list_files": {
      try {
        const dir = resolveSafePath(input.dir ?? ".");
        const entries = await fs.readdir(dir, { withFileTypes: true });
        return JSON.stringify(entries
          .filter(e => e.name !== "node_modules" && e.name !== ".git")
          .map(e => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })));
      } catch (e: any) { return `List Error: ${e.message}`; }
    }
    case "read_file": {
      try {
        const p = resolveSafePath(input.path);
        const content = await fs.readFile(p, "utf-8");
        return content.length > 8000 ? content.slice(0, 8000) + "\n...(truncated)" : content;
      } catch (e: any) { return `Read Error: ${e.message}`; }
    }
    case "write_file": {
      try {
        const rel = input.path;
        if (!rel || typeof input.content !== "string") return "Error: path and content are required";
        const p = resolveSafePath(rel);
        let original: string | null = null;
        let existed = true;
        try { original = await fs.readFile(p, "utf-8"); } catch { existed = false; }
        await pool.query(
          "INSERT INTO ai_agent_file_backups (session_id, file_path, original_content, existed) VALUES ($1, $2, $3, $4)",
          [sessionId, rel, original, existed]
        );
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, input.content, "utf-8");
        return `Wrote ${input.content.length} bytes to ${rel} (backup saved for rollback_file)`;
      } catch (e: any) { return `Write Error: ${e.message}`; }
    }
    case "rollback_file": {
      try {
        const rel = input.path;
        const r = await pool.query(
          "SELECT original_content, existed FROM ai_agent_file_backups WHERE session_id=$1 AND file_path=$2 ORDER BY created_at DESC LIMIT 1",
          [sessionId, rel]
        );
        if (!r.rows.length) return `No backup found for ${rel}`;
        const { original_content, existed } = r.rows[0];
        const p = resolveSafePath(rel);
        if (!existed) { await fs.unlink(p).catch(() => {}); return `Rolled back: removed newly created ${rel}`; }
        await fs.writeFile(p, original_content ?? "", "utf-8");
        return `Rolled back ${rel} to previous version`;
      } catch (e: any) { return `Rollback Error: ${e.message}`; }
    }
    case "run_typecheck": {
      try {
        const { stdout, stderr } = await execAsync("pnpm run typecheck", { timeout: 100000, cwd: REPO_ROOT, maxBuffer: 5 * 1024 * 1024 });
        return `TYPECHECK PASSED\n${(stdout || stderr).slice(-4000)}`;
      } catch (e: any) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
        return `TYPECHECK FAILED\n${out.slice(-4000)}`;
      }
    }
    case "git_commit": {
      try {
        const message = (input.message ?? "AI Agent: automated change").replace(/"/g, '\\"');
        await execAsync("git add -A", { cwd: REPO_ROOT, timeout: 15000 });
        const { stdout } = await execAsync(`git commit -m "${message}"`, { cwd: REPO_ROOT, timeout: 15000 });
        return `Committed: ${stdout.trim()}`;
      } catch (e: any) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
        if (/nothing to commit/i.test(out)) return "Nothing to commit — working tree clean.";
        return `Git Error: ${out}`;
      }
    }
    default:
      return `Unknown tool: ${toolName}`;
  }
}

const TOOL_DEFS: Record<string, any> = {
  execute_sql: {
    type: "function",
    function: {
      name: "execute_sql",
      description: "Execute a read SQL query on the AYZEN database. Destructive queries are blocked.",
      parameters: { type: "object", properties: { query: { type: "string", description: "SQL query to execute" } }, required: ["query"] },
    },
  },
  execute_shell: {
    type: "function",
    function: {
      name: "execute_shell",
      description: "Run a shell command in the server environment.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  query_logs: {
    type: "function",
    function: {
      name: "query_logs",
      description: "Query recent request metrics (performance/status logs).",
      parameters: { type: "object", properties: { level: { type: "string", enum: ["all", "error", "warn"] }, limit: { type: "number" } } },
    },
  },
  query_error_logs: {
    type: "function",
    function: {
      name: "query_error_logs",
      description: "Query the persistent error_logs table (stack traces, endpoints).",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
    },
  },
  query_workflow_logs: {
    type: "function",
    function: {
      name: "query_workflow_logs",
      description: "Read recent live workflow/console log-bus entries (server startup, migrations, system events).",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
    },
  },
  get_platform_stats: {
    type: "function",
    function: { name: "get_platform_stats", description: "Get current platform statistics: users, projects, tasks, revenue.", parameters: { type: "object", properties: {} } },
  },
  list_tables: {
    type: "function",
    function: { name: "list_tables", description: "List all database tables with column counts.", parameters: { type: "object", properties: {} } },
  },
  list_files: {
    type: "function",
    function: {
      name: "list_files",
      description: "List files and folders in a repository directory.",
      parameters: { type: "object", properties: { dir: { type: "string", description: "Relative path from repo root, e.g. 'artifacts/ayzen/src/pages'" } } },
    },
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a source file by its path relative to the repository root.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file with new content. Automatically backs up the previous version for rollback_file.",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
  },
  rollback_file: {
    type: "function",
    function: {
      name: "rollback_file",
      description: "Restore a file to the version it had before the most recent write_file call in this session.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  run_typecheck: {
    type: "function",
    function: { name: "run_typecheck", description: "Run the project-wide TypeScript typecheck and report pass/fail with errors.", parameters: { type: "object", properties: {} } },
  },
  git_commit: {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage and commit all current changes with a message. Use only after run_typecheck passes.",
      parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    },
  },
};
const AGENT_TOOLS = Object.values(TOOL_DEFS);

async function callLLM(routerName: string, model: string, systemPrompt: string, temperature: number, maxTokens: number, messages: any[], tools: any[]): Promise<{ content: string; toolCalls?: any[] }> {
  const groqKey = process.env["GROQ_API_KEY"];
  const openrouterKey = process.env["OPENROUTER_API_KEY"];

  let baseUrl = "https://api.groq.com/openai/v1";
  let apiKey = groqKey;
  if (routerName === "openrouter") { baseUrl = "https://openrouter.ai/api/v1"; apiKey = openrouterKey; }

  if (!apiKey) {
    return { content: `⚠️ No API key configured for ${routerName}. Please set ${routerName.toUpperCase()}_API_KEY in environment settings.` };
  }

  const body: any = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature,
    max_tokens: maxTokens,
  };
  if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { content: `API Error (${resp.status}): ${err}` };
  }

  const data = await resp.json() as any;
  const msg = data.choices?.[0]?.message;
  if (msg?.tool_calls?.length) return { content: msg.content ?? "", toolCalls: msg.tool_calls };
  return { content: msg?.content ?? "" };
}

function enabledToolList(toolsEnabled: Record<string, boolean>) {
  const map: Record<string, string[]> = {
    database: ["execute_sql", "list_tables", "get_platform_stats"],
    shell: ["execute_shell"],
    console: ["query_logs"],
    error_logs: ["query_error_logs"],
    workflow_logs: ["query_workflow_logs"],
    files: ["list_files", "read_file", "write_file", "rollback_file"],
    typecheck: ["run_typecheck"],
    git: ["git_commit"],
  };
  const names = new Set<string>();
  for (const [key, toolNames] of Object.entries(map)) {
    if (toolsEnabled[key]) toolNames.forEach(n => names.add(n));
  }
  return AGENT_TOOLS.filter((t: any) => names.has(t.function.name));
}

async function runAgentTurn(
  routerName: string, model: string, systemPrompt: string, temperature: number, maxTokens: number,
  messages: any[], enabledTools: any[], sessionId: string
) {
  const toolResults: any[] = [];
  let finalContent = "";
  let loops = 0;
  const working = [...messages];
  while (loops < 4) {
    loops++;
    const result = await callLLM(routerName, model, systemPrompt, temperature, maxTokens, working, enabledTools);
    if (result.toolCalls?.length) {
      working.push({ role: "assistant", content: result.content ?? "", tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        const fn = tc.function;
        let input: any = {};
        try { input = JSON.parse(fn.arguments ?? "{}"); } catch {}
        const toolOutput = await runTool(fn.name, input, sessionId);
        toolResults.push({ tool: fn.name, input, output: toolOutput });
        working.push({ role: "tool", tool_call_id: tc.id, content: toolOutput });
      }
      finalContent = result.content ?? "";
    } else {
      finalContent = result.content;
      break;
    }
  }
  return { finalContent, toolResults };
}

// ── 1. POST /admin/ai-agent/chat ──────────────────────────────────────────────
router.post("/admin/ai-agent/chat", requireDev, async (req, res): Promise<void> => {
  const { message, session_id = "default", history = [] } = req.body;
  if (!message) { res.status(400).json({ error: "message required" }); return; }
  try {
    const settingsR = await pool.query("SELECT * FROM ai_agent_settings WHERE id=1");
    const settings = settingsR.rows[0] ?? {};
    const toolsEnabled = JSON.parse(settings.tools_enabled ?? '{"shell":true,"database":true,"console":true}');
    const enabledTools = enabledToolList(toolsEnabled);
    const agentMode = settings.agent_mode ?? "single";

    await pool.query(
      "INSERT INTO ai_agent_messages (session_id, role, content) VALUES ($1, 'user', $2)",
      [session_id, message]
    );

    const allToolCalls: any[] = [];
    let finalContent = "";
    const pipelineNotes: string[] = [];

    if (agentMode === "cascade" || agentMode === "multi_agent") {
      const rosterR = await pool.query("SELECT * FROM ai_agents WHERE enabled=TRUE ORDER BY sort_order ASC");
      const roster = rosterR.rows;
      let handoff = `User request: ${message}`;
      for (const agent of roster) {
        const agentMessages = [...history, { role: "user", content: handoff }];
        const { finalContent: agentOutput, toolResults } = await runAgentTurn(
          agent.router, agent.model, agent.system_prompt, settings.temperature ?? 0.7, settings.max_tokens ?? 4096,
          agentMessages, enabledTools, session_id
        );
        toolResults.forEach(t => allToolCalls.push({ ...t, agent: agent.name }));
        pipelineNotes.push(`### ${agent.name} (${agent.role})\n${agentOutput}`);
        handoff = `Previous request: ${message}\n\n${agent.name}'s output:\n${agentOutput}\n\nContinue the pipeline based on this.`;
        await pool.query(
          `INSERT INTO ai_agent_messages (session_id, role, content, tool_name, tool_input, tool_output, agent_name)
           VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
          [session_id, agentOutput,
           toolResults.length ? toolResults.map(t => t.tool).join(",") : null,
           toolResults.length ? JSON.stringify(toolResults.map(t => t.input)) : null,
           toolResults.length ? JSON.stringify(toolResults.map(t => t.output)) : null,
           agent.name]
        );
      }
      finalContent = pipelineNotes.join("\n\n---\n\n");
    } else {
      const messages = [...history, { role: "user", content: message }];
      const systemPrompt = settings.system_prompt ?? "You are AYZEN AI Agent, an autonomous assistant for the AYZEN platform developer.";
      const { finalContent: out, toolResults } = await runAgentTurn(
        settings.router ?? "groq", settings.model ?? "llama-3.3-70b-versatile", systemPrompt,
        settings.temperature ?? 0.7, settings.max_tokens ?? 4096, messages, enabledTools, session_id
      );
      finalContent = out;
      toolResults.forEach(t => allToolCalls.push(t));
      await pool.query(
        `INSERT INTO ai_agent_messages (session_id, role, content, tool_name, tool_input, tool_output)
         VALUES ($1, 'assistant', $2, $3, $4, $5)`,
        [session_id, finalContent,
         allToolCalls.length ? allToolCalls.map(t => t.tool).join(",") : null,
         allToolCalls.length ? JSON.stringify(allToolCalls.map(t => t.input)) : null,
         allToolCalls.length ? JSON.stringify(allToolCalls.map(t => t.output)) : null]
      );
    }

    res.json({ content: finalContent, tool_calls: allToolCalls, session_id, agent_mode: agentMode });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 2. GET /admin/ai-agent/settings ──────────────────────────────────────────
router.get("/admin/ai-agent/settings", requireDev, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM ai_agent_settings WHERE id=1");
    const s = r.rows[0] ?? {};
    res.json({
      router: s.router ?? "groq",
      model: s.model ?? "llama-3.3-70b-versatile",
      system_prompt: s.system_prompt ?? "",
      temperature: s.temperature ?? 0.7,
      max_tokens: s.max_tokens ?? 4096,
      context_window: s.context_window ?? 32000,
      agent_mode: s.agent_mode ?? "single",
      tools_enabled: JSON.parse(s.tools_enabled ?? '{"shell":true,"database":true,"console":true}'),
      workflow: JSON.parse(s.workflow ?? "{}"),
      updated_at: s.updated_at,
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 3. PUT /admin/ai-agent/settings ──────────────────────────────────────────
router.put("/admin/ai-agent/settings", requireDev, async (req, res): Promise<void> => {
  const { router: r, model, system_prompt, temperature, max_tokens, tools_enabled, workflow, agent_mode, context_window } = req.body;
  try {
    await pool.query(`
      UPDATE ai_agent_settings SET
        router = COALESCE($1, router),
        model = COALESCE($2, model),
        system_prompt = COALESCE($3, system_prompt),
        temperature = COALESCE($4, temperature),
        max_tokens = COALESCE($5, max_tokens),
        tools_enabled = COALESCE($6, tools_enabled),
        workflow = COALESCE($7, workflow),
        agent_mode = COALESCE($8, agent_mode),
        context_window = COALESCE($9, context_window),
        updated_at = NOW()
      WHERE id = 1
    `, [r ?? null, model ?? null, system_prompt ?? null,
        temperature ?? null, max_tokens ?? null,
        tools_enabled ? JSON.stringify(tools_enabled) : null,
        workflow ? JSON.stringify(workflow) : null,
        agent_mode ?? null, context_window ?? null]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 4. GET /admin/ai-agent/models (legacy hardcoded catalogues) ─────────────
router.get("/admin/ai-agent/models", requireDev, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM ai_model_catalog WHERE enabled=TRUE ORDER BY provider, id");
    const grouped: Record<string, any[]> = { groq: [], openrouter: [] };
    for (const row of r.rows) {
      (grouped[row.provider] ??= []).push({ id: row.model_id, label: row.label, provider: row.provider, ctx: row.ctx, dbId: row.id, is_custom: row.is_custom });
    }
    res.json(grouped);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 4b. Model catalog CRUD ────────────────────────────────────────────────────
router.get("/admin/ai-agent/model-catalog", requireDev, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM ai_model_catalog ORDER BY provider, id");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/ai-agent/model-catalog", requireDev, async (req, res): Promise<void> => {
  const { provider, model_id, label, ctx } = req.body;
  if (!provider || !model_id || !label) { res.status(400).json({ error: "provider, model_id, label required" }); return; }
  try {
    const r = await pool.query(
      "INSERT INTO ai_model_catalog (provider, model_id, label, ctx, is_custom) VALUES ($1,$2,$3,$4,TRUE) RETURNING *",
      [provider, model_id, label, ctx ?? 32000]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/admin/ai-agent/model-catalog/:id", requireDev, async (req, res): Promise<void> => {
  const id = Number(req.body.id ?? req.params.id);
  const { label, ctx, enabled } = req.body;
  try {
    const r = await pool.query(
      `UPDATE ai_model_catalog SET label=COALESCE($1,label), ctx=COALESCE($2,ctx), enabled=COALESCE($3,enabled) WHERE id=$4 RETURNING *`,
      [label ?? null, ctx ?? null, enabled ?? null, id]
    );
    if (!r.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/ai-agent/model-catalog/:id", requireDev, async (req, res): Promise<void> => {
  try {
    await pool.query("DELETE FROM ai_model_catalog WHERE id=$1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 5. GET /admin/ai-agent/history ───────────────────────────────────────────
router.get("/admin/ai-agent/history", requireDev, async (req, res): Promise<void> => {
  const { session_id = "default", limit = 100 } = req.query as any;
  try {
    const r = await pool.query(
      `SELECT id, role, content, tool_name, tool_output, tokens_used, agent_name, created_at
       FROM ai_agent_messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT $2`,
      [session_id, Number(limit)]
    );
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 6. DELETE /admin/ai-agent/history ────────────────────────────────────────
router.delete("/admin/ai-agent/history", requireDev, async (req, res): Promise<void> => {
  const { session_id = "default" } = req.query as any;
  try {
    await pool.query("DELETE FROM ai_agent_messages WHERE session_id=$1", [session_id]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── 7. Agent roster CRUD (multi-agent pipeline members) ───────────────────────
router.get("/admin/ai-agent/agents", requireDev, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM ai_agents ORDER BY sort_order ASC");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/ai-agent/agents", requireDev, async (req, res): Promise<void> => {
  const { name, role, description, router: routerName, model, system_prompt, sort_order } = req.body;
  if (!name || !role) { res.status(400).json({ error: "name and role required" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO ai_agents (name, role, description, router, model, system_prompt, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, role, description ?? "", routerName ?? "groq", model ?? "llama-3.3-70b-versatile", system_prompt ?? "", sort_order ?? 99]
    );
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch("/admin/ai-agent/agents/:id", requireDev, async (req, res): Promise<void> => {
  const { name, role, description, router: routerName, model, system_prompt, enabled, sort_order } = req.body;
  try {
    const r = await pool.query(
      `UPDATE ai_agents SET
        name=COALESCE($1,name), role=COALESCE($2,role), description=COALESCE($3,description),
        router=COALESCE($4,router), model=COALESCE($5,model), system_prompt=COALESCE($6,system_prompt),
        enabled=COALESCE($7,enabled), sort_order=COALESCE($8,sort_order), updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [name ?? null, role ?? null, description ?? null, routerName ?? null, model ?? null,
       system_prompt ?? null, enabled ?? null, sort_order ?? null, Number(req.params.id)]
    );
    if (!r.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/ai-agent/agents/:id", requireDev, async (req, res): Promise<void> => {
  try {
    await pool.query("DELETE FROM ai_agents WHERE id=$1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
