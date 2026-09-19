import { AbuseDetectionEngine, IdentityTrustEngine, SessionSecurityEngine, ThreatIntelligenceEngine } from "./engines";
import { ApiDefenseEngine, DataSecurityEngine, RiskAnomalyEngine, SecretsSecurityEngine } from "./extended-engines";
import { SioraOperations, sioraOperations } from "./operations";
import { sioraRuntime } from "./runtime";

export * from "./contracts";
export * from "./engines";
export * from "./runtime";
export * from "./data-security";
export * from "./extended-engines";
export * from "./operations";

export const threatIntelligenceEngine = new ThreatIntelligenceEngine();
export const identityTrustEngine = new IdentityTrustEngine();
export const sessionSecurityEngine = new SessionSecurityEngine();
export const abuseDetectionEngine = new AbuseDetectionEngine();
export const riskAnomalyEngine = new RiskAnomalyEngine();
export const dataSecurityEngine = new DataSecurityEngine();
export const secretsSecurityEngine = new SecretsSecurityEngine();
export const apiDefenseEngine = new ApiDefenseEngine();

sioraRuntime.register(threatIntelligenceEngine);
sioraRuntime.register(identityTrustEngine);
sioraRuntime.register(sessionSecurityEngine);
sioraRuntime.register(abuseDetectionEngine);
sioraRuntime.register(riskAnomalyEngine);
sioraRuntime.register(dataSecurityEngine);
sioraRuntime.register(secretsSecurityEngine);
sioraRuntime.register(apiDefenseEngine);

// S9 starts with a small, explicit catalog. Teams can extend it through the
// admin route; no global automatic blocking is enabled by registration alone.
apiDefenseEngine.registerEndpoint("/api/auth/*", { sensitivity: "high", write: true, abuseCost: 25, authRequired: false });
apiDefenseEngine.registerEndpoint("/api/payments/*", { sensitivity: "critical", write: true, abuseCost: 35, authRequired: true });
apiDefenseEngine.registerEndpoint("/api/vault/*", { sensitivity: "high", write: true, abuseCost: 25, authRequired: true });
apiDefenseEngine.registerEndpoint("/api/tasks/*", { sensitivity: "medium", write: true, abuseCost: 15, authRequired: true });

// Kept as a named export so controlled response actions can be wired to the
// existing session/policy systems without SIORA inventing a second authority.
export { SioraOperations, sioraOperations };