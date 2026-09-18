import { pool } from "@workspace/db";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execAsync = promisify(exec);
const REPO_ROOT = path.resolve(process.cwd(), "../../");

function resolveSafePath(rel: string): string {
  const target = path.resolve(REPO_ROOT, rel);
  if (!target.startsWith(REPO_ROOT)) throw new Error("Path escapes repository root");
  if (/node_modules|\.git\//.test(rel)) throw new Error("Path is blocked");
  return target;
}

export interface SkillRow {
  id: number;
  key: string;
  agent_type_key: string;
  label: string;
  description: string;
  icon: string;
  handler_kind: "native" | "http_webhook";
  handler_config: string; // JSON — for http_webhook: { url, method? }
  is_custom: boolean;
  enabled: boolean;
  sort_order: number;
}

// Every native skill declares its own OpenAI-style function schema so a
// mcp_skills row is the single source of truth for what the model can call.
export const NATIVE_SKILL_DEFS: Record<string, any> = {
  list_files: {
    description: "List files and folders in a repository directory.",
    parameters: { type: "object", properties: { dir: { type: "string", description: "Relative path from repo root" } } },
  },
  read_file: {
    description: "Read the contents of a source file by its path relative to the repository root.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  write_file: {
    description: "Create or overwrite a file with new content. Automatically backs up the previous version.",
    parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  },
  rollback_file: {
    description: "Restore a file to the version it had before the most recent write_file call in this session.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  run_typecheck: {
    description: "Run the project-wide TypeScript typecheck and report pass/fail with errors.",
    parameters: { type: "object", properties: {} },
  },
  git_commit: {
    description: "Stage and commit all current changes with a message. Use only after run_typecheck passes.",
    parameters: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  execute_sql: {
    description: "Execute a read SQL query on the AYZEN database. Destructive queries are blocked.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  list_tables: {
    description: "List all database tables with column counts.",
    parameters: { type: "object", properties: {} },
  },
  get_platform_stats: {
    description: "Get current platform statistics: users, projects, tasks, revenue.",
    parameters: { type: "object", properties: {} },
  },
  execute_shell: {
    description: "Run a shell command in the server environment.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  query_logs: {
    description: "Query recent request metrics (performance/status logs).",
    parameters: { type: "object", properties: { level: { type: "string", enum: ["all", "error", "warn"] }, limit: { type: "number" } } },
  },
  query_error_logs: {
    description: "Query the persistent error_logs table (stack traces, endpoints).",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
  },
  query_workflow_logs: {
    description: "Read recent live workflow/console log-bus entries.",
    parameters: { type: "object", properties: { limit: { type: "number" } } },
  },
  draft_blueprint: {
    description: "Persist a structured implementation blueprint (goal, files, steps) for later hand-off to the Builder agent.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        goal: { type: "string" },
        affected_files: { type: "array", items: { type: "string" } },
        steps: { type: "array", items: { type: "string" } },
      },
      required: ["title", "goal", "steps"],
    },
  },
};

async function runNativeSkill(key: string, input: Record<string, any>, sessionId: string): Promise<string> {
  switch (key) {
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
        const message = (input.message ?? "MCP Agent: automated change").replace(/"/g, '\\"');
        await execAsync("git add -A", { cwd: REPO_ROOT, timeout: 15000 });
        const { stdout } = await execAsync(`git commit -m "${message}"`, { cwd: REPO_ROOT, timeout: 15000 });
        return `Committed: ${stdout.trim()}`;
      } catch (e: any) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
        if (/nothing to commit/i.test(out)) return "Nothing to commit — working tree clean.";
        return `Git Error: ${out}`;
      }
    }
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
    case "draft_blueprint": {
      try {
        const { title, goal, affected_files = [], steps = [] } = input;
        if (!title || !goal || !steps?.length) return "Error: title, goal, and steps are required";
        const r = await pool.query(
          `INSERT INTO mcp_blueprints (session_id, title, goal, affected_files, steps)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [sessionId, title, goal, JSON.stringify(affected_files), JSON.stringify(steps)]
        );
        return `Blueprint #${r.rows[0].id} saved: "${title}" (${steps.length} steps, ${affected_files.length} files)`;
      } catch (e: any) { return `Blueprint Error: ${e.message}`; }
    }
    default:
      return `Unknown native skill: ${key}`;
  }
}

async function runWebhookSkill(skill: SkillRow, input: Record<string, any>): Promise<string> {
  try {
    const cfg = JSON.parse(skill.handler_config || "{}");
    if (!cfg.url) return `Error: skill "${skill.key}" has no webhook url configured`;
    const resp = await fetch(cfg.url, {
      method: cfg.method ?? "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill: skill.key, input }),
    });
    const text = await resp.text();
    return text.length > 8000 ? text.slice(0, 8000) + "\n...(truncated)" : text;
  } catch (e: any) { return `Webhook Error: ${e.message}`; }
}

export async function runSkill(skill: SkillRow, input: Record<string, any>, sessionId: string): Promise<string> {
  if (skill.handler_kind === "http_webhook") return runWebhookSkill(skill, input);
  return runNativeSkill(skill.key, input, sessionId);
}

// Builds OpenAI-style tool defs for a list of enabled skills. Native skills
// use their canned schema; webhook skills get a generic free-form schema.
export function toToolDefs(skillRows: SkillRow[]): any[] {
  return skillRows.map(s => {
    const nativeDef = NATIVE_SKILL_DEFS[s.key];
    return {
      type: "function",
      function: {
        name: s.key,
        description: s.description || nativeDef?.description || s.label,
        parameters: nativeDef?.parameters ?? { type: "object", properties: { input: { type: "object" } } },
      },
    };
  });
}
