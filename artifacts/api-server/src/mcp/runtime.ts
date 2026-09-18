import { pool } from "@workspace/db";
import { getProvider, resolveApiKey } from "./providers";
import { runSkill, toToolDefs, type SkillRow } from "./skills";

export interface AgentTypeRow {
  id: number;
  key: string;
  label: string;
  icon: string;
  description: string;
  provider_key: string;
  model: string;
  system_prompt: string;
  is_custom: boolean;
  enabled: boolean;
  sort_order: number;
}

export async function getAgentType(key: string): Promise<AgentTypeRow | null> {
  const r = await pool.query("SELECT * FROM mcp_agent_types WHERE key=$1", [key]);
  return r.rows[0] ?? null;
}

export async function getEnabledSkills(agentTypeKey: string): Promise<SkillRow[]> {
  const r = await pool.query(
    "SELECT * FROM mcp_skills WHERE agent_type_key=$1 AND enabled=TRUE ORDER BY sort_order",
    [agentTypeKey]
  );
  return r.rows;
}

async function callLLM(
  providerKey: string, model: string, systemPrompt: string,
  messages: any[], tools: any[], temperature = 0.7, maxTokens = 4096
): Promise<{ content: string; toolCalls?: any[] }> {
  const provider = await getProvider(providerKey);
  if (!provider || !provider.enabled) {
    return { content: `⚠️ Unknown or disabled router: ${providerKey}. Check Providers in MCP Agents settings.` };
  }
  const apiKey = await resolveApiKey(provider);
  if (!apiKey) {
    return { content: `⚠️ No API key configured for ${provider.label}. Add one in Key Manager or set ${provider.api_key_env}.` };
  }

  const body: any = {
    model,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature,
    max_tokens: maxTokens,
  };
  if (tools.length > 0) { body.tools = tools; body.tool_choice = "auto"; }

  const resp = await fetch(`${provider.base_url}/chat/completions`, {
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

// Runs one agent type through up to 4 tool-use loops, exactly like the
// existing single/cascade AI Agent runner but sourced entirely from DB config
// (provider, model, system prompt, skill set) instead of hardcoded values.
export async function runAgentType(
  agentType: AgentTypeRow, message: string, history: any[], sessionId: string
): Promise<{ content: string; toolCalls: { tool: string; input: any; output: string }[] }> {
  const skills = await getEnabledSkills(agentType.key);
  const skillByKey = new Map(skills.map(s => [s.key, s]));
  const tools = toToolDefs(skills);

  const working = [...history, { role: "user", content: message }];
  const toolCalls: { tool: string; input: any; output: string }[] = [];
  let finalContent = "";
  let loops = 0;

  while (loops < 4) {
    loops++;
    const result = await callLLM(agentType.provider_key, agentType.model, agentType.system_prompt, working, tools);
    if (result.toolCalls?.length) {
      working.push({ role: "assistant", content: result.content ?? "", tool_calls: result.toolCalls });
      for (const tc of result.toolCalls) {
        const fn = tc.function;
        let input: any = {};
        try { input = JSON.parse(fn.arguments ?? "{}"); } catch { /* ignore malformed args */ }
        const skill = skillByKey.get(fn.name);
        const output = skill ? await runSkill(skill, input, sessionId) : `Error: skill "${fn.name}" is not enabled for ${agentType.label}`;
        toolCalls.push({ tool: fn.name, input, output });
        working.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
      finalContent = result.content ?? "";
    } else {
      finalContent = result.content;
      break;
    }
  }
  return { content: finalContent, toolCalls };
}
