import { z } from "zod";
import { MemoryAuditSink } from "./common";
import { ConfigurationEngine } from "./configuration";
import { FeatureFlagEngine } from "./feature-flags";
import { QueueEngine } from "./queue";
import { RateLimitEngine } from "./rate-limit";
import { CacheEngine } from "./cache";
import { AIGatewayEngine } from "./ai-gateway";
import { PermissionGraphEngine } from "./permission-graph";
import { RulesEngine } from "./rules";

export * from "./common";
export * from "./configuration";
export * from "./feature-flags";
export * from "./queue";
export * from "./rate-limit";
export * from "./cache";
export * from "./ai-gateway";
export * from "./permission-graph";
export * from "./rules";

export const subEngineAudit = new MemoryAuditSink();
export const configurationEngine = new ConfigurationEngine(subEngineAudit);
export const featureFlagEngine = new FeatureFlagEngine(subEngineAudit);
export const queueEngine = new QueueEngine(subEngineAudit);
export const rateLimitEngine = new RateLimitEngine(subEngineAudit);
export const cacheEngine = new CacheEngine(subEngineAudit);
export const aiGatewayEngine = new AIGatewayEngine(subEngineAudit);
export const permissionGraphEngine = new PermissionGraphEngine(subEngineAudit);
export const rulesEngine = new RulesEngine(subEngineAudit);

configurationEngine.register({ key: "ai.default_model", schema: z.string().min(1), defaultValue: "llama-3.3-70b-versatile", allowedLayers: ["global", "environment", "organization"] });
configurationEngine.register({ key: "queue.default_max_attempts", schema: z.number().int().min(1).max(20), defaultValue: 3, allowedLayers: ["global", "environment"] });
configurationEngine.register({ key: "cache.default_ttl_ms", schema: z.number().int().positive(), defaultValue: 60_000, allowedLayers: ["global", "environment", "organization"] });