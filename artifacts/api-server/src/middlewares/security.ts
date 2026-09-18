/**
 * middlewares/security.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Central "security system" for the AYZEN API.
 *
 * This file is intentionally self-contained so the whole security posture of
 * the API can be reasoned about (and audited) from one place:
 *
 *   1. Security headers        (helmet)
 *   2. Locked-down CORS         (allow-list via ALLOWED_ORIGINS env var)
 *   3. Rate limiting            (global + per-endpoint-class limiters)
 *   4. Body size limits         (prevents huge-payload DoS)
 *   5. Parameter-pollution guard(prevents ?id=1&id=2 style bypasses)
 *   6. Basic input sanitisation (strips prototype-pollution keys)
 *
 * HOW TO TUNE
 *  - Set ALLOWED_ORIGINS="https://ayzen.tech,https://app.ayzen.tech" in prod.
 *    If unset, falls back to "*" ONLY when NODE_ENV !== "production", and
 *    logs a loud warning in production so nobody ships an open CORS policy
 *    by accident.
 *  - Rate limit numbers below are conservative defaults for a Telegram-bot /
 *    Web3 community platform. Adjust via the *_MAX / *_WINDOW_MS env vars
 *    without touching code.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import rateLimit, { type Options } from "express-rate-limit";
import { logger } from "../lib/logger";

// ─── Env helpers ───────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const isProd = process.env.NODE_ENV === "production";

// ─── 1. Helmet (security headers) ───────────────────────────────────────────
// CSP is left in report-only-friendly "off" state for the API itself since
// this server also serves a SPA build (see app.ts) whose asset origins vary
// by deploy target (Replit / Render). Turn on a strict CSP once the final
// asset host list is fixed. Everything else (HSTS, X-Frame-Options,
// X-Content-Type-Options, noSniff, etc.) is on.
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

// ─── 2. CORS allow-list ──────────────────────────────────────────────────────

function parseAllowedOrigins(): string[] | null {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const allowedOrigins = parseAllowedOrigins();

if (!allowedOrigins && isProd) {
  // eslint-disable-next-line no-console
  logger.warn(
    "[security] ALLOWED_ORIGINS is not set in production — CORS will reject " +
      "all cross-origin browser requests by default. Set ALLOWED_ORIGINS to a " +
      "comma-separated list of trusted origins (e.g. https://ayzen.tech).",
  );
}

const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header = same-origin, curl, server-to-server, mobile app, bot webhook → allow.
    if (!origin) return callback(null, true);

    if (allowedOrigins) {
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    }

    // No allow-list configured: permissive only outside production so local
    // dev / preview environments keep working without extra setup.
    if (!isProd) return callback(null, true);

    return callback(new Error("CORS not configured — set ALLOWED_ORIGINS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  maxAge: 600,
};

export const corsMiddleware: RequestHandler = cors(corsOptions);

// ─── 3. Rate limiters ────────────────────────────────────────────────────────
// In-memory store — fine for a single Node instance (current deploy target).
// If AYZEN ever runs multiple API instances behind a load balancer, swap the
// `store` option below for a shared store (e.g. rate-limit-redis) so limits
// are enforced across instances instead of per-process.

function makeLimiter(opts: Partial<Options> & { windowMs: number; limit: number; message: string }) {
  const { message, ...rest } = opts;
  return rateLimit({
    standardHeaders: true, // RateLimit-* headers
    legacyHeaders: false,
    message: { error: message, code: "RATE_LIMITED" },
    // Trust the app's `trust proxy` setting (see app.ts) for correct client IPs
    // behind Render/Replit's reverse proxy instead of rate-limiting the proxy itself.
    handler(req: Request, res: Response) {
      logger.warn({ ip: req.ip, path: req.path }, "[security] rate limit exceeded");
      res.status(429).json({ error: message, code: "RATE_LIMITED" });
    },
    ...rest,
  });
}

/** Applied to the whole /api surface. Generous — this just stops floods/bots. */
export const globalLimiter = makeLimiter({
  windowMs: envInt("RATE_LIMIT_GLOBAL_WINDOW_MS", 15 * 60 * 1000), // 15 min
  limit: envInt("RATE_LIMIT_GLOBAL_MAX", 600), // ~40 req/min average per IP
  message: "Too many requests. Please slow down and try again shortly.",
});

