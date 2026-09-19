import { AuditSink, EngineError, Scope } from "./common";
import { randomUUID } from "node:crypto";

export type AIMessage = { role: "system" | "user" | "assistant"; content: string };
export type AIRequest = { messages: AIMessage[]; model?: string; temperature?: number; maxTokens?: number; stream?: boolean; scope?: Scope };
export type AIResponse = { provider: string; model: string; content: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }; requestId: string; latencyMs: number };
export type AIChunk = { delta: string; done?: boolean; usage?: AIResponse["usage"] };
export type AIProvider = {
  name: string;
  complete(request: Required<Pick<AIRequest, "messages">> & Omit<AIRequest, "messages">): Promise<Omit<AIResponse, "provider" | "model" | "requestId" | "latencyMs">>;
  stream?(request: Required<Pick<AIRequest, "messages">> & Omit<AIRequest, "messages">): AsyncIterable<AIChunk>;
};

export class AIGatewayEngine {
  private readonly providers = new Map<string, AIProvider>();
  private readonly models = new Map<string, { provider: string; enabled: boolean }>();

  constructor(private readonly audit: AuditSink, private readonly policy?: (request: AIRequest) => Promise<void> | void, private readonly usage?: (response: AIResponse, scope?: Scope) => void) {}

  registerProvider(provider: AIProvider): void { this.providers.set(provider.name, provider); }
  registerModel(model: string, provider: string, enabled = true): void {
    if (!this.providers.has(provider)) throw new EngineError(`Provider not registered: ${provider}`, "AI_PROVIDER_NOT_FOUND", 404);
    this.models.set(model, { provider, enabled });
  }
  listModels(): Array<{ model: string; provider: string; enabled: boolean }> { return [...this.models].map(([model, value]) => ({ model, ...value })); }

  async complete(request: AIRequest, options: { fallbackModels?: string[]; timeoutMs?: number; retries?: number; actorUserId?: number | null } = {}): Promise<AIResponse> {
    await this.policy?.(request);
    const models = [request.model, ...(options.fallbackModels ?? [])].filter((model): model is string => Boolean(model));
    if (models.length === 0) throw new EngineError("No AI model selected", "AI_MODEL_REQUIRED");
    let lastError: unknown;
    for (const model of models) {
      const registration = this.models.get(model);
      const provider = registration && registration.enabled ? this.providers.get(registration.provider) : undefined;
      if (!registration || !provider) { lastError = new EngineError(`AI model unavailable: ${model}`, "AI_MODEL_UNAVAILABLE", 503); continue; }
      for (let attempt = 0; attempt <= (options.retries ?? 1); attempt++) {
        const started = Date.now();
        try {
          const result = await this.withTimeout(provider.complete({ ...request, messages: request.messages, model }), options.timeoutMs ?? 30_000);
          const response = { ...result, provider: provider.name, model, requestId: randomUUID(), latencyMs: Date.now() - started };
          this.usage?.(response, request.scope);
          this.audit.record({ engine: "ai-gateway", action: "ai.completed", actorUserId: options.actorUserId, organizationId: request.scope?.organizationId, subjectId: response.requestId, metadata: { provider: provider.name, model, latencyMs: response.latencyMs, usage: response.usage ?? {} } });
          return response;
        } catch (error) { lastError = error; }
      }
    }
    throw new EngineError(`All AI providers failed: ${lastError instanceof Error ? lastError.message : "unknown error"}`, "AI_ALL_PROVIDERS_FAILED", 503);
  }

  async *stream(request: AIRequest, options: { actorUserId?: number | null } = {}): AsyncGenerator<AIChunk> {
    await this.policy?.({ ...request, stream: true });
    const model = request.model;
    const registration = model ? this.models.get(model) : undefined;
    const provider = registration && registration.enabled ? this.providers.get(registration.provider) : undefined;
    if (!model || !registration || !provider?.stream) throw new EngineError("Streaming model/provider is unavailable", "AI_STREAM_UNAVAILABLE", 503);
    let total = "";
    for await (const chunk of provider.stream({ ...request, messages: request.messages, model, stream: true })) {
      total += chunk.delta;
      yield chunk;
    }
    this.audit.record({ engine: "ai-gateway", action: "ai.stream_completed", actorUserId: options.actorUserId, organizationId: request.scope?.organizationId, subjectId: model, metadata: { model, characters: total.length } });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new EngineError("AI request timed out", "AI_TIMEOUT", 504)), timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }
}