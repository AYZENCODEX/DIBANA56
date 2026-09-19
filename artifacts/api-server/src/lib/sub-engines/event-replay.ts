import { randomUUID } from "node:crypto";
import { AuditSink, EngineError, clone } from "./common";
import type { EventEnvelope, EventHandler } from "../event-bus/types";

type ReplayInput = {
  from?: Date; to?: Date; eventTypes?: string[]; organizationId?: number;
  consumers?: string[]; dryRun?: boolean; batchSize?: number; ratePerSecond?: number; actorUserId?: number | null;
};
type ReplayRun = { id: string; status: "running" | "completed" | "cancelled" | "failed"; selected: number; processed: number; failed: number; dryRun: boolean; startedAt: Date; completedAt?: Date };

export class EventReplayEngine {
  private readonly events: EventEnvelope[] = [];
  private readonly consumers = new Map<string, { eventTypes: Set<string>; handler: EventHandler }>();
  private readonly runs = new Map<string, ReplayRun>();
  private readonly cancelled = new Set<string>();
  private readonly processed = new Set<string>();

  constructor(private readonly audit: AuditSink, private readonly authorize: (actorUserId: number | null | undefined, action: string) => boolean = (actor) => actor != null) {}

  append<T>(event: EventEnvelope<T>): void { this.events.push(clone(event)); }

  registerConsumer(name: string, eventTypes: string[], handler: EventHandler): void {
    if (!name || eventTypes.length === 0) throw new EngineError("Replay consumer name and event types are required", "REPLAY_CONSUMER_INVALID");
    this.consumers.set(name, { eventTypes: new Set(eventTypes), handler });
  }

  async replay(input: ReplayInput): Promise<ReplayRun> {
    if (!this.authorize(input.actorUserId, "event.replay")) throw new EngineError("Event replay is not authorized", "REPLAY_NOT_AUTHORIZED", 403);
    const selected = this.events.filter((event) =>
      (!input.from || new Date(event.occurredAt) >= input.from) &&
      (!input.to || new Date(event.occurredAt) <= input.to) &&
      (!input.eventTypes?.length || input.eventTypes.includes(event.type)) &&
      (!input.organizationId || event.actor?.organizationId === input.organizationId),
    );
    const run: ReplayRun = { id: randomUUID(), status: "running", selected: selected.length, processed: 0, failed: 0, dryRun: Boolean(input.dryRun), startedAt: new Date() };
    this.runs.set(run.id, run);
    const consumers = [...this.consumers.entries()].filter(([name]) => !input.consumers?.length || input.consumers.includes(name));
    const delay = input.ratePerSecond && input.ratePerSecond > 0 ? Math.ceil(1000 / input.ratePerSecond) : 0;
    try {
      for (let offset = 0; offset < selected.length; offset += Math.max(1, input.batchSize ?? 50)) {
        for (const event of selected.slice(offset, offset + Math.max(1, input.batchSize ?? 50))) {
          if (this.cancelled.has(run.id)) { run.status = "cancelled"; run.completedAt = new Date(); return clone(run); }
          for (const [name, consumer] of consumers) {
            if (!consumer.eventTypes.has(event.type)) continue;
            const key = `${run.id}:${name}:${event.id}`;
            if (this.processed.has(key) || run.dryRun) continue;
            try { await consumer.handler(clone(event)); this.processed.add(key); run.processed++; }
            catch { run.failed++; }
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
      run.status = run.failed ? "failed" : "completed"; run.completedAt = new Date();
      this.audit.record({ engine: "event-replay", action: "replay.completed", actorUserId: input.actorUserId, organizationId: input.organizationId, subjectId: run.id, metadata: { selected: run.selected, processed: run.processed, failed: run.failed, dryRun: run.dryRun } });
      return clone(run);
    } catch (error) {
      run.status = "failed"; run.completedAt = new Date();
      throw error;
    }
  }

  cancel(runId: string, actorUserId?: number | null): void {
    if (!this.runs.has(runId)) throw new EngineError("Replay run not found", "REPLAY_RUN_NOT_FOUND", 404);
    if (!this.authorize(actorUserId, "event.replay.cancel")) throw new EngineError("Replay cancellation is not authorized", "REPLAY_NOT_AUTHORIZED", 403);
    this.cancelled.add(runId);
    this.audit.record({ engine: "event-replay", action: "replay.cancel_requested", actorUserId, subjectId: runId, metadata: {} });
  }

  get(runId: string): ReplayRun | undefined { return clone(this.runs.get(runId)); }
}