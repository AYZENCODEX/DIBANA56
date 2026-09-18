/**
 * Backward-compat shim: the old Dev-only endpoints (/admin/dev-nav, ...) now
 * forward to the generic /admin/nav/:navType routes with navType fixed to
 * "dev". Kept so any older client build still calling the legacy paths
 * keeps working; new code should call /admin/nav/dev directly.
 */
import { Router } from "express";
import { requireDev } from "../middlewares/auth";
import navRouter from "./nav";

const router = Router();

function rewriteToDevNav(path: string): void {
  // no-op placeholder — routes below are defined explicitly instead of
  // trying to rewrite req.url, to keep behavior obvious and debuggable.
}

router.get("/admin/dev-nav", requireDev, (req, res, next) => {
  req.url = "/admin/nav/dev";
  navRouter(req, res, next);
});

router.get("/admin/dev-nav/by-href", requireDev, (req, res, next) => {
  req.url = `/admin/nav/dev/by-href${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`;
  navRouter(req, res, next);
});

router.post("/admin/dev-nav", requireDev, (req, res, next) => {
  req.url = "/admin/nav/dev";
  navRouter(req, res, next);
});

router.patch("/admin/dev-nav/:id", requireDev, (req, res, next) => {
  req.url = `/admin/nav/dev/${req.params.id}`;
  navRouter(req, res, next);
});

router.delete("/admin/dev-nav/:id", requireDev, (req, res, next) => {
  req.url = `/admin/nav/dev/${req.params.id}`;
  navRouter(req, res, next);
});

export default router;
