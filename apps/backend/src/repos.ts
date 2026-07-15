import type {
  Habit,
  Rule,
  Commitment,
  MemoryItem,
  InterventionSession,
  Intervention,
  CoachProfile,
} from "@pa/shared-types";
import type { SessionRepo } from "@pa/intervention-service";

/**
 * In-memory data layer (spec §23 services back this). These implement the same
 * shapes as schema.sql so the API + orchestration are testable without Postgres.
 * The production backend swaps these for pg-backed repos with identical methods.
 */

export class MemoryStore {
  habits = new Map<string, Habit>();
  commitments = new Map<string, Commitment>();
  rules = new Map<string, Rule>();
  memory = new Map<string, MemoryItem>();
  coaches = new Map<string, CoachProfile>(); // keyed by userId
}

/** SessionRepo (port from @pa/intervention-service) backed by memory. */
export class InMemorySessionRepo implements SessionRepo {
  private sessions = new Map<string, InterventionSession>();
  private interventions: Intervention[] = [];

  private key(ruleId: string, date: string) {
    return `${ruleId}:${date}`;
  }

  async find(ruleId: string, date: string): Promise<InterventionSession | null> {
    return this.sessions.get(this.key(ruleId, date)) ?? null;
  }

  async save(session: InterventionSession): Promise<void> {
    this.sessions.set(this.key(session.ruleId, session.date), session);
  }

  async countInterventionsToday(ruleId: string, date: string): Promise<number> {
    const s = this.sessions.get(this.key(ruleId, date));
    if (!s) return 0;
    return this.interventions.filter((i) => i.sessionId === s.id).length;
  }

  async appendIntervention(intervention: Intervention): Promise<void> {
    this.interventions.push(intervention);
  }

  // Test/read helpers (not part of the port).
  allInterventions(): Intervention[] {
    return [...this.interventions];
  }
}
