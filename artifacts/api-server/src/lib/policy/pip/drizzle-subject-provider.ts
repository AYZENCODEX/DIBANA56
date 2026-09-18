/**
 * lib/policy/pip/drizzle-subject-provider.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * AYZEN Policy & Authorization Mega Engine — Phase 18 (PIP / Attribute
 * Providers).
 *
 * The real `SubjectProvider` (see ./types.ts for the interface this
 * implements). Composes three already-existing, independently-testable
 * steps — none of them rewritten, all of them called exactly as their own
 * phase left them:
 *   1. `subjectFromAuthUser()`      (subject-adapter.ts,          Phase 1B)
 *   2. `withVerificationLevel()`    (verification-level-adapter.ts, Phase 9B)
 *   3. `withAccountState()`         (account-state-adapter.ts,     this phase)
 *
 * This is the only file in this pair that imports `@workspace/db`
 * (transitively, via `DrizzleVerificationLevelProvider`/
 * `DrizzleAccountStateProvider`) — same split every other Drizzle-backed
 * provider in this engine already establishes; deliberately excluded from
 * `lib/policy/index.ts`'s barrel — import it directly where actually
 * needed.
 *
 * Does NOT populate `riskLevel` — see ./types.ts's `SubjectProvider` doc
 * comment for why that stays a separate composition step
 * (`PolicyInformationPoint.resolveSubject()`, policy-information-point.ts)
 * rather than being folded in here.
 *
 * Nothing in the app constructs `DrizzleSubjectProvider` yet — same
 * additive, unwired posture every other Drizzle/DB-backed provider in this
 * engine already has.
 */

import { subjectFromAuthUser, type AuthenticatedUserLike } from "./subject-adapter";
import { withVerificationLevel } from "./verification-level-adapter";
import { DrizzleVerificationLevelProvider } from "./drizzle-verification-level-provider";
import { withAccountState } from "./account-state-adapter";
import { DrizzleAccountStateProvider } from "./drizzle-account-state-provider";
import type { SubjectProvider } from "./types";
import type { Subject } from "../types";

export class DrizzleSubjectProvider implements SubjectProvider {
  private readonly verificationLevelProvider = new DrizzleVerificationLevelProvider();
  private readonly accountStateProvider = new DrizzleAccountStateProvider();

  async getSubject(user: AuthenticatedUserLike | null | undefined): Promise<Subject | null> {
    let subject: Subject | null = subjectFromAuthUser(user);
    if (!subject) return null;

    subject = await withVerificationLevel(subject, this.verificationLevelProvider);
    subject = await withAccountState(subject, this.accountStateProvider);

    return subject;
  }
}
