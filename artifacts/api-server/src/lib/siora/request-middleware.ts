import type { Request, Response, NextFunction } from "express";
import { sioraRuntime } from "./index";
import { getCurrentTraceContext } from "../trace-context";
import { getSharedAppForHost } from "../shared-apps";

export function sioraRequestTelemetry(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/api/") || req.path.startsWith("/api/siora")) return;
    sioraRuntime.dispatch({
      kind: "request",
      name: `${req.method.toLowerCase()}.${req.path.replaceAll("/", ".").replace(/^\./, "")}`,
      context: {
        actor: req.user ? { userId: req.user.userId, role: req.user.role, authType: req.user.authType } : undefined,
        request: {
          method: req.method,
          path: req.path,
          endpoint: req.route?.path?.toString(),
          ip: req.ip,
          userAgent: req.get("user-agent") ?? undefined,
          traceId: getCurrentTraceContext()?.traceId,
          correlationId: getCurrentTraceContext()?.correlationId,
        },
      },
      data: {
        statusCode: res.statusCode,
        durationMs: Date.now() - started,
        automated: false,
        sharedAppId: getSharedAppForHost(req.hostname)?.id,
      },
      trace: getCurrentTraceContext() ?? { traceId: "unknown" },
    }).catch(() => undefined);
  });
  next();
}