/** Login / register / OTP / password-reset — the endpoints attackers brute-force. */
export const authLimiter = makeLimiter({
  windowMs: envInt("RATE_LIMIT_AUTH_WINDOW_MS", 15 * 60 * 1000), // 15 min
  limit: envInt("RATE_LIMIT_AUTH_MAX", 10),
  message: "Too many authentication attempts. Please wait 15 minutes and try again.",
});

/** OTP / email-code senders — expensive (sends an email) and enumerable. */
export const otpLimiter = makeLimiter({
  windowMs: envInt("RATE_LIMIT_OTP_WINDOW_MS", 10 * 60 * 1000), // 10 min
  limit: envInt("RATE_LIMIT_OTP_MAX", 5),
  message: "Too many verification codes requested. Please wait before requesting another.",
});

/** Slow, expensive, or sensitive write actions (bulk ops, broadcasts, transfers). */
export const sensitiveWriteLimiter = makeLimiter({
  windowMs: envInt("RATE_LIMIT_WRITE_WINDOW_MS", 5 * 60 * 1000), // 5 min
  limit: envInt("RATE_LIMIT_WRITE_MAX", 30),
  message: "Too many requests to this action. Please slow down.",
});

/**
 * OIDC Roadmap — Season 4, Phase 8c: `POST /oidc/register`'s own dedicated
 * per-IP cap ("একই IP থেকে ঘণ্টায় সর্বোচ্চ N-টা registration"). A 1-hour
 * window, deliberately longer and tighter than `authLimiter`'s 15-minute
 * one — registering a NEW OIDC client is something a legitimate caller
 * does rarely (once per integration, not once per login attempt), so a
 * low hourly cap does not get in a real integrator's way while still
 * making it expensive to flood `oidc_clients` with junk rows (each one a
 * real DB row plus a `'pending'` entry an eventual Phase 9d admin queue
 * would have to wade through). This is `routes/oidc-register.ts`'s own
 * replacement for the generic `authLimiter` baseline Phase 8a used before
 * this dedicated limiter existed — same `makeLimiter()` factory, no new
 * rate-limiting mechanism invented, per that phase's own roadmap text
 * ("এই codebase-এর existing rate-limit middleware convention
 * পুনর্ব্যবহার, নতুন কিছু আবিষ্কার না").
 */
export const oidcClientRegistrationLimiter = makeLimiter({
  windowMs: envInt("RATE_LIMIT_OIDC_REGISTER_WINDOW_MS", 60 * 60 * 1000), // 1 hour
  limit: envInt("RATE_LIMIT_OIDC_REGISTER_MAX", 5),
  message: "Too many client registration attempts from this network. Please try again later.",
});

// ─── 4. Body-size guard ──────────────────────────────────────────────────────
// express.json()/urlencoded() are configured with explicit limits in app.ts.
// This constant is exported so app.ts and any file-upload-ish route can reuse
// the same number instead of hand-picking one.
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "1mb";

// ─── 5. Basic HTTP Parameter Pollution guard ────────────────────────────────
// Express 5 already de-duplicates query params less aggressively than v4, and
// this app is JSON-first, but query-string duplication (`?id=1&id=2`) can
// still confuse handlers that do `req.query.id as string`. This normalises
// duplicate query keys down to their *last* value, matching what most route
// handlers already assume.
export function dedupeQueryParams(req: Request, _res: Response, next: NextFunction): void {
  for (const key of Object.keys(req.query)) {
    const val = (req.query as Record<string, unknown>)[key];
    if (Array.isArray(val)) {
      (req.query as Record<string, unknown>)[key] = val[val.length - 1];
    }
  }
  next();
}

// ─── 6. Prototype-pollution / dangerous-key sanitisation ───────────────────
// Strips __proto__ / constructor / prototype keys from request bodies before
// they reach route handlers or the ORM layer.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stripDangerousKeys(obj: unknown, depth = 0): unknown {
  if (depth > 8 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
    return obj;
  }
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete (obj as Record<string, unknown>)[key];
      continue;
    }
    stripDangerousKeys((obj as Record<string, unknown>)[key], depth + 1);
  }
  return obj;
}

export function sanitizeBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body && typeof req.body === "object") stripDangerousKeys(req.body);
  next();
}
