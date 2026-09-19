import { z } from "zod";
import { AuditSink, EngineError, Scope, clone, scopeKey } from "./common";

type ConfigValue<T> = { value: T; version: number; updatedAt: Date; updatedBy?: number | null };
type ConfigLayer = "global" | "environment" | "organization" | "user";
type SecretReference = { secretRef: string };

export type ConfigDefinition<T> = {
  key: string;
  schema: z.ZodType<T>;
  defaultValue: T;
  secret?: boolean;
  allowedLayers?: ConfigLayer[];
};

export type ConfigHistoryEntry = {
  key: string;
  layer: ConfigLayer;
  scope: Scope;
  version: number;
  value: unknown;
  changedBy?: number | null;
  changedAt: Date;
};

function layerFor(scope: Scope): ConfigLayer {
  if (scope.userId != null) return "user";
  if (scope.organizationId != null) return "organization";
  if (scope.environment) return "environment";
  return "global";
}

export class ConfigurationEngine {
  private readonly definitions = new Map<string, ConfigDefinition<unknown>>();
  private readonly values = new Map<string, ConfigValue<unknown>>();
  private readonly historyEntries: ConfigHistoryEntry[] = [];
  private readonly reloadListeners = new Set<(keys: string[]) => void>();

  constructor(private readonly audit: AuditSink) {}

  register<T>(definition: ConfigDefinition<T>): void {
    if (this.definitions.has(definition.key)) throw new EngineError(`Configuration already registered: ${definition.key}`, "CONFIG_DUPLICATE");
    this.definitions.set(definition.key, definition as ConfigDefinition<unknown>);
  }

  subscribeReload(listener: (keys: string[]) => void): () => void {
    this.reloadListeners.add(listener);
    return () => this.reloadListeners.delete(listener);
  }

  get<T>(key: string, scope: Scope = {}): T {
    const definition = this.getDefinition<T>(key);
    const candidates = [
      { layer: "user" as const, scope: { ...scope, userId: scope.userId } },
      { layer: "organization" as const, scope: { ...scope, userId: null } },
      { layer: "environment" as const, scope: { environment: scope.environment, organizationId: null, userId: null } },
      { layer: "global" as const, scope: { environment: undefined, organizationId: null, userId: null } },
    ];
    for (const candidate of candidates) {
      const stored = this.values.get(this.storageKey(key, candidate.scope));
      if (stored) return clone(stored.value) as T;
    }
    return clone(definition.defaultValue);
  }

  set<T>(key: string, value: T, scope: Scope = {}, actorUserId?: number | null): ConfigValue<T> {
    const definition = this.getDefinition<T>(key);
    if (definition.secret) throw new EngineError(`Secret configuration ${key} must be written as a secret reference`, "CONFIG_SECRET_SEPARATION");
    const layer = layerFor(scope);
    if (definition.allowedLayers && !definition.allowedLayers.includes(layer)) {
      throw new EngineError(`Layer ${layer} is not allowed for ${key}`, "CONFIG_LAYER_FORBIDDEN");
    }
    const parsed = definition.schema.safeParse(value);
    if (!parsed.success) throw new EngineError(`Invalid value for ${key}: ${parsed.error.message}`, "CONFIG_INVALID");
    const storageScope = this.normalizeScope(layer, scope);
    const storageKey = this.storageKey(key, storageScope);
    const version = (this.values.get(storageKey)?.version ?? 0) + 1;
    const stored: ConfigValue<T> = { value: clone(parsed.data), version, updatedAt: new Date(), updatedBy: actorUserId };
    this.values.set(storageKey, stored as ConfigValue<unknown>);
    this.historyEntries.push({ key, layer, scope: storageScope, version, value: clone(parsed.data), changedBy: actorUserId, changedAt: new Date() });
    this.audit.record({ engine: "configuration", action: "config.updated", actorUserId, organizationId: storageScope.organizationId, subjectId: key, metadata: { layer, version } });
    this.notifyReload([key]);
    return clone(stored);
  }

  setSecretReference(key: string, secretRef: string, scope: Scope = {}, actorUserId?: number | null): ConfigValue<SecretReference> {
    const definition = this.getDefinition<unknown>(key);
    if (!definition.secret) throw new EngineError(`${key} is not registered as secret configuration`, "CONFIG_NOT_SECRET");
    if (!secretRef.trim()) throw new EngineError("secretRef is required", "CONFIG_SECRET_REFERENCE_INVALID");
    return this.writeValue(key, { secretRef: secretRef.trim() }, scope, actorUserId);
  }

  getSecretReference(key: string, scope: Scope = {}): string | undefined {
    const value = this.get<SecretReference>(key, scope);
    return value && typeof value === "object" && "secretRef" in value ? value.secretRef : undefined;
  }

  reload(values: Record<string, unknown>, scope: Scope = {}, actorUserId?: number | null): string[] {
    const changed: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      this.set(key, value, scope, actorUserId);
      changed.push(key);
    }
    return changed;
  }

  history(key?: string): ConfigHistoryEntry[] {
    return this.historyEntries.filter((entry) => !key || entry.key === key).map(clone);
  }

  definitionsList(): Array<Pick<ConfigDefinition<unknown>, "key" | "secret" | "allowedLayers">> {
    return [...this.definitions.values()].map(({ key, secret, allowedLayers }) => ({ key, secret, allowedLayers }));
  }

  private getDefinition<T>(key: string): ConfigDefinition<T> {
    const definition = this.definitions.get(key);
    if (!definition) throw new EngineError(`Unknown configuration key: ${key}`, "CONFIG_UNKNOWN", 404);
    return definition as ConfigDefinition<T>;
  }

  private writeValue<T>(key: string, value: T, scope: Scope, actorUserId?: number | null): ConfigValue<T> {
    const layer = layerFor(scope);
    const definition = this.getDefinition<unknown>(key);
    if (definition.allowedLayers && !definition.allowedLayers.includes(layer)) throw new EngineError(`Layer ${layer} is not allowed for ${key}`, "CONFIG_LAYER_FORBIDDEN");
    const storageScope = this.normalizeScope(layer, scope);
    const storageKey = this.storageKey(key, storageScope);
    const version = (this.values.get(storageKey)?.version ?? 0) + 1;
    const stored: ConfigValue<T> = { value: clone(value), version, updatedAt: new Date(), updatedBy: actorUserId };
    this.values.set(storageKey, stored as ConfigValue<unknown>);
    this.historyEntries.push({ key, layer, scope: storageScope, version, value: clone(value), changedBy: actorUserId, changedAt: new Date() });
    this.audit.record({ engine: "configuration", action: "config.updated", actorUserId, organizationId: storageScope.organizationId, subjectId: key, metadata: { layer, version, secret: Boolean(definition.secret) } });
    this.notifyReload([key]);
    return clone(stored);
  }

  private normalizeScope(layer: ConfigLayer, scope: Scope): Scope {
    if (layer === "global") return {};
    if (layer === "environment") return { environment: scope.environment };
    if (layer === "organization") return { environment: scope.environment, organizationId: scope.organizationId };
    return scope;
  }

  private storageKey(key: string, scope: Scope): string {
    return `${key}:${scopeKey(scope)}`;
  }

  private notifyReload(keys: string[]): void {
    for (const listener of this.reloadListeners) listener(keys);
  }
}