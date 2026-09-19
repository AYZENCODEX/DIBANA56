import { AuditSink, EngineError, clone, emitSubEngineEvent } from "./common";
import { InvalidDefinitionError, validateDefinition } from "../workflow/definition-store";
import type { WorkflowDefinition } from "../workflow/types";

type Draft = { id: string; organizationId?: number; status: "draft" | "published"; definition: WorkflowDefinition; publishedAt?: Date; publishedBy?: number | null };
type DefinitionPersister = (definition: WorkflowDefinition) => Promise<void>;

export class WorkflowDesignerEngine {
  private readonly drafts = new Map<string, Draft>();
  private readonly published = new Map<string, WorkflowDefinition[]>();

  constructor(
    private readonly audit: AuditSink,
    private readonly authorize: (actorUserId: number | null | undefined, action: string, organizationId?: number) => boolean = (actor) => actor != null,
    private readonly persist: DefinitionPersister = async () => {},
  ) {}

  saveDraft(definition: WorkflowDefinition, organizationId?: number, actorUserId?: number | null): Draft {
    if (!this.authorize(actorUserId, "workflow.edit", organizationId)) throw new EngineError("Workflow edit is not authorized", "WORKFLOW_NOT_AUTHORIZED", 403);
    try { validateDefinition(definition); } catch (error) { throw new EngineError(error instanceof InvalidDefinitionError ? error.message : String(error), "WORKFLOW_INVALID"); }
    const draft = { id: `${definition.id}:draft`, organizationId, status: "draft" as const, definition: clone(definition) };
    this.drafts.set(draft.id, draft);
    return clone(draft);
  }

  async publish(workflowId: string, actorUserId?: number | null): Promise<WorkflowDefinition> {
    const draft = this.drafts.get(`${workflowId}:draft`);
    if (!draft) throw new EngineError("Workflow draft not found", "WORKFLOW_DRAFT_NOT_FOUND", 404);
    if (!this.authorize(actorUserId, "workflow.publish", draft.organizationId)) throw new EngineError("Workflow publish is not authorized", "WORKFLOW_NOT_AUTHORIZED", 403);
    const versions = this.published.get(workflowId) ?? [];
    const definition = clone({ ...draft.definition, version: versions.length + 1 });
    validateDefinition(definition);
    await this.persist(definition);
    versions.push(definition); this.published.set(workflowId, versions);
    draft.status = "published"; draft.publishedAt = new Date(); draft.publishedBy = actorUserId;
    this.audit.record({ engine: "workflow-designer", action: "workflow.published", actorUserId, organizationId: draft.organizationId, subjectId: workflowId, metadata: { version: definition.version } });
    emitSubEngineEvent({ type: "subengine.workflow.published", actorUserId, organizationId: draft.organizationId, aggregate: { type: "workflow", id: workflowId }, payload: { workflowId, version: definition.version } });
    return clone(definition);
  }

  get(workflowId: string, version?: number): WorkflowDefinition | undefined {
    const versions = this.published.get(workflowId) ?? [];
    return clone(version ? versions.find((item) => item.version === version) : versions[versions.length - 1]);
  }

  list(): WorkflowDefinition[] { return [...this.published.values()].flat().map(clone); }
}