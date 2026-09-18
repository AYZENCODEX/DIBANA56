import { Router } from "express";
import { exec } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { requireAdmin } from "../middlewares/auth";
import { logActivity } from "../lib/activity";
import { logBus } from "../lib/log-bus";

const router = Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// bundled dist/index.mjs lives at artifacts/api-server/dist — go up 3 to reach workspace root
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const MAX_OUTPUT = 60_000;
const TIMEOUT_MS = 20_000;

router.post("/admin/shell/exec", requireAdmin, (req, res): void => {
  const command = String(req.body?.command ?? "").trim();
  if (!command) { res.status(400).json({ error: "command is required" }); return; }
  if (command.length > 2000) { res.status(400).json({ error: "command too long" }); return; }

  const startedAt = Date.now();
  const child = exec(command, {
    cwd: PROJECT_ROOT,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    env: process.env,
    shell: "/bin/bash",
  }, (error, stdout, stderr) => {
    const durationMs = Date.now() - startedAt;
    const truncatedOut = stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) + "\n…[truncated]" : stdout;
    const truncatedErr = stderr.length > MAX_OUTPUT ? stderr.slice(0, MAX_OUTPUT) + "\n…[truncated]" : stderr;

    const userId = req.user?.userId ?? 0;
    logActivity(userId, "shell_exec", "shell", null, command.slice(0, 120), {
      exitCode: (error as any)?.code ?? 0,
      durationMs,
      timedOut: (error as any)?.killed && (error as any)?.signal === "SIGTERM",
    }).catch(() => {});

    logBus.push({
      time: Date.now(),
      level: error ? "ERROR" : "INFO",
      msg: `[shell] ${command}`,
      method: "SHELL",
      url: "/admin/shell/exec",
      statusCode: error ? 1 : 0,
      ms: durationMs,
    } as any);

    res.json({
      command,
      exitCode: (error as any)?.code ?? 0,
      stdout: truncatedOut,
      stderr: truncatedErr,
      error: error && !((error as any).code) ? error.message : null,
      timedOut: !!((error as any)?.killed && (error as any)?.signal === "SIGTERM"),
      durationMs,
      cwd: PROJECT_ROOT,
    });
  });

  req.on("close", () => {
    if (!child.killed) child.kill();
  });
});

export default router;
