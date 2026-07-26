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

/**
 * Config persistence port for user config (§8 habits/commitments/rules). The Api
 * writes/reads config through this, so durable mode can swap the in-memory
 * implementation for a pg-backed one (COD-3) without changing handler logic.
 * Memory/coach/sessions stay on `MemoryStore`/`InMemorySessionRepo` for now.
 */
export interface ConfigRepo {
  createHabit(h: Habit): Promise<Habit>;
  getHabit(id: string): Promise<Habit | null>;
  createCommitment(c: Commitment, habitId: string): Promise<Commitment>;
  getCommitment(id: string): Promise<Commitment | null>;
  createRule(r: Rule): Promise<Rule>;
  getRule(id: string): Promise<Rule | null>;
  setRuleEnabled(id: string, enabled: boolean): Promise<Rule | null>;
}

/** In-memory ConfigRepo — the default; wraps a `MemoryStore` so behaviour is
 * identical to the pre-COD-3 direct-store access. */
export class MemoryConfigRepo implements ConfigRepo {
  constructor(private readonly store: MemoryStore) {}

  async createHabit(h: Habit): Promise<Habit> {
    this.store.habits.set(h.id, h);
    return h;
  }
  async getHabit(id: string): Promise<Habit | null> {
    return this.store.habits.get(id) ?? null;
  }
  async createCommitment(c: Commitment, _habitId: string): Promise<Commitment> {
    this.store.commitments.set(c.id, c);
    return c;
  }
  async getCommitment(id: string): Promise<Commitment | null> {
    return this.store.commitments.get(id) ?? null;
  }
  async createRule(r: Rule): Promise<Rule> {
    this.store.rules.set(r.id, r);
    return r;
  }
  async getRule(id: string): Promise<Rule | null> {
    return this.store.rules.get(id) ?? null;
  }
  async setRuleEnabled(id: string, enabled: boolean): Promise<Rule | null> {
    const r = this.store.rules.get(id);
    if (!r) return null;
    const updated = { ...r, enabled };
    this.store.rules.set(id, updated);
    return updated;
  }
}
