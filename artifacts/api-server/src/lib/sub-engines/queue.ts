import { randomUUID } from "node:crypto";
import { AuditSink, EngineError, nowMs, clone } from "./common";

export type JobState = "queued" | "leased" | "completed" | "failed" | "dead-letter";
export type QueueJob<T = unknown> = {
  id: string; queue: string; payload: T; priority: number; state: JobState;
  attempts: number; maxAttempts: number; availableAt: number; leaseUntil?: number;
  leasedBy?: string; idempotencyKey?: string; lastError?: string; createdAt: Date; updatedAt: Date;
};
export type QueueConfig = { maxConcurrency: number };

export class QueueEngine {
  private readonly jobs = new Map<string, QueueJob>();
  private readonly idempotency = new Map<string, string>();
  private readonly configs = new Map<string, QueueConfig>();

  constructor(private readonly audit: AuditSink) {}

  configure(queue: string, config: QueueConfig, actorUserId?: number | null): void {
    if (!queue || !Number.isInteger(config.maxConcurrency) || config.maxConcurrency < 1) throw new EngineError("maxConcurrency must be a positive integer", "QUEUE_CONCURRENCY_INVALID");
    this.configs.set(queue, { ...config });
    this.audit.record({ engine: "queue", action: "queue.configured", actorUserId, subjectId: queue, metadata: { maxConcurrency: config.maxConcurrency } });
  }

  enqueue<T>(input: { queue: string; payload: T; priority?: number; delayMs?: number; maxAttempts?: number; idempotencyKey?: string }, actorUserId?: number | null): QueueJob<T> {
    if (!input.queue) throw new EngineError("queue is required", "QUEUE_INVALID");
    const idempotencyKey = input.idempotencyKey ? `${input.queue}:${input.idempotencyKey}` : undefined;
    const existingId = idempotencyKey ? this.idempotency.get(idempotencyKey) : undefined;
    if (existingId) return clone(this.jobs.get(existingId)) as QueueJob<T>;
    const now = new Date();
    const job: QueueJob<T> = {
      id: randomUUID(), queue: input.queue, payload: clone(input.payload), priority: input.priority ?? 0,
      state: "queued", attempts: 0, maxAttempts: Math.max(1, input.maxAttempts ?? 3),
      availableAt: nowMs() + Math.max(0, input.delayMs ?? 0), idempotencyKey, createdAt: now, updatedAt: now,
    };
    this.jobs.set(job.id, job);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, job.id);
    this.audit.record({ engine: "queue", action: "job.enqueued", actorUserId, subjectId: job.id, metadata: { queue: job.queue } });
    return clone(job);
  }

  claim(queue: string, workerId: string, leaseMs = 30_000): QueueJob | undefined {
    const now = nowMs();
    const active = [...this.jobs.values()].filter((job) => job.queue === queue && job.state === "leased" && (job.leaseUntil ?? 0) > now).length;
    if (active >= (this.configs.get(queue)?.maxConcurrency ?? Number.POSITIVE_INFINITY)) return undefined;
    const eligible = [...this.jobs.values()]
      .filter((job) => job.queue === queue && ((job.state === "queued" && job.availableAt <= now) || (job.state === "leased" && (job.leaseUntil ?? 0) <= now)))
      .sort((a, b) => b.priority - a.priority || a.createdAt.getTime() - b.createdAt.getTime());
    const job = eligible[0];
    if (!job) return undefined;
    job.state = "leased"; job.leasedBy = workerId; job.leaseUntil = now + leaseMs; job.attempts += 1; job.updatedAt = new Date();
    return clone(job);
  }

  heartbeat(jobId: string, workerId: string, leaseMs = 30_000): QueueJob {
    const job = this.getMutable(jobId);
    if (job.state !== "leased" || job.leasedBy !== workerId) throw new EngineError("Job lease is not owned by this worker", "QUEUE_LEASE_INVALID", 409);
    job.leaseUntil = nowMs() + leaseMs; job.updatedAt = new Date();
    return clone(job);
  }

  complete(jobId: string, workerId: string): QueueJob {
    const job = this.getMutable(jobId);
    if (job.state !== "leased" || job.leasedBy !== workerId) throw new EngineError("Job lease is not owned by this worker", "QUEUE_LEASE_INVALID", 409);
    job.state = "completed"; job.leaseUntil = undefined; job.updatedAt = new Date();
    this.audit.record({ engine: "queue", action: "job.completed", subjectId: job.id, metadata: { queue: job.queue, attempts: job.attempts } });
    return clone(job);
  }

  fail(jobId: string, workerId: string, error: string, retryDelayMs = 1_000): QueueJob {
    const job = this.getMutable(jobId);
    if (job.state !== "leased" || job.leasedBy !== workerId) throw new EngineError("Job lease is not owned by this worker", "QUEUE_LEASE_INVALID", 409);
    job.lastError = error; job.leasedBy = undefined; job.leaseUntil = undefined; job.updatedAt = new Date();
    if (job.attempts < job.maxAttempts) { job.state = "queued"; job.availableAt = nowMs() + Math.max(0, retryDelayMs) * 2 ** (job.attempts - 1); }
    else { job.state = "dead-letter"; }
    this.audit.record({ engine: "queue", action: job.state === "dead-letter" ? "job.dead_lettered" : "job.retry_scheduled", subjectId: job.id, metadata: { error, attempts: job.attempts } });
    return clone(job);
  }

  get(jobId: string): QueueJob | undefined { return clone(this.jobs.get(jobId)); }
  metrics(queue?: string): Record<string, number> {
    const jobs = [...this.jobs.values()].filter((job) => !queue || job.queue === queue);
    return jobs.reduce<Record<string, number>>((out, job) => { out[job.state] = (out[job.state] ?? 0) + 1; return out; }, {});
  }

  config(queue: string): QueueConfig { return { maxConcurrency: this.configs.get(queue)?.maxConcurrency ?? Number.POSITIVE_INFINITY }; }

  private getMutable(jobId: string): QueueJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new EngineError("Job not found", "QUEUE_JOB_NOT_FOUND", 404);
    return job;
  }
}