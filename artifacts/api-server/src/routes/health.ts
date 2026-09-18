import { Router, type IRouter, type Request, type Response } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const health = (_req: Request, res: Response): void => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
};

// Respond at both /api and /api/healthz so the platform's liveness probe
// for the registered service path (/api) also returns 200.
router.get("/", health);
router.get("/healthz", health);

export default router;
