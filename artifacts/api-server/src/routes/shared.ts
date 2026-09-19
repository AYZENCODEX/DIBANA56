import { Router } from "express";
import { getSharedAppCatalog, getSharedAppForHost } from "../lib/shared-apps";

const router = Router();

/**
 * Public discovery for the shared deployment. It contains routing metadata
 * only; authentication, authorization, and user data stay on their existing
 * protected routes.
 */
router.get("/shared/apps", (req, res) => {
  const current = getSharedAppForHost(req.hostname);
  res.json({
    api: "shared",
    version: 1,
    currentApp: current?.id ?? null,
    apps: getSharedAppCatalog(),
  });
});

export default router;