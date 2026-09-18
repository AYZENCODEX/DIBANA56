import { Router, Request, Response } from "express";
import { getUserFromToken } from "../lib/auth-utils";

const router = Router();

interface SSEClient {
  id: string;
  userId: number;
  res: Response;
  connectedAt: number;
  projectId?: number;
}

const clients: SSEClient[] = [];

// ─── Presence: projectId → Set of userIds ─────────────────────────────────────
const projectPresence = new Map<number, Set<number>>();

// ─── Token resolver: reads from Authorization header OR ?token= query param ───
// EventSource API cannot send custom headers, so we must support query param auth.
// Both paths go through the same verified getUserFromToken() — no unsigned
// base64 payload is ever trusted, and there is no silent fallback to userId 1.
async function getUserIdFromReq(req: Request): Promise<number | null> {
  const authHeader = req.headers.authorization;
  const headerToken = authHeader ? authHeader.replace("Bearer ", "").trim() : null;
  const queryToken = req.query.token ? decodeURIComponent(req.query.token as string) : null;
  const token = headerToken || queryToken;
  if (!token) return null;

  const user = await getUserFromToken(token);
  return user ? user.userId : null;
}

// ─── Flush-aware write — critical for Replit deployment proxy ─────────────────
function sseWrite(res: Response, event: string, data: Record<string, unknown>): boolean {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Force flush through Nginx / Replit's mTLS proxy — without this, events
    // are buffered and only delivered in bursts or after connection closes
    if (typeof (res as any).flush === "function") (res as any).flush();
    return true;
  } catch {
    return false;
  }
}

function sseHeartbeat(res: Response): boolean {
  try {
    res.write(`: heartbeat\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
    return true;
  } catch {
    return false;
  }
}

// ─── Broadcast helpers ────────────────────────────────────────────────────────
export function broadcastEvent(event: string, data: Record<string, unknown> = {}) {
  const payload = { ...data, ts: Date.now() };
  for (let i = clients.length - 1; i >= 0; i--) {
    if (!sseWrite(clients[i].res, event, payload)) clients.splice(i, 1);
  }
}

export function broadcastToProject(projectId: number, event: string, data: Record<string, unknown> = {}) {
  const payload = { ...data, projectId, ts: Date.now() };
  for (let i = clients.length - 1; i >= 0; i--) {
    if (clients[i].projectId !== projectId) continue;
    if (!sseWrite(clients[i].res, event, payload)) clients.splice(i, 1);
  }
}

export function broadcastToUser(userId: number, event: string, data: Record<string, unknown> = {}) {
  const payload = { ...data, ts: Date.now() };
  for (let i = clients.length - 1; i >= 0; i--) {
    if (clients[i].userId !== userId) continue;
    if (!sseWrite(clients[i].res, event, payload)) clients.splice(i, 1);
  }
}

export function getActiveConnectionCount() { return clients.length; }
export function getProjectPresence(projectId: number) { return [...(projectPresence.get(projectId) ?? [])]; }
export function getAllProjectPresence() {
  const result: Record<number, number> = {};
  projectPresence.forEach((users, pid) => { result[pid] = users.size; });
  return result;
}

// ─── SSE endpoint ─────────────────────────────────────────────────────────────
router.get("/events", async (req: Request, res: Response) => {
  const userId = await getUserIdFromReq(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const projectId = req.query.projectId ? Number(req.query.projectId) : undefined;

  // Headers that make SSE work through proxies and Replit's deployment layer
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");   // Nginx: don't buffer
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders(); // Immediately send headers (starts the stream)

  const clientId = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const client: SSEClient = { id: clientId, userId, res, connectedAt: Date.now(), projectId };
  clients.push(client);

  // Join project presence room
  if (projectId) {
    if (!projectPresence.has(projectId)) projectPresence.set(projectId, new Set());
    projectPresence.get(projectId)!.add(userId);
    broadcastToProject(projectId, "presence_updated", {
      projectId, online: getProjectPresence(projectId),
    });
  }

  // Send initial connection confirmation
  sseWrite(res, "connected", {
    clientId, userId, projectId: projectId ?? null, connections: clients.length,
  });

  // Heartbeat every 15s — keeps the TCP connection alive through proxies
  // (Replit's deployment proxy has ~30s idle timeout, so 15s gives a safe margin)
  const heartbeat = setInterval(() => {
    if (!sseHeartbeat(res)) clearInterval(heartbeat);
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const idx = clients.findIndex(c => c.id === clientId);
    if (idx !== -1) clients.splice(idx, 1);

    if (projectId) {
      projectPresence.get(projectId)?.delete(userId);
      if ((projectPresence.get(projectId)?.size ?? 0) === 0) {
        projectPresence.delete(projectId);
      } else {
        broadcastToProject(projectId, "presence_updated", {
          projectId, online: getProjectPresence(projectId),
        });
      }
    }
  });
});

// ─── Project presence REST endpoint ──────────────────────────────────────────
// D5 (Season D, decision-gated per D4's flag): this had no auth at all —
// any anonymous caller could enumerate projectId and read the raw list of
// userIds currently viewing a project. Login-gate only (matches the SSE
// endpoint above, which already requires a verified token) — no per-user
// ownership needed since this is presence data, not a resource read.
router.get("/projects/:id/presence", async (req: Request, res: Response) => {
  const userId = await getUserIdFromReq(req);
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }
  const id = Number(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  res.json({ projectId: id, online: getProjectPresence(id), count: getProjectPresence(id).length });
});

export default router;
