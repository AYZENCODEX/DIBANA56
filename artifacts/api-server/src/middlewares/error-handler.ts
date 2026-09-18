import type { Request, Response, NextFunction } from "express";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";

// Fire-and-forget insert to error_logs so it never blocks response
async function recordError(level: string, message: string, endpoint: string | null, stack?: string): Promise<void> {
  try {
    const { db } = await import("@workspace/db");
    const { errorLogsTable } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    await db.insert(errorLogsTable).values({ level, message, endpoint, stack: stack ?? null });
  } catch {}
}

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (err.httpStatus >= 500) {
      logger.error({ err: err.message, code: err.code, url: req.url }, "AppError 5xx");
      recordError("ERROR", `[${err.code}] ${err.message}`, req.path).catch(() => {});
    } else if (err.httpStatus >= 400) {
      recordError("WARN", `[${err.code}] ${err.message}`, req.path).catch(() => {});
    }
    res.status(err.httpStatus).json(err.toJSON());
    return;
  }

  const e = err as any;
  const msg: string = e?.message ?? "Unknown error";

  if (e?.code === "23505") {
    recordError("WARN", `DB duplicate: ${msg}`, req.path).catch(() => {});
    res.status(409).json({ error: "Duplicate record", code: "DB_DUPLICATE", solution: "The record already exists." });
    return;
  }
  if (e?.code === "23503") {
    recordError("WARN", `DB FK violation: ${msg}`, req.path).catch(() => {});
    res.status(409).json({ error: "Foreign key violation", code: "DB_ERROR", solution: "Referenced record does not exist." });
    return;
  }

  logger.error({ err: msg, url: req.url, method: req.method }, "Unhandled error");
  recordError("ERROR", msg, req.path, e?.stack ?? undefined).catch(() => {});
  res.status(500).json({
    error: "Internal server error",
    code: "INTERNAL",
    solution: "Check server logs. If the issue persists, contact support@ayzen.tech",
    ...(process.env.NODE_ENV === "development" ? { details: msg } : {}),
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: "Endpoint not found",
    code: "NOT_FOUND",
    path: req.path,
    method: req.method,
    solution: "See GET /api/functions for all available endpoints",
  });
}
