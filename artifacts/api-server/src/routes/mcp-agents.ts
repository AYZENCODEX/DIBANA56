import { Router } from "express";
import { pool } from "@workspace/db";
import { requireRoles } from "../middlewares/auth";
import { getAgentType, getEnabledSkills, runAgentType } from "../mcp/runtime";
import { NATIVE_SKILL_DEFS } from "../mcp/skills";

const router = Router();
const requireDev = requireRoles("dev");

// ─────────────────────────────────────────────────────────────────────────────
// Agent types (Local / Builder / Database / Execute / Blueprint / custom)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/mcp-agents/types", requireDev, async (_req, res): Promise<void> => {
  try {
    const types = await pool.query("SELECT * FROM mcp_agent_types ORDER BY sort_order, id");
    const skillCounts = await pool.query(
      "SELECT agent_type_key, COUNT(*)::int AS total, SUM(CASE WHEN enabled THEN 1 ELSE 0 END)::int AS enabled FROM mcp_skills GROUP BY agent_type_key"
    );
    const countsByType = new Map(skillCounts.rows.map((r: any) => [r.agent_type_key, r]));
    res.json(types.rows.map(t => ({ ...t, skill_count: countsByType.get(t.key)?.total ?? 0, skill_enabled_count: countsByType.get(t.key)?.enabled ?? 0 })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/mcp-agents/types", requireDev, async (req, res): Promise<void> => {
  const { key, label, icon, description, provider_key, model, system_prompt } = req.body;
  if (!key || !label) { res.status(400).json({ error: "key and label are required" }); return; }
  if (!/^[a-z0-9_-]+$/.test(key)) { res.status(400).json({ error: "key must be lowercase letters, numbers, _ or -" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO mcp_agent_types (key, label, icon, description, provider_key, model, system_prompt, is_custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING *`,
      [key, label, icon ?? "Bot", description ?? "", provider_key ?? "groq", model ?? "llama-3.3-70b-versatile", system_prompt ?? ""]
    );
    res.json(r.rows[0]);
  } catch (e: any) {
    if (e.code === "23505") { res.status(409).json({ error: `Agent type "${key}" already exists` }); return; }
    res.status(500).json({ error: e.message });
  }
});

router.patch("/admin/mcp-agents/types/:id", requireDev, async (req, res): Promise<void> => {
  const { label, icon, description, provider_key, model, system_prompt, enabled, sort_order } = req.body;
  try {
    const r = await pool.query(
      `UPDATE mcp_agent_types SET
        label=COALESCE($1,label), icon=COALESCE($2,icon), description=COALESCE($3,description),
        provider_key=COALESCE($4,provider_key), model=COALESCE($5,model), system_prompt=COALESCE($6,system_prompt),
        enabled=COALESCE($7,enabled), sort_order=COALESCE($8,sort_order), updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [label ?? null, icon ?? null, description ?? null, provider_key ?? null, model ?? null,
       system_prompt ?? null, enabled ?? null, sort_order ?? null, Number(req.params.id)]
    );
    if (!r.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/mcp-agents/types/:id", requireDev, async (req, res): Promise<void> => {
  try {
    const existing = await pool.query("SELECT is_custom FROM mcp_agent_types WHERE id=$1", [Number(req.params.id)]);
    if (!existing.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    if (!existing.rows[0].is_custom) { res.status(400).json({ error: "Built-in agent types can be disabled, not deleted" }); return; }
    await pool.query("DELETE FROM mcp_agent_types WHERE id=$1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Skills (per agent type) — addable/removable, native or webhook-backed
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/mcp-agents/skills", requireDev, async (req, res): Promise<void> => {
  const { agent_type_key } = req.query as { agent_type_key?: string };
  try {
    const r = agent_type_key
      ? await pool.query("SELECT * FROM mcp_skills WHERE agent_type_key=$1 ORDER BY sort_order, id", [agent_type_key])
      : await pool.query("SELECT * FROM mcp_skills ORDER BY agent_type_key, sort_order, id");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Native skill implementations available to attach to any agent type.
router.get("/admin/mcp-agents/skill-handlers", requireDev, async (_req, res): Promise<void> => {
  res.json(Object.keys(NATIVE_SKILL_DEFS).map(key => ({ key, ...NATIVE_SKILL_DEFS[key] })));
});

router.post("/admin/mcp-agents/skills", requireDev, async (req, res): Promise<void> => {
  const { key, agent_type_key, label, description, icon, handler_kind, handler_config } = req.body;
  if (!key || !agent_type_key || !label) { res.status(400).json({ error: "key, agent_type_key and label are required" }); return; }
  if (handler_kind === "http_webhook" && !JSON.parse(handler_config || "{}")?.url) {
    res.status(400).json({ error: "handler_config.url is required for http_webhook skills" }); return;
  }
  try {
    const r = await pool.query(
      `INSERT INTO mcp_skills (key, agent_type_key, label, description, icon, handler_kind, handler_config, is_custom)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING *`,
      [key, agent_type_key, label, description ?? "", icon ?? "Puzzle", handler_kind ?? "http_webhook", handler_config ?? "{}"]
    );
    res.json(r.rows[0]);
  } catch (e: any) {
    if (e.code === "23505") { res.status(409).json({ error: `Skill "${key}" already exists for this agent type` }); return; }
    res.status(500).json({ error: e.message });
  }
});

router.patch("/admin/mcp-agents/skills/:id", requireDev, async (req, res): Promise<void> => {
  const { label, description, icon, handler_config, enabled, sort_order } = req.body;
  try {
    const r = await pool.query(
      `UPDATE mcp_skills SET
        label=COALESCE($1,label), description=COALESCE($2,description), icon=COALESCE($3,icon),
        handler_config=COALESCE($4,handler_config), enabled=COALESCE($5,enabled), sort_order=COALESCE($6,sort_order),
        updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [label ?? null, description ?? null, icon ?? null, handler_config ?? null, enabled ?? null, sort_order ?? null, Number(req.params.id)]
    );
    if (!r.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/mcp-agents/skills/:id", requireDev, async (req, res): Promise<void> => {
  try {
    const existing = await pool.query("SELECT is_custom FROM mcp_skills WHERE id=$1", [Number(req.params.id)]);
    if (!existing.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    if (!existing.rows[0].is_custom) { res.status(400).json({ error: "Built-in skills can be disabled, not deleted" }); return; }
    await pool.query("DELETE FROM mcp_skills WHERE id=$1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Providers ("router") — groq/openrouter + any OpenAI-compatible custom
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/mcp-agents/providers", requireDev, async (_req, res): Promise<void> => {
  try {
    const r = await pool.query("SELECT * FROM ai_providers ORDER BY sort_order, id");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/admin/mcp-agents/providers", requireDev, async (req, res): Promise<void> => {
  const { key, label, base_url, api_key_env } = req.body;
  if (!key || !label || !base_url || !api_key_env) { res.status(400).json({ error: "key, label, base_url, api_key_env are required" }); return; }
  try {
    const r = await pool.query(
      `INSERT INTO ai_providers (key, label, base_url, api_key_env, is_custom) VALUES ($1,$2,$3,$4,TRUE) RETURNING *`,
      [key, label, base_url, api_key_env]
    );
    res.json(r.rows[0]);
  } catch (e: any) {
    if (e.code === "23505") { res.status(409).json({ error: `Provider "${key}" already exists` }); return; }
    res.status(500).json({ error: e.message });
  }
});

router.patch("/admin/mcp-agents/providers/:id", requireDev, async (req, res): Promise<void> => {
  const { label, base_url, api_key_env, enabled, sort_order } = req.body;
  try {
    const r = await pool.query(
      `UPDATE ai_providers SET
        label=COALESCE($1,label), base_url=COALESCE($2,base_url), api_key_env=COALESCE($3,api_key_env),
        enabled=COALESCE($4,enabled), sort_order=COALESCE($5,sort_order), updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [label ?? null, base_url ?? null, api_key_env ?? null, enabled ?? null, sort_order ?? null, Number(req.params.id)]
    );
    if (!r.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    res.json(r.rows[0]);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/mcp-agents/providers/:id", requireDev, async (req, res): Promise<void> => {
  try {
    const existing = await pool.query("SELECT is_custom FROM ai_providers WHERE id=$1", [Number(req.params.id)]);
    if (!existing.rows.length) { res.status(404).json({ error: "Not found" }); return; }
    if (!existing.rows[0].is_custom) { res.status(400).json({ error: "Built-in providers can be disabled, not deleted" }); return; }
    await pool.query("DELETE FROM ai_providers WHERE id=$1", [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Run / chat with a single modular agent type
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/mcp-agents/run", requireDev, async (req, res): Promise<void> => {
  const { agent_type, message, session_id = "default", history = [] } = req.body;
  if (!agent_type || !message) { res.status(400).json({ error: "agent_type and message are required" }); return; }
  try {
    const type = await getAgentType(agent_type);
    if (!type) { res.status(404).json({ error: `Unknown agent type: ${agent_type}` }); return; }
    if (!type.enabled) { res.status(400).json({ error: `Agent type "${type.label}" is disabled` }); return; }

    await pool.query(
      "INSERT INTO mcp_agent_messages (session_id, agent_type_key, role, content) VALUES ($1,$2,'user',$3)",
      [session_id, agent_type, message]
    );

    const { content, toolCalls } = await runAgentType(type, message, history, session_id);

    await pool.query(
      `INSERT INTO mcp_agent_messages (session_id, agent_type_key, role, content, tool_name, tool_input, tool_output)
       VALUES ($1,$2,'assistant',$3,$4,$5,$6)`,
      [session_id, agent_type, content,
       toolCalls.length ? toolCalls.map(t => t.tool).join(",") : null,
       toolCalls.length ? JSON.stringify(toolCalls.map(t => t.input)) : null,
       toolCalls.length ? JSON.stringify(toolCalls.map(t => t.output)) : null]
    );

    res.json({ content, tool_calls: toolCalls, session_id, agent_type });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/admin/mcp-agents/history", requireDev, async (req, res): Promise<void> => {
  const { session_id = "default", agent_type, limit = 100 } = req.query as any;
  try {
    const r = agent_type
      ? await pool.query(
          "SELECT * FROM mcp_agent_messages WHERE session_id=$1 AND agent_type_key=$2 ORDER BY created_at ASC LIMIT $3",
          [session_id, agent_type, Number(limit)])
      : await pool.query(
          "SELECT * FROM mcp_agent_messages WHERE session_id=$1 ORDER BY created_at ASC LIMIT $2",
          [session_id, Number(limit)]);
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.delete("/admin/mcp-agents/history", requireDev, async (req, res): Promise<void> => {
  const { session_id = "default" } = req.query as any;
  try {
    await pool.query("DELETE FROM mcp_agent_messages WHERE session_id=$1", [session_id]);
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Blueprints drafted by the Blueprint agent
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/mcp-agents/blueprints", requireDev, async (req, res): Promise<void> => {
  const { session_id } = req.query as any;
  try {
    const r = session_id
      ? await pool.query("SELECT * FROM mcp_blueprints WHERE session_id=$1 ORDER BY created_at DESC", [session_id])
      : await pool.query("SELECT * FROM mcp_blueprints ORDER BY created_at DESC LIMIT 100");
    res.json(r.rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Convenience: preview which skills a given agent type currently has enabled.
router.get("/admin/mcp-agents/types/:key/skills", requireDev, async (req, res): Promise<void> => {
  try {
    const skills = await getEnabledSkills(String(req.params.key));
    res.json(skills);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
