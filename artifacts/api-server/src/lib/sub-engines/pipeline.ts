import { randomUUID } from "node:crypto";
import { AuditSink, EngineError, clone } from "./common";

export type PipelineStage = { id: string; run(input: unknown, context: { runId: string; stageId: string }): Promise<unknown> };
export type PipelineDefinition = { id: string; version: number; stages: PipelineStage[]; organizationId?: number; enabled: boolean };
export type PipelineRun = { id: string; pipelineId: string; version: number; status: "running" | "completed" | "failed"; checkpoint: number; output?: unknown; error?: string; startedAt: Date; completedAt?: Date; lineage: string[] };

export class DataPipelineEngine {
  private readonly definitions = new Map<string, PipelineDefinition>();
  private readonly runs = new Map<string, PipelineRun>();

  constructor(private readonly audit: AuditSink, private readonly govern: (organizationId: number | undefined, value: unknown) => void = () => {}) {}

  register(definition: PipelineDefinition, actorUserId?: number | null): PipelineDefinition {
    if (!definition.id || !definition.stages.length || new Set(definition.stages.map((stage) => stage.id)).size !== definition.stages.length) throw new EngineError("Pipeline must have unique non-empty stages", "PIPELINE_DEFINITION_INVALID");
    this.definitions.set(definition.id, clone(definition));
    this.audit.record({ engine: "data-pipeline", action: "pipeline.registered", actorUserId, organizationId: definition.organizationId, subjectId: definition.id, metadata: { version: definition.version, stages: definition.stages.length } });
    return clone(definition);
  }

  async start(pipelineId: string, input: unknown, actorUserId?: number | null): Promise<PipelineRun> {
    const definition = this.definitions.get(pipelineId);
    if (!definition || !definition.enabled) throw new EngineError("Pipeline is unavailable", "PIPELINE_NOT_FOUND", 404);
    const run: PipelineRun = { id: randomUUID(), pipelineId, version: definition.version, status: "running", checkpoint: 0, startedAt: new Date(), lineage: [] };
    this.runs.set(run.id, run);
    return this.execute(run, definition, input, actorUserId);
  }

  async resume(runId: string, input: unknown, actorUserId?: number | null): Promise<PipelineRun> {
    const run = this.runs.get(runId);
    if (!run) throw new EngineError("Pipeline run not found", "PIPELINE_RUN_NOT_FOUND", 404);
    if (run.status === "completed") return clone(run);
    const definition = this.definitions.get(run.pipelineId);
    if (!definition) throw new EngineError("Pipeline definition is unavailable", "PIPELINE_NOT_FOUND", 404);
    return this.execute(run, definition, input, actorUserId);
  }

  get(runId: string): PipelineRun | undefined { return clone(this.runs.get(runId)); }

  private async execute(run: PipelineRun, definition: PipelineDefinition, initial: unknown, actorUserId?: number | null): Promise<PipelineRun> {
    let value = initial;
    try {
      for (let index = 0; index < definition.stages.length; index++) {
        if (index < run.checkpoint) continue;
        const stage = definition.stages[index]!;
        this.govern(definition.organizationId, value);
        value = await stage.run(value, { runId: run.id, stageId: stage.id });
        run.checkpoint = index + 1; run.lineage.push(stage.id);
      }
      run.output = clone(value); run.status = "completed"; run.completedAt = new Date();
      this.audit.record({ engine: "data-pipeline", action: "pipeline.completed", actorUserId, organizationId: definition.organizationId, subjectId: run.id, metadata: { checkpoint: run.checkpoint, lineage: run.lineage } });
    } catch (error) {
      run.status = "failed"; run.error = error instanceof Error ? error.message : String(error);
      this.audit.record({ engine: "data-pipeline", action: "pipeline.failed", actorUserId, organizationId: definition.organizationId, subjectId: run.id, metadata: { checkpoint: run.checkpoint, error: run.error } });
    }
    return clone(run);
  }
}