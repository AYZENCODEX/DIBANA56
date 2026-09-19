import { AuditSink, EngineError, Scope, clone } from "./common";

export type Relationship = { subject: string; relation: string; resource: string; organizationId: number };
export type PermissionQuery = { subject: string; action: string; resource: string; organizationId: number };

const relationAllows: Record<string, string[]> = {
  owner: ["read", "write", "delete", "admin"],
  editor: ["read", "write"],
  viewer: ["read"],
  member: ["read"],
  delegated: ["read", "write"],
};

export class PermissionGraphEngine {
  private readonly relationships: Relationship[] = [];
  private readonly parents = new Map<string, string>();

  constructor(private readonly audit: AuditSink) {}

  setResourceParent(resource: string, parent: string, organizationId: number, actorUserId?: number | null): void {
    if (!organizationId || !resource || !parent || resource === parent) throw new EngineError("Invalid resource hierarchy", "PERMISSION_HIERARCHY_INVALID");
    this.parents.set(`${organizationId}:${resource}`, parent);
    this.audit.record({ engine: "permission-graph", action: "resource.parent_set", actorUserId, organizationId, subjectId: resource, metadata: { parent } });
  }

  grant(relationship: Relationship, actorUserId?: number | null): void {
    if (!relationship.organizationId || !relationship.subject || !relationship.resource || !relationship.relation) throw new EngineError("Invalid relationship", "PERMISSION_RELATIONSHIP_INVALID");
    const duplicate = this.relationships.find((item) => item.subject === relationship.subject && item.relation === relationship.relation && item.resource === relationship.resource && item.organizationId === relationship.organizationId);
    if (!duplicate) this.relationships.push(clone(relationship));
    this.audit.record({ engine: "permission-graph", action: "relationship.granted", actorUserId, organizationId: relationship.organizationId, subjectId: relationship.resource, metadata: { subject: relationship.subject, relation: relationship.relation } });
  }

  revoke(input: Omit<Relationship, "relation"> & { relation?: string }, actorUserId?: number | null): number {
    const before = this.relationships.length;
    for (let i = this.relationships.length - 1; i >= 0; i--) {
      const item = this.relationships[i]!;
      if (item.subject === input.subject && item.resource === input.resource && item.organizationId === input.organizationId && (!input.relation || item.relation === input.relation)) this.relationships.splice(i, 1);
    }
    const removed = before - this.relationships.length;
    if (removed) this.audit.record({ engine: "permission-graph", action: "relationship.revoked", actorUserId, organizationId: input.organizationId, subjectId: input.resource, metadata: { subject: input.subject, removed } });
    return removed;
  }

  check(query: PermissionQuery): { allowed: boolean; relation?: string; reason: string } {
    if (!query.organizationId) throw new EngineError("organizationId is required", "ORGANIZATION_REQUIRED", 403);
    const subjects = new Set([query.subject]);
    for (const relationship of this.relationships) {
      if (relationship.organizationId === query.organizationId && relationship.subject === query.subject && relationship.relation === "member_of") subjects.add(relationship.resource);
    }
    const resources = new Set([query.resource, `${query.resource}:*`]);
    let parent = this.parents.get(`${query.organizationId}:${query.resource}`);
    while (parent && !resources.has(parent)) { resources.add(parent); parent = this.parents.get(`${query.organizationId}:${parent}`); }
    const candidates = this.relationships.filter((item) => item.organizationId === query.organizationId && subjects.has(item.subject) && resources.has(item.resource));
    const match = candidates.find((item) => (relationAllows[item.relation] ?? []).includes(query.action));
    const result = match ? { allowed: true, relation: match.relation, reason: "relationship_match" } : { allowed: false, reason: "no_relationship" };
    return result;
  }

  effectivePermissions(subject: string, organizationId: number): Array<{ resource: string; relation: string; actions: string[] }> {
    return this.relationships.filter((item) => item.subject === subject && item.organizationId === organizationId).map((item) => ({ resource: item.resource, relation: item.relation, actions: relationAllows[item.relation] ?? [] }));
  }

  list(organizationId?: number): Relationship[] { return this.relationships.filter((item) => organizationId == null || item.organizationId === organizationId).map(clone); }
}