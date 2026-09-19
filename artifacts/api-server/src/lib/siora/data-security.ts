import type { SioraContext, SioraSignal } from "./contracts";
import { sanitizeRecord } from "./contracts";

export type SioraDataClass = "public" | "internal" | "sensitive" | "highly_sensitive" | "secret";

const sensitive = /(email|phone|address|ip|useragent|user_agent|device|session|identity|payment|wallet)/i;
const secret = /(password|passphrase|secret|token|api[_-]?key|private[_-]?key|cookie|authorization|credential)/i;

export function classifyField(name: string): SioraDataClass {
  if (secret.test(name)) return "secret";
  if (sensitive.test(name)) return name.toLowerCase().includes("payment") || name.toLowerCase().includes("wallet") ? "highly_sensitive" : "sensitive";
  return "internal";
}

export function redactSioraData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSioraData);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = classifyField(key) === "secret" ? "[REDACTED]" : redactSioraData(item);
  }
  return output;
}

export function dataSecuritySignal(context: SioraContext, data: Record<string, unknown>, emit: (signal: Omit<SioraSignal, "createdAt">) => SioraSignal): SioraSignal | null {
  const serialized = JSON.stringify({ context, data });
  if (!serialized || !Object.keys(data).some((key) => classifyField(key) === "secret")) return null;
  return emit({
    engine: "data-security",
    code: "SENSITIVE_DATA_REDACTED",
    severity: "high",
    confidence: "high",
    score: 80,
    reason: "Security telemetry contained a secret-like field and was redacted",
    evidence: { fields: Object.keys(data).filter((key) => classifyField(key) === "secret") },
  });
}

export { sanitizeRecord };